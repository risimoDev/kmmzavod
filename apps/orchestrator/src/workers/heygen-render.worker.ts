/**
 * HeyGen render worker — generates a talking-head avatar video.
 *
 * Two modes:
 *
 * COMBINED (isCombined=true, default for new jobs):
 *   All avatar scene scripts are concatenated → ONE HeyGen video per job.
 *   The combined video is stored at StoragePaths.jobCombinedAvatar.
 *   All avatar scenes are marked done with the same combined video URL.
 *   job.payload.combinedAvatarUrl is set for the compose worker.
 *
 * SINGLE (isCombined=false, legacy):
 *   One HeyGen video per avatar scene (kept for backward compatibility).
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
import { createTaskOrUnrecoverable, isParentJobDead, isProviderTaskGone } from '../lib/provider-errors';

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
      const { jobId, sceneId, tenantId, avatarId, voiceId, script, isCombined, combinedSceneIds } = job.data;
      const log     = logger.child({ jobId, sceneId, worker: 'heygen-render', isCombined: !!isCombined });
      const startMs = Date.now();

      log.info('HeyGen: начало генерации аватара');

      // Parent job already failed/cancelled — don't spend provider money on it.
      if (await isParentJobDead(db, jobId)) {
        log.warn('HeyGen: родительский job failed/cancelled — пропускаем без вызова провайдера');
        return;
      }

      // ─── 0. IDEMPOTENCY CHECK ─────────────────────────────────────────────
      // Skip HeyGen API call if avatar video was already generated for this job/scene.
      // This prevents wasted API tokens on retries when the previous run already
      // succeeded at this stage but failed later (e.g. compose, credit charging).
      if (isCombined && combinedSceneIds && combinedSceneIds.length > 0) {
        const existingJob = await db.job.findUnique({
          where: { id: jobId },
          select: { payload: true },
        });
        const existingPayload = (existingJob?.payload ?? {}) as Record<string, unknown>;
        const existingUrl = existingPayload.combinedAvatarUrl as string | undefined;
        if (existingUrl) {
          log.info({ existingUrl }, 'HeyGen: combined avatar already generated — skipping API call');
          // Ensure all combined scenes are marked done (in case earlier update was partial)
          await db.scene.updateMany({
            where: { id: { in: combinedSceneIds }, avatarDone: false },
            data:  { avatarUrl: existingUrl, avatarDone: true, status: 'completed' },
          });
          // Notify pipeline-state for each scene (idempotent via jobId dedup)
          for (const sid of combinedSceneIds) {
            await pipelineStateQueue.add(
              `state-${sid}`,
              { jobId, sceneId: sid, tenantId, completedStage: 'avatar' } satisfies PipelineStateJobPayload,
              { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state-${sid}-avatar` },
            );
          }
          return;
        }
      } else if (!isCombined) {
        const existingScene = await db.scene.findUnique({
          where:  { id: sceneId },
          select: { avatarUrl: true, avatarDone: true },
        });
        if (existingScene?.avatarUrl && existingScene.avatarDone) {
          log.info({ existingUrl: existingScene.avatarUrl }, 'HeyGen: scene avatar already generated — skipping API call');
          await pipelineStateQueue.add(
            `state-${sceneId}`,
            { jobId, sceneId, tenantId, completedStage: 'avatar' } satisfies PipelineStateJobPayload,
            { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state-${sceneId}-avatar` },
          );
          return;
        }
      }

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage: 'heygen-render', status: 'started',
          meta: isCombined
            ? { mode: 'combined', sceneCount: combinedSceneIds?.length ?? 1 }
            : { sceneId },
        },
      });

      // ─── 1. Задача в HeyGen: возобновляем сохранённую или создаём новую ───
      // The HeyGen video id is persisted right after create (on ALL scenes of a combined
      // render, read back from the primary one). A retry polls the same, already paid task
      // instead of creating a new one.
      const idScenes = isCombined && combinedSceneIds && combinedSceneIds.length > 0
        ? combinedSceneIds
        : [sceneId];
      const primarySceneId = idScenes[0];

      const saveVideoId = async (id: string | null) => {
        try {
          await db.scene.updateMany({
            where: { id: { in: idScenes } },
            data:  id
              ? { heygenVideoId: id, ...(isCombined ? {} : { status: 'processing' as const }) }
              : { heygenVideoId: null },
          });
        } catch (err) {
          // Task is already created (and paid): don't fail the attempt, the id is in the log.
          log.error({ heygenVideoId: id, err: (err as Error).message }, 'HeyGen: не удалось сохранить heygenVideoId');
        }
      };

      const createTask = async (): Promise<string | null> => {
        if (await isParentJobDead(db, jobId)) {
          log.warn('HeyGen: родительский job failed/cancelled — задачу не создаём');
          return null;
        }
        const id = await createTaskOrUnrecoverable(() => heygen.createAvatarVideo({ avatarId, voiceId, script }));
        log.info({ heygenVideoId: id }, 'HeyGen: задача создана, ожидаем рендер');
        await saveVideoId(id);
        return id;
      };

      const stored = await db.scene.findUnique({
        where:  { id: primarySceneId },
        select: { heygenVideoId: true },
      });
      const resumed = !!stored?.heygenVideoId;
      let heygenVideoId: string | null = stored?.heygenVideoId ?? null;
      if (heygenVideoId) {
        log.info({ heygenVideoId }, 'HeyGen: возобновляем сохранённую задачу (без повторного create)');
      } else {
        heygenVideoId = await createTask();
        if (!heygenVideoId) return;
      }

      // ─── 2. Polling ───────────────────────────────────────────────────────
      let polled: { videoUrl: string; duration: number };
      try {
        polled = await heygen.pollUntilDone(heygenVideoId);
      } catch (err) {
        // Only a RESUMED task that the provider reports failed/expired is replaced by a new one.
        if (!resumed || !isProviderTaskGone(err)) throw err;
        log.warn({ heygenVideoId, err: (err as Error).message }, 'HeyGen: сохранённая задача недоступна у провайдера — создаём новую');
        await saveVideoId(null);
        heygenVideoId = await createTask();
        if (!heygenVideoId) return;
        polled = await heygen.pollUntilDone(heygenVideoId);
      }
      const { videoUrl, duration } = polled;

      let durationSec = duration > 0 ? duration : 0;
      if (durationSec === 0 && !isCombined) {
        durationSec = Number(
          (await db.scene.findUniqueOrThrow({
            where:  { id: sceneId },
            select: { durationSec: true },
          })).durationSec ?? 5
        );
      }
      log.info({ videoUrl, durationSec }, 'HeyGen: видео готово');

      // ─── 3. Скачиваем → MinIO ─────────────────────────────────────────────
      const storageKey = isCombined
        ? StoragePaths.jobCombinedAvatar(tenantId, jobId)
        : StoragePaths.sceneAvatar(tenantId, sceneId);

      const dlResponse = await axios.get<ArrayBuffer>(videoUrl, {
        responseType: 'arraybuffer',
        timeout: 180_000,
      });
      await storage.uploadBuffer(storageKey, Buffer.from(dlResponse.data), { contentType: 'video/mp4' });
      log.info({ storageKey }, 'HeyGen: видео загружено в MinIO');

      // ─── 4. Cost / credits ────────────────────────────────────────────────
      const costUsd        = heygenCostUsd(durationSec);
      const creditsCharged = creditsFromUsd(costUsd);

      // ─── 5a. COMBINED MODE: update all avatar scenes + job payload ─────────
      if (isCombined && combinedSceneIds && combinedSceneIds.length > 0) {
        await db.scene.updateMany({
          where: { id: { in: combinedSceneIds } },
          data:  { avatarUrl: storageKey, avatarDone: true, status: 'completed', costUsd },
        });

        // Store combined avatar URL in job payload for video-compose worker
        const jobRow = await db.job.findUnique({ where: { id: jobId }, select: { payload: true } });
        const currentPayload = (jobRow?.payload ?? {}) as Record<string, unknown>;
        await db.job.update({
          where: { id: jobId },
          data:  {
            payload: {
              ...currentPayload,
              combinedAvatarUrl: storageKey,
              combinedAvatarDurationSec: durationSec,
            },
          },
        });

        log.info(
          { sceneCount: combinedSceneIds.length, durationSec, storageKey },
          'HeyGen combined: все сцены аватара обновлены',
        );
      } else {
        // ─── 5b. SINGLE MODE: update individual scene ─────────────────────────
        await db.scene.update({
          where: { id: sceneId },
          data:  { avatarUrl: storageKey, avatarDone: true, status: 'completed', costUsd, durationSec },
        });
      }

      // ─── 6. Generation record ─────────────────────────────────────────────
      await db.generation.create({
        data: {
          tenantId,
          jobId,
          sceneId: isCombined ? combinedSceneIds![0] : sceneId,
          provider:        'heygen',
          model:           `avatar:${avatarId}`,
          status:          'completed',
          externalTaskId:  heygenVideoId,
          requestPayload:  {
            avatarId,
            isCombined: !!isCombined,
            sceneCount: isCombined ? combinedSceneIds!.length : 1,
          },
          responsePayload: { storageKey, durationSec },
          costUsd,
          creditsCharged,
          latencyMs:       Date.now() - startMs,
          startedAt:       new Date(startMs),
          completedAt:     new Date(),
        },
      });

      // ─── 7. Списываем кредиты ─────────────────────────────────────────────
      await chargeCredits(db, {
        tenantId, jobId, credits: creditsCharged,
        description: isCombined
          ? `HeyGen combined avatar — ${combinedSceneIds!.length} scenes`
          : `HeyGen avatar — scene ${sceneId.slice(0, 8)}`,
      });
      await db.job.update({ where: { id: jobId }, data: { creditsUsed: { increment: creditsCharged } } });

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'heygen-render',
          status:  'completed',
          message: `${durationSec.toFixed(1)}s — $${costUsd.toFixed(4)}${isCombined ? ` (${combinedSceneIds!.length} scenes combined)` : ''}`,
          meta:    { storageKey, costUsd, creditsCharged, isCombined: !!isCombined },
        },
      });

      // ─── 8. Уведомляем pipeline-state для каждой сцены аватара ────────────
      const sceneIdsToNotify = isCombined ? (combinedSceneIds ?? [sceneId]) : [sceneId];
      for (const sid of sceneIdsToNotify) {
        await pipelineStateQueue.add(
          `state-${sid}`,
          { jobId, sceneId: sid, tenantId, completedStage: 'avatar' } satisfies PipelineStateJobPayload,
          { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state-${sid}-avatar` },
        );
      }

      log.info({ costUsd, creditsCharged, durationSec }, 'HeyGen аватар успешно обработан');
    },
    { connection, concurrency: QUEUES['heygen-render'].concurrency },
  );
}
