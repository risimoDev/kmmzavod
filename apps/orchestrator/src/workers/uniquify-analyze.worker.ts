/**
 * Uniquify-analyze worker.
 *
 * Calls video-processor POST /uniquify/analyze to probe the source video,
 * detect scenes, and extract audio profile. Then updates the SourceVideo
 * and creates UniqueVariant rows with random transforms.
 */

import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import {
  QUEUES,
  type UniquifyAnalyzeJobPayload,
  type UniquifyRenderJobPayload,
  type VariantTransforms,
} from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger } from '../logger';

interface Deps {
  db: PrismaClient;
  videoProcessorUrl: string;
  uniquifyRenderQueue: Queue<UniquifyRenderJobPayload>;
  connection: ConnectionOptions;
}

export function createUniquifyAnalyzeWorker(deps: Deps): Worker {
  const { db, videoProcessorUrl, uniquifyRenderQueue, connection } = deps;

  return new Worker<UniquifyAnalyzeJobPayload>(
    QUEUES['uniquify-analyze'].name,
    async (job) => {
      const { sourceVideoId, tenantId, uniquifyJobId } = job.data;
      logger.info({ sourceVideoId, uniquifyJobId }, 'Uniquify-analyze: starting');

      // 1. Verify job wasn't cancelled before we start
      const jobCheck = await db.uniquifyJob.findUnique({
        where: { id: uniquifyJobId },
        select: { status: true },
      });
      if (jobCheck?.status === 'cancelled') {
        logger.info({ uniquifyJobId }, 'Uniquify-analyze: job cancelled, aborting');
        return;
      }

      // 2. Get source video record
      const sourceVideo = await db.sourceVideo.findUniqueOrThrow({
        where: { id: sourceVideoId },
      });

      // 3. Update status
      await db.$transaction([
        db.sourceVideo.update({
          where: { id: sourceVideoId },
          data: { status: 'analyzing' },
        }),
        db.uniquifyJob.update({
          where: { id: uniquifyJobId },
          data: { status: 'analyzing' },
        }),
      ]);

      try {
        // 4. Call video-processor /uniquify/analyze
        const analyzeResp = await axios.post<{
          duration_sec: number;
          width: number;
          height: number;
          fps: number;
          scene_breaks: number[];
          audio_profile: Record<string, unknown>;
        }>(`${videoProcessorUrl}/uniquify/analyze`, {
          source_video_id: sourceVideoId,
          storage_key: sourceVideo.storageKey,
        }, { timeout: 300_000 });

        const analysis = analyzeResp.data;

        // 5. Update SourceVideo with analysis results
        await db.sourceVideo.update({
          where: { id: sourceVideoId },
          data: {
            status: 'ready',
            durationSec: analysis.duration_sec,
            width: analysis.width,
            height: analysis.height,
            fps: analysis.fps,
            sceneBreaks: analysis.scene_breaks as unknown as any,
            audioProfile: analysis.audio_profile as unknown as any,
          },
        });

        // 6. Get uniquify job config
        const uniquifyJob = await db.uniquifyJob.findUniqueOrThrow({
          where: { id: uniquifyJobId },
        });

        const variantCount = uniquifyJob.variantCount;

        // 7. Generate random transforms via video-processor
        const transformsResp = await axios.post<{
          transforms: VariantTransforms[];
        }>(`${videoProcessorUrl}/uniquify/generate-transforms`, {
          count: variantCount,
          seed: Date.now(),
        }, { timeout: 10_000 });

        const allTransforms = transformsResp.data.transforms;

        // 8. Create UniqueVariant rows and enqueue render jobs
        const variants = await db.$transaction(
          allTransforms.map((transforms: VariantTransforms, i: number) =>
            db.uniqueVariant.create({
              data: {
                uniquifyJobId,
                tenantId,
                variantIndex: i,
                status: 'pending',
                transforms: transforms as any,
                subtitleStyle: transforms.subtitleStyle || 'none',
              },
            })
          )
        );

        // 9. Update job status to generating
        await db.uniquifyJob.update({
          where: { id: uniquifyJobId },
          data: { status: 'generating' },
        });

        // 10. Enqueue all render jobs
        const renderJobs = variants.map((variant: any, i: number) => ({
          name: `uniquify-render-${variant.id}`,
          data: {
            uniquifyJobId,
            variantId: variant.id,
            tenantId,
            sourceVideoStorageKey: sourceVideo.storageKey,
            outputKey: `tenants/${tenantId}/uniquify/${uniquifyJobId}/${variant.id}.mp4`,
            transforms: allTransforms[i],
          } as UniquifyRenderJobPayload,
          opts: QUEUES['uniquify-render'].defaultJobOptions as any,
        }));

        await uniquifyRenderQueue.addBulk(renderJobs);

        logger.info(
          { uniquifyJobId, variantCount: variants.length },
          'Uniquify-analyze: complete, render jobs enqueued',
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ sourceVideoId, uniquifyJobId, err: errorMsg }, 'Uniquify-analyze: failed');

        await db.$transaction([
          db.sourceVideo.update({
            where: { id: sourceVideoId },
            data: { status: 'failed', error: errorMsg },
          }),
          db.uniquifyJob.update({
            where: { id: uniquifyJobId },
            data: { status: 'failed', error: errorMsg },
          }),
        ]);

        throw err; // Let BullMQ handle retries
      }
    },
    {
      connection,
      concurrency: QUEUES['uniquify-analyze'].concurrency,
    },
  );
}
