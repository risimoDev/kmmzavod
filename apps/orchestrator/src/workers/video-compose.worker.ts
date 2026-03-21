// Video compose worker — builds scene manifest and calls video-processor HTTP API

import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type VideoComposeJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { StoragePaths } from '@kmmzavod/storage';

interface Deps {
  db:                PrismaClient;
  videoProcessorUrl: string;
  connection:        ConnectionOptions;
}

export function createVideoComposeWorker(deps: Deps): Worker {
  const { db, videoProcessorUrl, connection } = deps;

  return new Worker<VideoComposeJobPayload>(
    QUEUES['video-compose'].name,
    async (job) => {
      const { jobId, tenantId } = job.data;

      const [scenes, jobRow] = await Promise.all([
        db.scene.findMany({ where: { jobId }, orderBy: { sceneIndex: 'asc' } }),
        db.job.findUniqueOrThrow({ where: { id: jobId }, select: { payload: true, videoId: true } }),
      ]);

      // Build scene manifest
      const sceneItems = scenes.map((s) => ({
        type: s.type,
        storage_key:
          s.type === 'avatar' ? s.avatarUrl! :
          s.type === 'clip'   ? s.clipUrl!   :
          s.type === 'image'  ? s.imageUrl!  : '',
        duration_sec: Number(s.durationSec ?? 3),
      }));

      // Reconstruct subtitle list from avatar scene scripts
      let cursor = 0;
      const subtitles = scenes
        .filter((s) => s.type === 'avatar' && s.script)
        .map((s) => {
          const start = cursor;
          const end   = start + Number(s.durationSec ?? 5);
          cursor = end;
          return { start_sec: start, end_sec: end, text: s.script! };
        });

      const outputKey = StoragePaths.finalVideo(tenantId, jobId);
      const payload   = jobRow.payload as Record<string, unknown>;

      // Call video-processor service
      const response = await axios.post(`${videoProcessorUrl}/compose`, {
        job_id:    jobId,
        tenant_id: tenantId,
        output_key: outputKey,
        scenes:    sceneItems,
        subtitles,
        settings:  (payload['settings'] as object) ?? {},
      }, { timeout: 600_000 }); // 10 min max

      const { duration_sec, file_size } = response.data as { duration_sec: number; file_size: number };

      await db.$transaction([
        db.job.update({
          where: { id: jobId },
          data:  { status: 'completed', completedAt: new Date() },
        }),
        ...(jobRow.videoId ? [
          db.video.update({
            where: { id: jobRow.videoId },
            data:  { status: 'completed', outputUrl: outputKey, durationSec: duration_sec, fileSizeBytes: BigInt(file_size ?? 0), completedAt: new Date() },
          }),
        ] : []),
      ]);

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'video-compose', status: 'completed', message: `${duration_sec.toFixed(1)}s video` },
      });
    },
    { connection, concurrency: QUEUES['video-compose'].concurrency },
  );
}
