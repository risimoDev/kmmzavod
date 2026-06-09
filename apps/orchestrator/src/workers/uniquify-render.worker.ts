/**
 * Uniquify-render worker.
 *
 * Calls video-processor POST /uniquify/render to apply transforms and produce
 * a unique variant. On completion, enqueues a uniquify-state event.
 */

import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import {
  QUEUES,
  type UniquifyRenderJobPayload,
  type UniquifyStateJobPayload,
} from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger } from '../logger';

interface Deps {
  db: PrismaClient;
  videoProcessorUrl: string;
  uniquifyStateQueue: Queue<UniquifyStateJobPayload>;
  connection: ConnectionOptions;
}

export function createUniquifyRenderWorker(deps: Deps): Worker {
  const { db, videoProcessorUrl, uniquifyStateQueue, connection } = deps;

  return new Worker<UniquifyRenderJobPayload>(
    QUEUES['uniquify-render'].name,
    async (job) => {
      const {
        uniquifyJobId,
        variantId,
        tenantId,
        sourceVideoStorageKey,
        outputKey,
        transforms,
        transcript,
      } = job.data;

      logger.info({ variantId, uniquifyJobId }, 'Uniquify-render: starting');

      // 1. Verify job wasn't cancelled before we start
      const jobCheck = await db.uniquifyJob.findUnique({
        where: { id: uniquifyJobId },
        select: { status: true },
      });
      if (jobCheck?.status === 'cancelled') {
        logger.info({ uniquifyJobId, variantId }, 'Uniquify-render: job cancelled, aborting');
        return;
      }

      // 2. Mark variant as rendering
      await db.uniqueVariant.update({
        where: { id: variantId },
        data: { status: 'rendering' },
      });

      try {
        // 2. Get variant record for TTS key and config for BGM
        const variantRecord = await db.uniqueVariant.findUniqueOrThrow({
          where: { id: variantId },
          select: { ttsStorageKey: true, bgmTrackKey: true },
        });
        const uniquifyJob = await db.uniquifyJob.findUniqueOrThrow({
          where: { id: uniquifyJobId },
        });

        const config = uniquifyJob.config as Record<string, unknown>;
        const bgmKeys = (config.bgmTrackKeys ?? []) as string[];

        // Pick a random BGM key for this variant (if available)
        const bgmKey = variantRecord.bgmTrackKey
          ?? (bgmKeys.length > 0 ? bgmKeys[job.data.transforms.crf % bgmKeys.length] : undefined);

        // 3. Call video-processor /uniquify/render
        const renderResp = await axios.post<{
          output_key: string;
          thumbnail_key: string | null;
          duration_sec: number;
          file_size_bytes: number;
          width: number;
          height: number;
        }>(`${videoProcessorUrl}/uniquify/render`, {
          variant_id: variantId,
          uniquify_job_id: uniquifyJobId,
          tenant_id: tenantId,
          source_storage_key: sourceVideoStorageKey,
          output_key: outputKey,
          transforms,
          transcript: transcript,
          bgm_storage_key: bgmKey ?? null,
          tts_storage_key: variantRecord.ttsStorageKey ?? null,
        }, { timeout: 600_000 });

        const result = renderResp.data;

        // 4. Update variant with results
        await db.uniqueVariant.update({
          where: { id: variantId },
          data: {
            status: 'completed',
            outputKey: result.output_key,
            outputUrl: result.output_key, // Will be resolved to presigned URL by API
            thumbnailKey: result.thumbnail_key,
            durationSec: result.duration_sec,
            fileSizeBytes: result.file_size_bytes != null ? BigInt(Math.round(result.file_size_bytes)) : null,
            width: result.width,
            height: result.height,
            bgmTrackKey: bgmKey,
            pHash: result.phash ?? null,
          },
        });

        // 5. Enqueue state update
        await uniquifyStateQueue.add(
          `uniquify-state-${variantId}`,
          {
            uniquifyJobId,
            variantId,
            tenantId,
            status: 'completed',
          } satisfies UniquifyStateJobPayload,
          QUEUES['uniquify-state'].defaultJobOptions,
        );

        logger.info(
          { variantId, uniquifyJobId, outputKey: result.output_key },
          'Uniquify-render: variant completed',
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Mark variant as failed
        await db.uniqueVariant.update({
          where: { id: variantId },
          data: { status: 'failed', error: errorMsg },
        });

        // Enqueue state update for failure tracking
        await uniquifyStateQueue.add(
          `uniquify-state-fail-${variantId}`,
          {
            uniquifyJobId,
            variantId,
            tenantId,
            status: 'failed',
            error: errorMsg,
          } satisfies UniquifyStateJobPayload,
          QUEUES['uniquify-state'].defaultJobOptions,
        );

        throw err; // Re-throw for BullMQ retry
      }
    },
    {
      connection,
      concurrency: QUEUES['uniquify-render'].concurrency,
    },
  );
}
