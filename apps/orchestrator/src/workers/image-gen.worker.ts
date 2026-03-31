/**
 * Image gen worker — генерирует изображения для сцен типа «image».
 * Поддерживает: fal.ai, Replicate, ComfyUI (self-hosted).
 *
 * Flow:
 *  1. Generate image via ImageGenClient
 *  2. Download image → upload to MinIO
 *  3. Update Scene record (imageUrl, imageDone, status, costUsd)
 *  4. Create Generation record for cost audit
 *  5. Deduct credits
 *  6. Notify pipeline-state
 *
 * Errors throw → BullMQ retries.  index.ts 'failed' handler marks job/video failed.
 */
import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type ImageGenJobPayload, type PipelineStateJobPayload } from '@kmmzavod/queue';
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
  connection:         ConnectionOptions;
  provider:           string;
}

export function createImageGenWorker(deps: Deps) {
  const { db, imageGen, storage, pipelineStateQueue, connection, provider } = deps;

  return new Worker<ImageGenJobPayload>(
    QUEUES['image-gen'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, prompt, referenceImageKeys } = job.data;
      const log     = logger.child({ jobId, sceneId, worker: 'image-gen' });
      const startMs = Date.now();

      log.info('Начало генерации изображения');

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'image-gen', status: 'started', meta: { sceneId } },
      });

      await db.scene.update({
        where: { id: sceneId },
        data:  { status: 'processing' },
      });

      // ─── 1. Генерируем изображение ────────────────────────────────────────
      const { url: imageUrl, contentType } = await imageGen.generate({
        prompt,
        negativePrompt: 'ugly, blurry, distorted, lowres',
        width:  1080,
        height: 1920,
        referenceImageUrls: referenceImageKeys,
      });
      log.info({ imageUrl }, 'Изображение сгенерировано');

      // ─── 2. Скачиваем → MinIO ─────────────────────────────────────────────
      const storageKey = StoragePaths.sceneImage(tenantId, sceneId);
      const dlResponse = await axios.get<ArrayBuffer>(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 60_000,
      });
      await storage.uploadBuffer(storageKey, Buffer.from(dlResponse.data), { contentType });
      log.info({ storageKey }, 'Изображение загружено в MinIO');

      // ─── 3. Обновляем Scene ───────────────────────────────────────────────
      const costUsd        = imageGenCostUsd(provider as 'fal' | 'replicate' | 'comfyui' | 'runway');
      const creditsCharged = creditsFromUsd(costUsd);

      await db.scene.update({
        where: { id: sceneId },
        data:  { imageUrl: storageKey, imageDone: true, status: 'completed', costUsd },
      });

      // ─── 4. Generation record ─────────────────────────────────────────────
      await db.generation.create({
        data: {
          tenantId,
          jobId,
          sceneId,
          provider:        provider === 'runway' ? 'runway' : provider === 'replicate' ? 'replicate' : provider === 'comfyui' ? 'comfyui' : 'fal',
          model:           provider,
          status:          'completed',
          requestPayload:  { prompt },
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
        description: `Image gen (${provider}) — scene ${sceneId.slice(0, 8)}`,
      });

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage:   'image-gen',
          status:  'completed',
          message: `image — $${costUsd.toFixed(4)}`,
          meta:    { sceneId, storageKey, costUsd, creditsCharged },
        },
      });

      // ─── 6. Уведомляем pipeline-state ─────────────────────────────────────
      await pipelineStateQueue.add(
        `state:${sceneId}`,
        { jobId, sceneId, tenantId, completedStage: 'image' } satisfies PipelineStateJobPayload,
        { ...QUEUES['pipeline-state'].defaultJobOptions, jobId: `state:${sceneId}:image` },
      );

      log.info({ costUsd, creditsCharged }, 'Изображение успешно обработано');
    },
    { connection, concurrency: QUEUES['image-gen'].concurrency },
  );
}
