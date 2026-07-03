/**
 * Editor-analyze worker (smart cutting / montage pipeline).
 *
 * Runs once per EditProject: presigns every source, calls the editor /analyze
 * endpoint (probe + scene/energy/beat + Whisper + face/motion + GPTunnel re-rank),
 * then persists per-source analysis and the proposed storyboard (EditClip rows)
 * and flips the project to `ready` for the user to review/edit before render.
 */

import { Worker, type ConnectionOptions } from 'bullmq';
import { QUEUES, type EditorAnalyzeJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { MinioStorageClient } from '@kmmzavod/storage';
import { logger } from '../logger';
import { editorService, describeEditorError, type EditMode, type EditGeometry } from '../services/editor';

interface Deps {
  db: PrismaClient;
  storage: MinioStorageClient;
  connection: ConnectionOptions;
}

export function createEditorAnalyzeWorker(deps: Deps): Worker {
  const { db, storage, connection } = deps;

  return new Worker<EditorAnalyzeJobPayload>(
    QUEUES['editor-analyze'].name,
    async (job) => {
      const { projectId, tenantId } = job.data;
      logger.info({ projectId }, 'Editor-analyze: starting');

      const project = await db.editProject.findUniqueOrThrow({ where: { id: projectId } });
      const sources = await db.editSource.findMany({
        where: { projectId },
        orderBy: { order: 'asc' },
      });
      if (sources.length === 0) throw new Error('editor-analyze: project has no sources');

      await db.editProject.update({ where: { id: projectId }, data: { status: 'analyzing', error: null } });

      try {
        // Presign sources (internal http://minio:9000 URLs are reachable on the backend network).
        const sourceUrls = await Promise.all(
          sources.map((s) => storage.presignedUrl(s.storageKey, 3600)),
        );

        const result = await editorService.analyze({
          projectId,
          tenantId,
          mode: project.mode as EditMode,
          geometry: project.geometry as EditGeometry,
          sourceUrls,
          useVision: project.useVision,
          targetClipCount: project.targetClipCount,
          targetClipSeconds: Number(project.targetClipSeconds),
        });

        // Upload storyboard thumbnails (editor returns them as base64) and strip
        // the heavy payload from the EDL before it goes into the DB.
        const thumbKeys: (string | null)[] = await Promise.all(
          result.clips.map(async (c, i) => {
            if (!c.thumb_b64) return null;
            const key = `tenants/${tenantId}/editor/${projectId}/thumbs/clip_${String(i).padStart(3, '0')}.jpg`;
            try {
              await storage.uploadBuffer(key, Buffer.from(c.thumb_b64, 'base64'), {
                contentType: 'image/jpeg',
              });
              return key;
            } catch (e) {
              logger.warn({ projectId, i, err: (e as Error).message }, 'Editor-analyze: thumb upload failed');
              return null;
            } finally {
              delete (c as { thumb_b64?: string | null }).thumb_b64;
            }
          }),
        );

        await db.$transaction([
          ...sources.map((s, i) =>
            db.editSource.update({
              where: { id: s.id },
              data: {
                analysis: (result.sources[i] ?? {}) as unknown as any,
                durationSec: result.sources[i]?.duration_sec ?? null,
                width: result.sources[i]?.width ?? null,
                height: result.sources[i]?.height ?? null,
                fps: result.sources[i]?.fps ?? null,
              },
            }),
          ),
          // Replace any previous storyboard, then recreate from the new EDL.
          db.editClip.deleteMany({ where: { projectId } }),
          ...result.clips.map((c, order) =>
            db.editClip.create({
              data: {
                projectId,
                title: c.title ?? '',
                order: c.order ?? order,
                included: c.included !== false,
                score: c.segments?.[0]?.score ?? 0,
                edl: c as unknown as any,
                transcriptSnippet: c.transcript_snippet ?? null,
                thumbnailKey: thumbKeys[order],
              },
            }),
          ),
          db.editProject.update({ where: { id: projectId }, data: { status: 'ready' } }),
        ]);

        logger.info({ projectId, clips: result.clips.length }, 'Editor-analyze: complete (ready for review)');
      } catch (err: unknown) {
        const errorMsg = err && typeof err === 'object' && 'isAxiosError' in err
          ? describeEditorError(err)
          : err instanceof Error ? err.message : String(err);
        logger.error({ projectId, err: errorMsg }, 'Editor-analyze: failed');
        await db.editProject.update({ where: { id: projectId }, data: { status: 'failed', error: errorMsg } });
        throw err;
      }
    },
    {
      connection,
      concurrency: QUEUES['editor-analyze'].concurrency,
    },
  );
}
