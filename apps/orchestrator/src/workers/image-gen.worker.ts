/**
 * Image gen worker — generates images for scenes.
 *
 * Two modes controlled by `purpose`:
 *  A. **scene-image** (default): static image for "image" scenes → Ken Burns animation at compose time.
 *  B. **runway-frame**: generates a frame/keyframe → chains to runway-clip worker for image→video.
 *
 * Flow:
 *  1. Generate image via ImageGenClient
 *  2. Download image → upload to MinIO
 *  3. Update Scene record (imageUrl/frameUrl, status, costUsd)
 *  4. Create Generation record for cost audit
 *  5. Deduct credits
 *  6. If purpose=runway-frame → chain to runway-clip queue
 *     If purpose=scene-image → notify pipeline-state
 */
import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type ImageGenJobPayload, type PipelineStateJobPayload, type RunwayClipJobPayload } from '@kmmzavod/queue';
import { logger } from '../logger';
import { StoragePaths } from '@kmmzavod/storage';
import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import { MAX_DOWNLOAD_BYTES, type ImageGenClient } from '../clients/image-gen.client';
import type { IStorageClient } from '@kmmzavod/storage';
import { imageGenCostUsd, creditsFromUsd } from '../lib/costs';
import { chargeCredits } from '../lib/credits';

interface Deps {
  db:                 PrismaClient;
  imageGen:           ImageGenClient;
  storage:            IStorageClient;
  pipelineStateQueue: Queue<PipelineStateJobPayload>;
  runwayQueue:        Queue<RunwayClipJobPayload>;
  connection:         ConnectionOptions;
  provider:           string;
}

