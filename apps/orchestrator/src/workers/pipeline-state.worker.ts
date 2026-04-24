// Pipeline state worker — checks if all scenes are done; triggers composition or fails job
// Triggered after every scene stage completion (idempotent via BullMQ jobId dedup)

import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import { QUEUES, type PipelineStateJobPayload, type VideoComposeJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { publishProgress, calcSceneProgress } from '../lib/progress';
import { refundReserve } from '../lib/credits';

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

      // Check if ALL scenes for this job are fully done (including failed).
      // We also verify that the required asset URL is set (belt-and-suspenders):
      // if clipDone=true but clipUrl=null the asset isn't actually in MinIO yet.
      const scenes = await db.scene.findMany({
        where:  { jobId },
        select: {
          type: true,
          avatarDone: true, clipDone: true, imageDone: true,
          avatarUrl: true, clipUrl: true, imageUrl: true,
          status: true,
        },
      });

      type SceneRow = typeof scenes[number];
      const allDone = scenes.every((s: SceneRow) => {
        if (s.type === 'avatar') return (s.avatarDone && !!s.avatarUrl) || s.status === 'failed';
        if (s.type === 'clip')   return (s.clipDone   && !!s.clipUrl)   || s.status === 'failed';
        if (s.type === 'image')  return (s.imageDone  && !!s.imageUrl)  || s.status === 'failed';
        return true; // text/unknown scenes need no processing
      });

      // Публикуем промежуточный прогресс при каждом обновлении сцены
      const jobRow0 = await db.job.findUnique({ where: { id: jobId }, select: { videoId: true } });
      if (jobRow0?.videoId) {
        const pct = calcSceneProgress(scenes);
        const doneCount = scenes.filter((s: SceneRow) =>
          (s.type === 'avatar' && s.avatarDone) ||
          (s.type === 'clip' && s.clipDone) ||
          (s.type === 'image' && s.imageDone) ||
          s.status === 'completed' || s.status === 'failed'
        ).length;
        await publishProgress(
          tenantId, jobRow0.videoId, 'processing', 'progress',
          pct, `${doneCount}/${scenes.length} scenes done`,
        );
      }

      if (!allDone) return; // wait for remaining scenes

      const anyFailed = scenes.some((s: SceneRow) => s.status === 'failed');

      // Look up videoId so we can update Video.status
      const jobRow = await db.job.findUnique({
        where:  { id: jobId },
        select: { videoId: true, payload: true },
      });

      if (anyFailed) {
        // Some scenes permanently failed — mark the whole job/video as failed
        const failedScenes = scenes.filter((s: SceneRow) => s.status === 'failed');
        const failedSceneDetails = await db.scene.findMany({
          where: { jobId, status: 'failed' },
          select: { sceneIndex: true, type: true, error: true },
        });
        const errorSummary = failedSceneDetails
          .map((s) => `Scene ${s.sceneIndex} (${s.type}): ${s.error || 'unknown error'}`)
          .join('; ');
        const errorMsg = `${failedScenes.length} scene(s) failed: ${errorSummary}`;

        await db.$transaction([
          db.job.update({ where: { id: jobId }, data: { status: 'failed', error: errorMsg } }),
          ...(jobRow?.videoId ? [
            db.video.update({ where: { id: jobRow.videoId }, data: { status: 'failed', error: errorMsg } }),
          ] : []),
        ]);

        await db.jobEvent.create({
          data: { jobId, tenantId, stage: 'pipeline-state', status: 'failed', message: 'One or more scenes failed' },
        });

        if (jobRow?.videoId) {
          await publishProgress(tenantId, jobRow.videoId, 'pipeline', 'failed', 0, 'One or more scenes failed');
        }

        // Refund reserved credits on failure
        const jobPayload = jobRow?.payload as Record<string, unknown> | null;
        const reserved = typeof jobPayload?.estimatedCredits === 'number' ? jobPayload.estimatedCredits : 0;
        if (reserved > 0) {
          await refundReserve(db, { tenantId, jobId, reservedCredits: reserved });
        }
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

      if (jobRow?.videoId) {
        await publishProgress(tenantId, jobRow.videoId, 'composing', 'started', 87, 'All scenes done, composing video');
      }

      const payload: VideoComposeJobPayload = { jobId, tenantId };
      await videoComposeQueue.add(
        `compose:${jobId}`,
        payload,
        { ...QUEUES['video-compose'].defaultJobOptions, jobId: `compose-${jobId}` },
      );
    },
    { connection, concurrency: QUEUES['pipeline-state'].concurrency },
  );
}
