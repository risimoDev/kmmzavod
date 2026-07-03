/**
 * Editor-render worker (smart cutting / montage pipeline).
 *
 * Renders the user-confirmed (included) clips of an EditProject: presigns the
 * sources (+ optional shared voiceover / BGM for audio_mode=replace), calls the
 * editor /render endpoint, persists output keys + metadata onto the EditClip rows,
 * and — for mode=uniquify_source — promotes each output to a SourceVideo so it is
 * immediately selectable in the uniquification pipeline.
 */

import { Worker, type ConnectionOptions } from 'bullmq';
import { QUEUES, type EditorRenderJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import type { MinioStorageClient } from '@kmmzavod/storage';
import { logger } from '../logger';
import {
  editorService, describeEditorError,
  type EditMode, type EditAudioMode, type EditAspect, type EdlClip,
} from '../services/editor';

interface Deps {
  db: PrismaClient;
  storage: MinioStorageClient;
  connection: ConnectionOptions;
}

export function createEditorRenderWorker(deps: Deps): Worker {
  const { db, storage, connection } = deps;

  return new Worker<EditorRenderJobPayload>(
    QUEUES['editor-render'].name,
    async (job) => {
      const { projectId, tenantId } = job.data;
      logger.info({ projectId }, 'Editor-render: starting');

      const project = await db.editProject.findUniqueOrThrow({ where: { id: projectId } });
      const sources = await db.editSource.findMany({ where: { projectId }, orderBy: { order: 'asc' } });
      const clipRows = await db.editClip.findMany({
        where: { projectId, included: true },
        orderBy: { order: 'asc' },
      });
      if (clipRows.length === 0) throw new Error('editor-render: no included clips');

      await db.editProject.update({ where: { id: projectId }, data: { status: 'rendering', error: null } });

      try {
        const config = (project.config ?? {}) as Record<string, unknown>;
        const sourceUrls = await Promise.all(sources.map((s) => storage.presignedUrl(s.storageKey, 3600)));

        const voiceoverKey = typeof config.voiceoverKey === 'string' ? config.voiceoverKey : undefined;
        const bgmKey = typeof config.bgmKey === 'string' ? config.bgmKey : undefined;
        const voiceoverUrl = voiceoverKey ? await storage.presignedUrl(voiceoverKey, 3600) : null;
        const bgmUrl = bgmKey ? await storage.presignedUrl(bgmKey, 3600) : null;

        const clips: EdlClip[] = clipRows.map((row, i) => {
          const edl = (row.edl ?? {}) as Partial<EdlClip>;
          return {
            title: row.title || edl.title || `Clip ${i + 1}`,
            included: true,
            order: row.order,
            segments: edl.segments ?? [],
            transcript_snippet: edl.transcript_snippet ?? row.transcriptSnippet ?? '',
            subtitles: edl.subtitles ?? null,
          };
        });

        const result = await editorService.render({
          projectId,
          tenantId,
          mode: project.mode as EditMode,
          outputKeyPrefix: `tenants/${tenantId}/editor/${projectId}`,
          sourceUrls,
          clips,
          aspect: project.aspect as EditAspect,
          fps: project.fps,
          smartCrop: project.smartCrop,
          audioMode: project.audioMode as EditAudioMode,
          subtitleStyle: project.subtitleStyle,
          voiceoverUrl,
          bgmUrl,
        });

        // Persist outputs onto the included clip rows (aligned by index).
        for (let i = 0; i < result.clips.length; i++) {
          const out = result.clips[i];
          const row = clipRows[i];
          if (!row) continue;

          let outputSourceVideoId: string | null = null;
          if (project.mode === 'uniquify_source') {
            const sv = await db.sourceVideo.create({
              data: {
                tenantId,
                title: out.title || project.name,
                status: 'ready',
                storageKey: out.output_key,
                mimeType: 'video/mp4',
                fileSizeBytes: BigInt(out.file_size_bytes ?? 0),
                durationSec: out.duration_sec,
                width: out.width,
                height: out.height,
              },
            });
            outputSourceVideoId = sv.id;
          }

          await db.editClip.update({
            where: { id: row.id },
            data: {
              outputKey: out.output_key,
              thumbnailKey: out.thumbnail_key ?? null,
              durationSec: out.duration_sec,
              phash: out.phash ?? null,
              outputSourceVideoId,
            },
          });
        }

        await db.editProject.update({ where: { id: projectId }, data: { status: 'completed' } });
        logger.info({ projectId, rendered: result.clips.length }, 'Editor-render: complete');
      } catch (err: unknown) {
        const errorMsg = err && typeof err === 'object' && 'isAxiosError' in err
          ? describeEditorError(err)
          : err instanceof Error ? err.message : String(err);
        logger.error({ projectId, err: errorMsg }, 'Editor-render: failed');
        await db.editProject.update({ where: { id: projectId }, data: { status: 'failed', error: errorMsg } });
        throw err;
      }
    },
    {
      connection,
      concurrency: QUEUES['editor-render'].concurrency,
    },
  );
}
