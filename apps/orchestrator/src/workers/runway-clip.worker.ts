/**
 * Runway clip worker — video generation for "clip" scenes.
 *
 * Supports two modes:
 *  A. **image-to-video** (gen4_turbo, 5 credits/sec) — when referenceImageUrl is provided.
 *     Takes a product image and animates it. Cheaper, more relevant to the product.
 *  B. **text-to-video** (gen4.5, 12 credits/sec) — fallback when no reference image.
 *     Generates b-roll purely from text prompt.
 *
 * Flow:
 *  1. Create Runway task (image-to-video or text-to-video)
 *  2. Poll until clip ready
 *  3. Download clip → upload to MinIO
 *  4. Update Scene record (clipUrl, clipDone, status, costUsd)
 *  5. Create Generation record for cost audit
 *  6. Deduct credits
 *  7. Notify pipeline-state
 */
import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type RunwayClipJobPayload, type PipelineStateJobPayload } from '@kmmzavod/queue';
import { logger } from '../logger';
import { StoragePaths } from '@kmmzavod/storage';
import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import type { RunwayClient, RunwayVideoModel } from '../clients/runway.client';
import type { IStorageClient } from '@kmmzavod/storage';
import { runwayCostUsd, creditsFromUsd } from '../lib/costs';
import { chargeCredits } from '../lib/credits';

interface Deps {
  db:                 PrismaClient;
  runway:             RunwayClient;
  storage:            IStorageClient;
  pipelineStateQueue: Queue<PipelineStateJobPayload>;
  connection:         ConnectionOptions;
  /** Default model for video generation. Overridden to gen4_turbo when referenceImageUrl is present. */
  defaultModel:       RunwayVideoModel;
}

export function createRunwayClipWorker(deps: Deps) {
  const { db, runway, storage, pipelineStateQueue, connection, defaultModel } = deps;

  return new Worker<RunwayClipJobPayload>(
    QUEUES['runway-clip'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, prompt, durationSec, referenceImageUrl } = job.data;
      const log     = logger.child({ jobId, sceneId, worker: 'runway-clip' });
      const startMs = Date.now();

      // Determine mode: image-to-video (cheaper) when we have a product image
      const useImageToVideo = !!referenceImageUrl;
      const model: RunwayVideoModel = useImageToVideo ? 'gen4_turbo' : (defaultModel === 'gen4_turbo' ? 'gen4.5' : defaultModel);
      const mode = useImageToVideo ? 'image-to-video' : 'text-to-video';

      // Ensure the motion prompt is clean and concise for Runway.
      // Runway image-to-video performs best with short, specific motion descriptions.
      // The prompt from image-gen already contains the extracted motion part.
      const MAX_MOTION_PROMPT_WORDS = 30;
      const words = prompt.trim().split(/\s+/);
      const runwayPrompt = words.length > MAX_MOTION_PROMPT_WORDS
        ? words.slice(0, MAX_MOTION_PROMPT_WORDS).join(' ')
        : prompt.trim();

      log.info({ mode, model, referenceImageUrl: referenceImageUrl?.slice(0, 80) }, 'Runway: начало генерации клипа');

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'runway-clip', status: 'started', meta: { sceneId, mode, model } },
      });

      // ─── 1. Создаём задачу в Runway ──────────────────────────────────────
      let taskId: string;
      if (useImageToVideo) {
        taskId = await runway.createImageToVideo({
          promptImage: referenceImageUrl,
          prompt: runwayPrompt,
          durationSec: durationSec ?? 5,
          model: 'gen4_turbo',
        });
      } else {
        taskId = await runway.createClip({
          prompt: runwayPrompt,
          durationSec: durationSec ?? 5,
          model: 'gen4.5',
        });
      }
      log.info({ taskId, mode }, 'Runway: задача создана, ожидаем клип');

      await db.scene.update({
        where: { id: sceneId },
        data:  { runwayTaskId: taskId, status: 'processing' },
      });

      // ─── 2. Polling ───────────────────────────────────────────────────────
      const { outputUrl, duration } = await runway.pollUntilDone(taskId);
      const actualDuration = duration > 0 ? duration : (durationSec ?? 5);
      log.info({ outputUrl, actualDuration, mode }, 'Runway: клип готов');

      // ─── 3. Скачиваем → MinIO ─────────────────────────────────────────────
      const storageKey = StoragePaths.sceneClip(tenantId, sceneId);
      const dlResponse = await axios.get<ArrayBuffer>(outputUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
      });
      await storage.uploadBuffer(storageKey, Buffer.from(dlResponse.data), { contentType: 'video/mp4' });
      log.info({ storageKey }, 'Runway: клип загружен в MinIO');

      // ─── 4. Обновляем Scene ───────────────────────────────────────────────
      const actualModel = useImageToVideo ? 'gen4_turbo' : 'gen4.5';
      const costUsd        = runwayCostUsd(actualDuration, actualModel);
      const creditsCharged = creditsFromUsd(costUsd);

      await db.scene.update({
        where: { id: sceneId },
        data:  { clipUrl: storageKey, clipDone: true, status: 'completed', costUsd },
      });

      // ─── 5. Generation record ─────────────────────────────────────────────
      await db.generation.create({
        data: {
          tenantId,
          jobId,
          sceneId,
          provider:        'runway',
          model:           actualModel,
          status:          'completed',
          externalTaskId:  taskId,
          requestPayload:  { prompt: runwayPrompt, durationSec, mode, referenceImageUrl: referenceImageUrl?.slice(0, 200) },
          responsePayload: { storageKey, durationSec: actualDuration },
          costUsd,
          creditsCharged,
          latencyMs:       Date.now() - startMs,
          startedAt:       new Date(startMs),
          completedAt:     new Date(),
        },
      });

      // ─── 6. Списываем кредиты ─────────────────────────────────────────────
      await chargeCredits(db, {
        tenantId, jobId, credits: creditsCharged,
        description: `Runway ${mode} (${actualModel}) — scene ${sceneId.slice(0, 8)}`,
      });
      await db.job.update({ where: { id: jobId }, data: { creditsUsed: { increment: creditsCharged } } });

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'runway-clip',
          status:  'completed',
          message: `${mode} ${actualDuration.toFixed(1)}s (${actualModel}) — $${costUsd.toFixed(4)}`,
          meta:    { sceneId, storageKey, costUsd, creditsCharged, mode, model: actualModel },
        },
      });

      // ─── 7. Уведомляем pipeline-state ─────────────────────────────────────
      await pipelineStateQueue.add(
        `state:${sceneId}`,
        { jobId, sceneId, tenantId, completedStage: 'clip' } satisfies PipelineStateJobPayload,
        { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state-${sceneId}-clip` },
      );

      log.info({ costUsd, creditsCharged, mode, model: actualModel }, 'Runway клип успешно обработан');
    },
    { connection, concurrency: QUEUES['runway-clip'].concurrency },
  );
}
