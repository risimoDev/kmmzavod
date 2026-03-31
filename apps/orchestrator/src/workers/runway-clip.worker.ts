/**
 * Runway clip worker — text-to-video b-roll generation for "clip" scenes.
 * Replaces the previous Kling clip worker.
 *
 * Flow:
 *  1. Create Runway text-to-video task
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
import { QUEUES, type RunwayClipJobPayload, type PipelineStateJobPayload } from '@kmmzavod/queue';
import { logger } from '../logger';
import { StoragePaths } from '@kmmzavod/storage';
import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import type { RunwayClient } from '../clients/runway.client';
import type { IStorageClient } from '@kmmzavod/storage';
import { runwayCostUsd, creditsFromUsd } from '../lib/costs';
import { chargeCredits } from '../lib/credits';

interface Deps {
  db:                 PrismaClient;
  runway:             RunwayClient;
  storage:            IStorageClient;
  pipelineStateQueue: Queue<PipelineStateJobPayload>;
  connection:         ConnectionOptions;
}

export function createRunwayClipWorker(deps: Deps) {
  const { db, runway, storage, pipelineStateQueue, connection } = deps;

  return new Worker<RunwayClipJobPayload>(
    QUEUES['runway-clip'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, prompt, durationSec } = job.data;
      const log     = logger.child({ jobId, sceneId, worker: 'runway-clip' });
      const startMs = Date.now();

      log.info('Runway: начало генерации клипа');

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'runway-clip', status: 'started', meta: { sceneId } },
      });

      // ─── 1. Создаём задачу в Runway ──────────────────────────────────────
      const taskId = await runway.createClip({ prompt, durationSec: durationSec ?? 5 });
      log.info({ taskId }, 'Runway: задача создана, ожидаем клип');

      await db.scene.update({
        where: { id: sceneId },
        data:  { runwayTaskId: taskId, status: 'processing' },
      });

      // ─── 2. Polling ───────────────────────────────────────────────────────
      const { outputUrl, duration } = await runway.pollUntilDone(taskId);
      const actualDuration = duration > 0 ? duration : (durationSec ?? 5);
      log.info({ outputUrl, actualDuration }, 'Runway: клип готов');

      // ─── 3. Скачиваем → MinIO ─────────────────────────────────────────────
      const storageKey = StoragePaths.sceneClip(tenantId, sceneId);
      const dlResponse = await axios.get<ArrayBuffer>(outputUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
      });
      await storage.uploadBuffer(storageKey, Buffer.from(dlResponse.data), { contentType: 'video/mp4' });
      log.info({ storageKey }, 'Runway: клип загружен в MinIO');

      // ─── 4. Обновляем Scene ───────────────────────────────────────────────
      const costUsd        = runwayCostUsd(actualDuration);
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
          model:           'gen4.5',
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
        description: `Runway clip — scene ${sceneId.slice(0, 8)}`,
      });

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'runway-clip',
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

      log.info({ costUsd, creditsCharged }, 'Runway клип успешно обработан');
    },
    { connection, concurrency: QUEUES['runway-clip'].concurrency },
  );
}
