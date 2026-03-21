// Pipeline state worker — checks if all scenes are done; triggers composition or fails job
// Triggered after every scene stage completion (idempotent via BullMQ jobId dedup)

import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import { QUEUES, type PipelineStateJobPayload, type VideoComposeJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';

interface Deps {
  db:                PrismaClient;
  videoComposeQueue: Queue<VideoComposeJobPayload>;
  connection:        ConnectionOptions;
}

export function createPipelineStateWorker(deps: Deps): Worker {
  const { db, videoComposeQueue, connection } = deps;

  return new Worker<PipelineStateJobPayload>(
    QUEUES['pipeline-state'].name,
    async (job) => {
      const { jobId, sceneId, tenantId, completedStage } = job.data;

      // Mark the completed stage on the scene (belt-and-suspenders — worker already did this)
      const updateData =
        completedStage === 'avatar' ? { avatarDone: true } :
        completedStage === 'clip'   ? { clipDone:   true } :
                                      { imageDone:  true };

      await db.scene.update({ where: { id: sceneId }, data: updateData });

      // Check if ALL scenes for this job are fully done (including failed)
      const scenes = await db.scene.findMany({
        where:  { jobId },
        select: { type: true, avatarDone: true, clipDone: true, imageDone: true, status: true },
      });

      const allDone = scenes.every((s) => {
        if (s.type === 'avatar') return s.avatarDone || s.status === 'failed';
        if (s.type === 'clip')   return s.clipDone   || s.status === 'failed';
        if (s.type === 'image')  return s.imageDone  || s.status === 'failed';
        return true; // text/unknown scenes need no processing
      });

      if (!allDone) return; // wait for remaining scenes

      const anyFailed = scenes.some((s) => s.status === 'failed');

      // Look up videoId so we can update Video.status
      const jobRow = await db.job.findUnique({
        where:  { id: jobId },
        select: { videoId: true },
      });

      if (anyFailed) {
        // Some scenes permanently failed — mark the whole job/video as failed
        await db.$transaction([
          db.job.update({ where: { id: jobId }, data: { status: 'failed' } }),
          ...(jobRow?.videoId ? [
            db.video.update({ where: { id: jobRow.videoId }, data: { status: 'failed' } }),
          ] : []),
        ]);

        await db.jobEvent.create({
          data: { jobId, tenantId, stage: 'pipeline-state', status: 'failed', message: 'One or more scenes failed' },
        });
        return;
      }

      // All scenes completed successfully — enqueue video composition
      await db.$transaction([
        db.job.update({ where: { id: jobId }, data: { status: 'composing' } }),
        ...(jobRow?.videoId ? [
          db.video.update({ where: { id: jobRow.videoId }, data: { status: 'composing' } }),
        ] : []),
      ]);

      await db.jobEvent.create({
        data: { jobId, tenantId, stage: 'pipeline-state', status: 'completed', message: 'All scenes done, composing' },
      });

      const payload: VideoComposeJobPayload = { jobId, tenantId };
      await videoComposeQueue.add(
        `compose:${jobId}`,
        payload,
        { ...QUEUES['video-compose'].defaultJobOptions, jobId: `compose:${jobId}` },
      );
    },
    { connection, concurrency: QUEUES['pipeline-state'].concurrency },
  );
}