export function createImageGenWorker(deps: Deps) {
  // deps.provider is the configured (primary) provider; billing uses the one that actually
  // produced the image (result.provider — may be the Gemini fallback).
  const { db, imageGen, storage, pipelineStateQueue, runwayQueue, connection } = deps;

  return new Worker<ImageGenJobPayload>(
    QUEUES['image-gen'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, prompt, referenceImageKeys, purpose, clipDurationSec } = job.data;
      const isFrame = purpose === 'runway-frame';
      const log     = logger.child({ jobId, sceneId, worker: 'image-gen', purpose: purpose ?? 'scene-image' });
      const startMs = Date.now();

      // For clip scenes, b_roll_prompt is encoded as "<IMAGE_PROMPT> ||| <MOTION_PROMPT>".
      // Use only the IMAGE_PROMPT part for image generation.
      const SEPARATOR = ' ||| ';
      const imagePrompt = prompt.includes(SEPARATOR)
        ? prompt.split(SEPARATOR)[0].trim()
        : prompt;
      const motionPrompt = prompt.includes(SEPARATOR)
        ? prompt.split(SEPARATOR)[1]?.trim() ?? prompt
        : prompt;

      log.info('Начало генерации изображения');

      // Don't spend money on a job that was already failed/cancelled (e.g. a sibling scene
      // failed, or the user cancelled) while this task waited in the queue.
      const isJobDead = async (): Promise<boolean> => {
        const parent = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
        return !parent || parent.status === 'failed' || parent.status === 'cancelled';
      };
      if (await isJobDead()) {
        log.info('Image-gen: родительская задача failed/cancelled/удалена — пропускаем без генерации и списания');
        return;
      }

      // ─── 0. IDEMPOTENCY CHECK ─────────────────────────────────────────────
      // Skip image generation if asset already exists in MinIO from a previous run.
      // For runway-frame: if frameUrl exists, skip image-gen AND chain to runway-clip directly
      // (unless clip already exists — then we're fully done with this scene).
      const existingSceneAssets = await db.scene.findUnique({
        where:  { id: sceneId },
        select: { imageUrl: true, imageDone: true, frameUrl: true, clipUrl: true, clipDone: true },
      });

      if (isFrame) {
        if (existingSceneAssets?.clipUrl && existingSceneAssets.clipDone) {
          // Clip already exists → entire scene is done, notify pipeline-state for the clip stage
          log.info({ existingClipUrl: existingSceneAssets.clipUrl }, 'Image-gen: clip already complete — skipping frame+runway chain');
          await pipelineStateQueue.add(
            `state-${sceneId}`,
            { jobId, sceneId, tenantId, completedStage: 'clip' } satisfies PipelineStateJobPayload,
            { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state-${sceneId}-clip` },
          );
          return;
        }
        if (existingSceneAssets?.frameUrl) {
          // Frame exists, clip missing → skip image-gen, chain directly to runway-clip
          log.info({ existingFrameUrl: existingSceneAssets.frameUrl }, 'Image-gen: frame already exists — chaining to runway-clip');
          const presignedUrl = await storage.presignedUrl(existingSceneAssets.frameUrl, 3600);
          await runwayQueue.add(
            `runway:${sceneId}`,
            {
              jobId, sceneId, tenantId,
              prompt: motionPrompt,
              durationSec: clipDurationSec ?? 5,
              referenceImageUrl: presignedUrl,
            } satisfies RunwayClipJobPayload,
            { ...QUEUES['runway-clip'].defaultJobOptions, jobId: `runway-${sceneId}` },
          );
          return;
        }
      } else {
        if (existingSceneAssets?.imageUrl && existingSceneAssets.imageDone) {
          log.info({ existingImageUrl: existingSceneAssets.imageUrl }, 'Image-gen: scene image already exists — skipping API call');
          await pipelineStateQueue.add(
            `state-${sceneId}`,
            { jobId, sceneId, tenantId, completedStage: 'image' } satisfies PipelineStateJobPayload,
            { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state-${sceneId}-image` },
          );
          return;
        }
      }

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'image-gen', status: 'started', meta: { sceneId, purpose: purpose ?? 'scene-image' } },
      });

      await db.scene.update({
        where: { id: sceneId },
        data:  { status: 'processing' },
      });

      // ─── 1. Генерируем изображение ────────────────────────────────────────
      // Re-check right before the paid call (the status may have changed since job start).
      if (await isJobDead()) {
        log.info('Image-gen: родительская задача failed/cancelled/удалена — пропускаем платную генерацию');
        return;
      }
      const result = await imageGen.generateWithFallback({
        prompt: imagePrompt,
        negativePrompt: 'ugly, blurry, distorted, lowres, people, person, human, face, hands',
        width:  1080,
        height: 1920,
        referenceImageUrls: referenceImageKeys,
      });
      const { url: imageUrl, contentType } = result;
      // Provider that actually produced the image (may be the Gemini fallback, not the configured one).
      const usedProvider = result.provider;
      log.info({ imageUrl: imageUrl.slice(0, 120), provider: usedProvider }, 'Изображение сгенерировано');

      // ─── 2. Скачиваем → MinIO ─────────────────────────────────────────────
      const storageKey = isFrame
        ? StoragePaths.sceneImage(tenantId, `${sceneId}-frame`)
        : StoragePaths.sceneImage(tenantId, sceneId);

      let imageBuffer: Buffer;
      if (result.buffer) {
        imageBuffer = result.buffer;
      } else {
        const dlResponse = await axios.get<ArrayBuffer>(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxContentLength: MAX_DOWNLOAD_BYTES,
          maxBodyLength: MAX_DOWNLOAD_BYTES,
        });
        imageBuffer = Buffer.from(dlResponse.data);
      }
      await storage.uploadBuffer(storageKey, imageBuffer, { contentType });
      log.info({ storageKey }, 'Изображение загружено в MinIO');

      // ─── 3. Обновляем Scene ───────────────────────────────────────────────
      const costUsd        = imageGenCostUsd(usedProvider);
      const creditsCharged = creditsFromUsd(costUsd);

      if (isFrame) {
        // Frame for runway — save to frameUrl, DON'T mark imageDone (clip not done yet)
        await db.scene.update({
          where: { id: sceneId },
          data:  { frameUrl: storageKey, costUsd },
        });
      } else {
        // Standard scene image — mark imageDone
        await db.scene.update({
          where: { id: sceneId },
          data:  { imageUrl: storageKey, imageDone: true, status: 'completed', costUsd },
        });
      }

      // ─── 4. Generation record ─────────────────────────────────────────────
      await db.generation.create({
        data: {
          tenantId, jobId, sceneId,
          provider: usedProvider === 'runway' ? 'runway' : usedProvider === 'replicate' ? 'replicate' : usedProvider === 'comfyui' ? 'comfyui' : usedProvider === 'gemini' ? 'gemini' as any : usedProvider === 'gptunnel' ? 'gptunnel' as any : 'fal',
          model:           usedProvider,
          status:          'completed',
          requestPayload:  { prompt: imagePrompt, motionPrompt, purpose: purpose ?? 'scene-image' },
          responsePayload: { storageKey, contentType },
          costUsd,
          creditsCharged,
          latencyMs:       Date.now() - startMs,
          startedAt:       new Date(startMs),
          completedAt:     new Date(),
        },
      });

      // ─── 5. Списываем кредиты ─────────────────────────────────────────────
      await chargeCredits(db, {
        tenantId, jobId, credits: creditsCharged,
        description: `Image gen (${usedProvider}) — ${isFrame ? 'frame' : 'image'} ${sceneId.slice(0, 8)}`,
      });
      await db.job.update({ where: { id: jobId }, data: { creditsUsed: { increment: creditsCharged } } });

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'image-gen',
          status:  'completed',
          message: `${isFrame ? 'frame' : 'image'} — $${costUsd.toFixed(4)}`,
          meta:    { sceneId, storageKey, costUsd, creditsCharged, purpose: purpose ?? 'scene-image' },
        },
      });

      // ─── 6. Chain or notify ───────────────────────────────────────────────
      if (isFrame) {
        // Chain: frame generated → now send to runway-clip for image→video
        const presignedUrl = await storage.presignedUrl(storageKey, 3600);
        await runwayQueue.add(
          `runway:${sceneId}`,
          {
            jobId, sceneId, tenantId,
            // Use the motion prompt for Runway image→video animation
            prompt: motionPrompt,
            durationSec: clipDurationSec ?? 5,
            referenceImageUrl: presignedUrl,
          } satisfies RunwayClipJobPayload,
          { ...QUEUES['runway-clip'].defaultJobOptions, jobId: `runway-${sceneId}` },
        );
        log.info({ sceneId }, 'Frame → runway-clip chained');
      } else {
        // Standard image → notify pipeline-state
        await pipelineStateQueue.add(
          `state:${sceneId}`,
          { jobId, sceneId, tenantId, completedStage: 'image' } satisfies PipelineStateJobPayload,
          { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state-${sceneId}-image` },
        );
      }

      log.info({ costUsd, creditsCharged, purpose: purpose ?? 'scene-image' }, 'Изображение успешно обработано');
    },
    { connection, concurrency: QUEUES['image-gen'].concurrency },
  );
}
