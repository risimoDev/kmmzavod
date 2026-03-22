// Pipeline coordinator — converts a single job into fan-out BullMQ tasks
// Called by: pipeline worker in index.ts

import { Queue } from 'bullmq';
import { QUEUE_DEFS, type GptScriptJobPayload, type ProductContext } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { IStorageClient } from '@kmmzavod/storage';

interface Deps {
  db: PrismaClient;
  gptQueue: Queue;
  storage: IStorageClient;
}

export async function startPipeline(jobId: string, tenantId: string, deps: Deps): Promise<void> {
  const job = await deps.db.job.findUniqueOrThrow({
    where:  { id: jobId },
    select: { payload: true, videoId: true },
  });

  // Mark job + video as running/processing atomically
  await deps.db.$transaction([
    deps.db.job.update({
      where: { id: jobId },
      data:  { status: 'running' },
    }),
    ...(job.videoId ? [
      deps.db.video.update({
        where: { id: job.videoId },
        data:  { status: 'processing' },
      }),
    ] : []),
  ]);

  await deps.db.jobEvent.create({
    data: { jobId, tenantId, stage: 'pipeline', status: 'started', message: 'Pipeline started' },
  });

  // Публикуем начальный прогресс
  if (job.videoId) {
    const { publishProgress } = await import('../lib/progress');
    await publishProgress(tenantId, job.videoId, 'pipeline', 'started', 2, 'Pipeline started');
  }

  const payload = job.payload as Record<string, unknown>;

  // ── Load product context if video has a linked product ───────────────────
  let productContext: ProductContext | undefined;

  if (job.videoId) {
    const video = await deps.db.video.findUnique({
      where:  { id: job.videoId },
      select: { productId: true },
    });

    if (video?.productId) {
      const product = await deps.db.product.findUnique({
        where:  { id: video.productId },
        select: { name: true, description: true, features: true, targetAudience: true, brandVoice: true, images: true },
      });

      if (product) {
        const imageUrls = await Promise.all(
          product.images.map((key) => deps.storage.presignedUrl(key, 3600)),
        );

        productContext = {
          name:           product.name,
          description:    product.description ?? undefined,
          features:       product.features,
          targetAudience: product.targetAudience ?? undefined,
          brandVoice:     product.brandVoice ?? undefined,
          imageUrls,
        };
      }
    }
  }

  const gptPayload: GptScriptJobPayload = {
    jobId,
    tenantId,
    prompt:          (payload['script_prompt'] as string) ?? '',
    projectSettings: (payload['settings']      as Record<string, unknown>) ?? {},
    productContext,
  };

  await deps.gptQueue.add(`gpt:${jobId}`, gptPayload, QUEUE_DEFS.GPT_SCRIPT.defaultJobOptions);
}
