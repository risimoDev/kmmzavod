/**
 * Uniquify-render worker (montage pipeline).
 *
 * Renders one unique montage variant. The shared voiceover + subtitle transcript
 * are read from the UniquifyJob (generated once in the analyze step); the payload
 * carries only the per-variant uniqueness levers (montage seed, BGM, style).
 * No AI calls happen here — producing N variants is N FFmpeg renders, 0 tokens.
 */

import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import {
  QUEUES,
  type UniquifyRenderJobPayload,
  type UniquifyStateJobPayload,
  type SubtitleLine,
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
        sourceStorageKeys,
        outputKey,
        seed,
        subtitleStyle,
        bgmStorageKey,
        bgmVolume,
        voiceoverVolume,
        width,
        height,
        fps,
        beatSync,
      } = job.data;

      logger.info({ variantId, uniquifyJobId, seed }, 'Uniquify-render: starting');

      const uniquifyJob = await db.uniquifyJob.findUniqueOrThrow({
        where: { id: uniquifyJobId },
        select: { status: true, voiceoverKey: true, transcript: true },
      });
      if (uniquifyJob.status === 'cancelled') {
        logger.info({ uniquifyJobId, variantId }, 'Uniquify-render: job cancelled, aborting');
        return;
      }
      if (!uniquifyJob.voiceoverKey) {
        throw new Error('Uniquify-render: job has no voiceover (analyze step did not complete)');
      }

      await db.uniqueVariant.update({ where: { id: variantId }, data: { status: 'rendering' } });

      try {
        const subtitles = (uniquifyJob.transcript ?? []) as unknown as SubtitleLine[];

        const renderResp = await axios.post<{
          output_key: string;
          thumbnail_key: string | null;
          duration_sec: number;
          file_size_bytes: number;
          width: number;
          height: number;
          phash: string | null;
          segment_count: number;
        }>(`${videoProcessorUrl}/uniquify/render`, {
          variant_id: variantId,
          uniquify_job_id: uniquifyJobId,
          tenant_id: tenantId,
          source_storage_keys: sourceStorageKeys,
          voiceover_storage_key: uniquifyJob.voiceoverKey,
          output_key: outputKey,
          seed,
          width,
          height,
          fps,
          subtitles,
          subtitle_style: subtitleStyle,
          bgm_storage_key: bgmStorageKey ?? null,
          bgm_volume: bgmVolume,
          voiceover_volume: voiceoverVolume,
          beat_sync: beatSync,
        }, { timeout: 900_000 });

        const result = renderResp.data;

        await db.uniqueVariant.update({
          where: { id: variantId },
          data: {
            status: 'completed',
            outputKey: result.output_key,
            outputUrl: result.output_key,
            thumbnailKey: result.thumbnail_key,
            durationSec: result.duration_sec,
            fileSizeBytes:
              result.file_size_bytes != null ? BigInt(Math.round(result.file_size_bytes)) : null,
            width: result.width,
            height: result.height,
            pHash: result.phash ?? null,
          },
        });

        await uniquifyStateQueue.add(
          `uniquify-state-${variantId}`,
          { uniquifyJobId, variantId, tenantId, status: 'completed' } satisfies UniquifyStateJobPayload,
          QUEUES['uniquify-state'].defaultJobOptions,
        );

        logger.info(
          { variantId, uniquifyJobId, outputKey: result.output_key, segments: result.segment_count },
          'Uniquify-render: variant completed',
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await db.uniqueVariant.update({
          where: { id: variantId },
          data: { status: 'failed', error: errorMsg },
        });
        await uniquifyStateQueue.add(
          `uniquify-state-fail-${variantId}`,
          { uniquifyJobId, variantId, tenantId, status: 'failed', error: errorMsg } satisfies UniquifyStateJobPayload,
          QUEUES['uniquify-state'].defaultJobOptions,
        );
        throw err;
      }
    },
    {
      connection,
      concurrency: QUEUES['uniquify-render'].concurrency,
    },
  );
}
