/**
 * HeyGen render worker — generates a talking-head avatar video for every “avatar” scene.
 *
 * Flow:
 *  1. Create video task on HeyGen API
 *  2. Poll until video is ready
 *  3. Download video → upload to MinIO
 *  4. Update Scene record (avatarUrl, avatarDone, status, costUsd)
 *  5. Create Generation record for cost audit
 *  6. Deduct credits from tenant
 *  7. Notify pipeline-state
 *
 * On any error: throw → BullMQ retries.  After all retries the’failed’ handler in
 * index.ts marks the job/video as failed.
 */
import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type HeygenRenderJobPayload, type PipelineStateJobPayload } from '@kmmzavod/queue';
import { logger } from '../logger';
import { StoragePaths } from '@kmmzavod/storage';
import type { PrismaClient } from '@kmmzavod/db';
import type { Queue } from 'bullmq';
import type { HeyGenClient } from '../clients/heygen.client';
import type { IStorageClient } from '@kmmzavod/storage';
import { heygenCostUsd, creditsFromUsd } from '../lib/costs';
import { chargeCredits } from '../lib/credits';

interface Deps {
  db:                 PrismaClient;
  heygen:             HeyGenClient;
  storage:            IStorageClient;
  pipelineStateQueue: Queue<PipelineStateJobPayload>;
  connection:         ConnectionOptions;
}

export function createHeygenRenderWorker(deps: Deps) {
  const { db, heygen, storage, pipelineStateQueue, connection } = deps;

  return new Worker<HeygenRenderJobPayload>(
    QUEUES['heygen-render'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, avatarId, script } = job.data;
      const log     = logger.child({ jobId, sceneId, worker: 'heygen-render' });
      const startMs = Date.now();

      log.info('HeyGen: начало генерации аватара');

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'heygen-render', status: 'started', meta: { sceneId } },
      });

      // ─── 1. Создаём задачу в HeyGen ──────────────────────────────────────
      const heygenVideoId = await heygen.createAvatarVideo({ avatarId, script });
      log.info({ heygenVideoId }, 'HeyGen: задача создана, ожидаем рендер');

      await db.scene.update({
        where: { id: sceneId },
        data:  { heygenVideoId, status: 'processing' },
      });

      // ─── 2. Polling ───────────────────────────────────────────────────────
      const { videoUrl, duration } = await heygen.pollUntilDone(heygenVideoId);
      const durationSec = duration > 0 ? duration : Number(
        (await db.scene.findUniqueOrThrow({
          where:  { id: sceneId },
          select: { durationSec: true },
        })).durationSec ?? 5
      );
      log.info({ videoUrl, durationSec }, 'HeyGen: видео готово');

      // ─── 3. Скачиваем → MinIO ─────────────────────────────────────────────
      const storageKey = StoragePaths.sceneAvatar(tenantId, sceneId);
      const dlResponse = await axios.get<ArrayBuffer>(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 120_000,
      });
      await storage.uploadBuffer(storageKey, Buffer.from(dlResponse.data), { contentType: 'video/mp4' });
      log.info({ storageKey }, 'HeyGen: видео загружено в MinIO');

      // ─── 4. Обновляем Scene ───────────────────────────────────────────────
      const costUsd        = heygenCostUsd(durationSec);
      const creditsCharged = creditsFromUsd(costUsd);

      await db.scene.update({
        where: { id: sceneId },
        data:  { avatarUrl: storageKey, avatarDone: true, status: 'completed', costUsd },
      });

      // ─── 5. Generation record ─────────────────────────────────────────────
      await db.generation.create({
        data: {
          tenantId,
          jobId,
          sceneId,
          provider:        'heygen',
          model:           `avatar:${avatarId}`,
          status:          'completed',
          externalTaskId:  heygenVideoId,
          requestPayload:  { avatarId, script },
          responsePayload: { storageKey, durationSec },
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
        description: `HeyGen avatar — scene ${sceneId.slice(0, 8)}`,
      });

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'heygen-render',
          status:  'completed',
          message: `${durationSec.toFixed(1)}s — $${costUsd.toFixed(4)}`,
          meta:    { sceneId, storageKey, costUsd, creditsCharged },
        },
      });

      // ─── 7. Уведомляем pipeline-state ─────────────────────────────────────
      await pipelineStateQueue.add(
        `state:${sceneId}`,
        { jobId, sceneId, tenantId, completedStage: 'avatar' } satisfies PipelineStateJobPayload,
        // idempotent: same jobId prevents double-enqueue
        { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state:${sceneId}:avatar` },
      );

      log.info({ costUsd, creditsCharged }, 'HeyGen аватар успешно обработан');
    },
    { connection, concurrency: QUEUES['heygen-render'].concurrency },
  );
}
