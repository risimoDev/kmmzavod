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
import type { ImageGenClient } from '../clients/image-gen.client';
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
  const { db, imageGen, storage, pipelineStateQueue, runwayQueue, connection, provider } = deps;

  return new Worker<ImageGenJobPayload>(
    QUEUES['image-gen'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, prompt, referenceImageKeys, purpose, clipDurationSec } = job.data;
      const isFrame = purpose === 'runway-frame';
      const log     = logger.child({ jobId, sceneId, worker: 'image-gen', purpose: purpose ?? 'scene-image' });
      const startMs = Date.now();

      log.info('Начало генерации изображения');

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'image-gen', status: 'started', meta: { sceneId, purpose: purpose ?? 'scene-image' } },
      });

      await db.scene.update({
        where: { id: sceneId },
        data:  { status: 'processing' },
      });

      // ─── 1. Генерируем изображение ────────────────────────────────────────
      const result = await imageGen.generateWithFallback({
        prompt,
        negativePrompt: 'ugly, blurry, distorted, lowres',
        width:  1080,
        height: 1920,
        referenceImageUrls: referenceImageKeys,
      });
      const { url: imageUrl, contentType } = result;
      log.info({ imageUrl: imageUrl.slice(0, 120) }, 'Изображение сгенерировано');

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
        });
        imageBuffer = Buffer.from(dlResponse.data);
      }
      await storage.uploadBuffer(storageKey, imageBuffer, { contentType });
      log.info({ storageKey }, 'Изображение загружено в MinIO');

      // ─── 3. Обновляем Scene ───────────────────────────────────────────────
      const costUsd        = imageGenCostUsd(provider as 'fal' | 'replicate' | 'comfyui' | 'runway' | 'gemini');
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
          provider: provider === 'runway' ? 'runway' : provider === 'replicate' ? 'replicate' : provider === 'comfyui' ? 'comfyui' : provider === 'gemini' ? 'gemini' as any : 'fal',
          model:           provider,
          status:          'completed',
          requestPayload:  { prompt, purpose: purpose ?? 'scene-image' },
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
        description: `Image gen (${provider}) — ${isFrame ? 'frame' : 'image'} ${sceneId.slice(0, 8)}`,
      });

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
            prompt,
            durationSec: clipDurationSec ?? 5,
            referenceImageUrl: presignedUrl,
          } satisfies RunwayClipJobPayload,
          { ...QUEUES['runway-clip'].defaultJobOptions, jobId: `runway:${sceneId}` },
        );
        log.info({ sceneId }, 'Frame → runway-clip chained');
      } else {
        // Standard image → notify pipeline-state
        await pipelineStateQueue.add(
          `state:${sceneId}`,
          { jobId, sceneId, tenantId, completedStage: 'image' } satisfies PipelineStateJobPayload,
          { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state:${sceneId}:image` },
        );
      }

      log.info({ costUsd, creditsCharged, purpose: purpose ?? 'scene-image' }, 'Изображение успешно обработано');
    },
    { connection, concurrency: QUEUES['image-gen'].concurrency },
  );
}
