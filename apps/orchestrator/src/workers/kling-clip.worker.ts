/**
 * Kling clip worker — text-to-video b-roll generation for "clip" scenes.
 *
 * Flow:
 *  1. Create Kling text-to-video task
 *  2. Poll until clip ready
 *  3. Download clip → upload to MinIO
 *  4. Update Scene record (clipUrl, clipDone, status, costUsd)
 *  5. Create Generation record for cost audit
 *  6. Deduct credits
 *  7. Notify pipeline-state
 *
 * Errors throw → BullMQ retries.  index.ts 'failed' handler marks job/video failed.
 */
import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type KlingClipJobPayload, type PipelineStateJobPayload } from '@kmmzavod/queue';
import { logger } from '../logger';
import { StoragePaths } from '@kmmzavod/storage';
import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import type { KlingClient } from '../clients/kling.client';
import type { IStorageClient } from '@kmmzavod/storage';
import { klingCostUsd, creditsFromUsd } from '../lib/costs';
import { chargeCredits } from '../lib/credits';

interface Deps {
  db:                 PrismaClient;
  kling:              KlingClient;
  storage:            IStorageClient;
  pipelineStateQueue: Queue<PipelineStateJobPayload>;
  connection:         ConnectionOptions;
}

export function createKlingClipWorker(deps: Deps) {
  const { db, kling, storage, pipelineStateQueue, connection } = deps;

  return new Worker<KlingClipJobPayload>(
    QUEUES['kling-clip'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, prompt, durationSec } = job.data;
      const log     = logger.child({ jobId, sceneId, worker: 'kling-clip' });
      const startMs = Date.now();

      log.info('Kling: начало генерации клипа');

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'kling-clip', status: 'started', meta: { sceneId } },
      });

      // ─── 1. Создаём задачу в Kling ───────────────────────────────────────
      const taskId = await kling.createClip({ prompt, durationSec: durationSec ?? 5 });
      log.info({ taskId }, 'Kling: задача создана, ожидаем клип');

      await db.scene.update({
        where: { id: sceneId },
        data:  { klingTaskId: taskId, status: 'processing' },
      });

      // ─── 2. Polling ───────────────────────────────────────────────────────
      const { videoUrl, duration } = await kling.pollUntilDone(taskId);
      const actualDuration = duration > 0 ? duration : (durationSec ?? 5);
      log.info({ videoUrl, actualDuration }, 'Kling: клип готов');

      // ─── 3. Скачиваем → MinIO ─────────────────────────────────────────────
      const storageKey = StoragePaths.sceneClip(tenantId, sceneId);
      const dlResponse = await axios.get<ArrayBuffer>(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
      });
      await storage.uploadBuffer(storageKey, Buffer.from(dlResponse.data), { contentType: 'video/mp4' });
      log.info({ storageKey }, 'Kling: клип загружен в MinIO');

      // ─── 4. Обновляем Scene ───────────────────────────────────────────────
      const costUsd        = klingCostUsd(actualDuration);
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
          provider:        'kling',
          model:           'kling-v1.5-text2video',
          status:          'completed',
          externalTaskId:  taskId,
          requestPayload:  { prompt, durationSec },
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
        description: `Kling clip — scene ${sceneId.slice(0, 8)}`,
      });

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'kling-clip',
          status:  'completed',
          message: `${actualDuration.toFixed(1)}s — $${costUsd.toFixed(4)}`,
          meta:    { sceneId, storageKey, costUsd, creditsCharged },
        },
      });

      // ─── 7. Уведомляем pipeline-state ─────────────────────────────────────
      await pipelineStateQueue.add(
        `state:${sceneId}`,
        { jobId, sceneId, tenantId, completedStage: 'clip' } satisfies PipelineStateJobPayload,
        { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state:${sceneId}:clip` },
      );

      log.info({ costUsd, creditsCharged }, 'Kling клип успешно обработан');
    },
    { connection, concurrency: QUEUES['kling-clip'].concurrency },
  );
}
