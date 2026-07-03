/**
 * Smart editor routes (apps/editor pipeline).
 *
 * Two-phase, two-product flow:
 *   1. Create a project, upload sources, run /analyze → storyboard (EditClip rows).
 *   2. User reviews/edits the storyboard, then /render → outputs. For
 *      mode=uniquify_source each output also becomes a SourceVideo (selectable in
 *      the uniquification pipeline).
 *
 * The heavy work runs in the orchestrator editor workers; these routes own the
 * DB rows + MinIO uploads and enqueue the jobs.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { editorAnalyzeQueue, editorRenderQueue } from '../lib/queues';
import { StoragePaths } from '@kmmzavod/storage';
import { logger } from '../logger';
import type { EditorAnalyzeJobPayload, EditorRenderJobPayload } from '@kmmzavod/queue';

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(['uniquify_source', 'smart_montage']).default('smart_montage'),
  geometry: z.enum(['highlights', 'mix']).default('highlights'),
  aspect: z.enum(['9:16', '1:1', '16:9', '4:5']).default('9:16'),
  fps: z.number().int().min(15).max(60).default(30),
  smartCrop: z.boolean().default(true),
  audioMode: z.enum(['keep', 'replace']).default('keep'),
  subtitleStyle: z.enum(['none', 'default', 'tiktok', 'cinematic', 'minimal']).default('tiktok'),
  useVision: z.boolean().default(false),
  targetClipCount: z.number().int().min(1).max(30).default(5),
  targetClipSeconds: z.number().min(3).max(180).default(30),
  config: z.record(z.unknown()).optional(),
});

const updateClipSchema = z.object({
  included: z.boolean().optional(),
  title: z.string().max(200).optional(),
  order: z.number().int().min(0).optional(),
  // Storyboard editing: move clip boundaries / rewrite subtitle lines.
  segments: z.array(z.object({
    src_idx: z.number().int().min(0),
    start: z.number().min(0),
    end: z.number().positive(),
  })).min(1).max(50).optional(),
  subtitles: z.array(z.object({
    start: z.number().min(0),
    end: z.number().positive(),
    text: z.string().max(500),
  })).max(300).optional(),
});

// ── Subtitle mapping (mirror of editor select.map_clip_subtitles) ─────────────
// Projects the source transcripts onto the clip's output timeline so edited
// segment boundaries immediately refresh the proposed subtitles.

const TRANSITION_SEC = 0.35;

interface TWord { start: number; end: number; text: string }
interface TSeg { start: number; end: number; text: string; words?: TWord[] }
interface SegIn { src_idx: number; start: number; end: number; score?: number }

function mapSubtitles(segments: SegIn[], transcripts: TSeg[][]): Array<{
  start: number; end: number; text: string; words: TWord[];
}> {
  const lines: Array<{ start: number; end: number; text: string; words: TWord[] }> = [];
  let offset = 0;
  segments.forEach((seg, k) => {
    if (k > 0) offset -= TRANSITION_SEC;
    const transcript = transcripts[seg.src_idx] ?? [];
    for (const ts of transcript) {
      if (ts.end <= seg.start || ts.start >= seg.end) continue;
      const words = (ts.words ?? [])
        .filter((w) => w.end > seg.start && w.start < seg.end && w.text.trim())
        .map((w) => ({
          start: Math.round((offset + Math.max(w.start, seg.start) - seg.start) * 100) / 100,
          end: Math.round((offset + Math.min(w.end, seg.end) - seg.start) * 100) / 100,
          text: w.text.trim(),
        }));
      const text = words.length > 0 ? words.map((w) => w.text).join(' ') : ts.text.trim();
      if (!text) continue;
      lines.push({
        start: Math.round((offset + Math.max(ts.start, seg.start) - seg.start) * 100) / 100,
        end: Math.round((offset + Math.min(ts.end, seg.end) - seg.start) * 100) / 100,
        text,
        words,
      });
    }
    offset += seg.end - seg.start;
  });
  return lines;
}

export async function editorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ── Create project ──────────────────────────────────────────────────────────
  app.post('/projects', async (req, reply) => {
    const { tenantId, userId } = req.user;
    const body = createProjectSchema.parse(req.body);

    const project = await db.editProject.create({
      data: {
        tenantId,
        createdBy: userId,
        name: body.name,
        mode: body.mode,
        geometry: body.geometry,
        aspect: body.aspect,
        fps: body.fps,
        smartCrop: body.smartCrop,
        audioMode: body.audioMode,
        subtitleStyle: body.subtitleStyle,
        useVision: body.useVision,
        targetClipCount: body.targetClipCount,
        targetClipSeconds: body.targetClipSeconds,
        config: (body.config ?? {}) as object,
        status: 'draft',
      },
    });
    return reply.code(201).send(project);
  });

  // ── List projects ───────────────────────────────────────────────────────────
  app.get('/projects', async (req) => {
    const { tenantId } = req.user;
    const projects = await db.editProject.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sources: true, clips: true } } },
    });
    return { projects };
  });

  // ── Get project (+ sources + storyboard) ────────────────────────────────────
  app.get('/projects/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const project = await db.editProject.findFirst({
      where: { id, tenantId },
      include: {
        sources: { orderBy: { order: 'asc' } },
        clips: { orderBy: { order: 'asc' } },
      },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    // Presign thumbnails / outputs for ready clips.
    const clips = await Promise.all(
      project.clips.map(async (c) => ({
        ...c,
        thumbnailUrl: c.thumbnailKey
          ? await app.storage.presignedUrl(c.thumbnailKey, 3600).catch(() => null)
          : null,
        outputUrl: c.outputKey
          ? await app.storage.presignedUrl(c.outputKey, 3600).catch(() => null)
          : null,
      })),
    );
    return { ...project, clips };
  });

  // ── Upload a source video ───────────────────────────────────────────────────
  app.post('/projects/:id/sources/upload', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };

    const project = await db.editProject.findFirst({ where: { id: projectId, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'BadRequest', message: 'Файл не передан' });
    if (!data.mimetype.startsWith('video/')) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Допустим только видеофайл' });
    }

    const order = await db.editSource.count({ where: { projectId } });
    const source = await db.editSource.create({
      data: { projectId, storageKey: '', order },
    });

    const filename = data.filename || `source_${Date.now()}.mp4`;
    const storageKey = StoragePaths.editorSource(tenantId, projectId, source.id, filename);
    try {
      await app.storage.uploadStream(storageKey, data.file, undefined, { contentType: data.mimetype });
      if (data.file.truncated) {
        await db.editSource.delete({ where: { id: source.id } }).catch(() => {});
        return reply.code(413).send({ error: 'PayloadTooLarge', message: 'Файл превышает лимит' });
      }
      const updated = await db.editSource.update({ where: { id: source.id }, data: { storageKey } });
      return reply.code(201).send(updated);
    } catch (err) {
      logger.error({ err, sourceId: source.id }, 'Editor source upload failed');
      await db.editSource.delete({ where: { id: source.id } }).catch(() => {});
      return reply.code(500).send({ error: 'UploadFailed' });
    }
  });

  // ── Trigger analysis ────────────────────────────────────────────────────────
  app.post('/projects/:id/analyze', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };

    const project = await db.editProject.findFirst({
      where: { id: projectId, tenantId },
      include: { _count: { select: { sources: true } } },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });
    if (project._count.sources === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Нет загруженных источников' });
    }

    await db.editProject.update({ where: { id: projectId }, data: { status: 'analyzing', error: null } });
    await editorAnalyzeQueue.add(
      `editor-analyze-${projectId}`,
      { projectId, tenantId } satisfies EditorAnalyzeJobPayload,
    );
    return reply.code(202).send({ status: 'analyzing' });
  });

  // ── Edit a storyboard clip (include/exclude, title, order, segments, subs) ──
  app.patch('/projects/:id/clips/:clipId', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId, clipId } = req.params as { id: string; clipId: string };
    const body = updateClipSchema.parse(req.body);

    const clip = await db.editClip.findFirst({
      where: { id: clipId, project: { id: projectId, tenantId } },
    });
    if (!clip) return reply.code(404).send({ error: 'NotFound' });

    const edl = (clip.edl ?? {}) as Record<string, unknown>;
    let edlChanged = false;
    let durationSec: number | undefined;
    let transcriptSnippet: string | undefined;

    if (body.segments) {
      const sources = await db.editSource.findMany({
        where: { projectId }, orderBy: { order: 'asc' },
        select: { durationSec: true, analysis: true },
      });
      for (const s of body.segments) {
        if (s.src_idx >= sources.length) {
          return reply.code(400).send({ error: 'BadRequest', message: `Источник #${s.src_idx + 1} не существует` });
        }
        const max = Number(sources[s.src_idx].durationSec ?? Infinity);
        if (s.end <= s.start || s.end - s.start < 0.5 || s.end > max + 0.05) {
          return reply.code(400).send({ error: 'BadRequest', message: 'Некорректные границы сегмента' });
        }
      }
      edl.segments = body.segments.map((s) => ({ ...s, score: 0 }));
      // Boundaries moved → refresh proposed subtitles + snippet from the transcript.
      const transcripts = sources.map((s) =>
        (((s.analysis ?? {}) as Record<string, unknown>).transcript ?? []) as TSeg[]);
      const lines = mapSubtitles(body.segments, transcripts);
      edl.subtitles = lines;
      transcriptSnippet = lines.map((l) => l.text).join(' ').slice(0, 160);
      durationSec = Math.round(body.segments.reduce((a, s) => a + (s.end - s.start), 0) * 100) / 100;
      edlChanged = true;
    }

    if (body.subtitles) {
      // User-authored lines: no word timings (render spreads words evenly for karaoke).
      edl.subtitles = body.subtitles
        .filter((l) => l.text.trim() && l.end > l.start)
        .map((l) => ({ ...l, text: l.text.trim(), words: [] }));
      edlChanged = true;
    }

    const updated = await db.editClip.update({
      where: { id: clipId },
      data: {
        included: body.included ?? clip.included,
        title: body.title ?? clip.title,
        order: body.order ?? clip.order,
        ...(edlChanged ? { edl: edl as never } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(transcriptSnippet !== undefined ? { transcriptSnippet } : {}),
      },
    });
    return updated;
  });

  // ── Trigger render of confirmed clips ───────────────────────────────────────
  app.post('/projects/:id/render', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };

    const project = await db.editProject.findFirst({
      where: { id: projectId, tenantId },
      include: { _count: { select: { clips: { where: { included: true } } } } },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });
    if (project._count.clips === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Нет выбранных клипов' });
    }

    await db.editProject.update({ where: { id: projectId }, data: { status: 'rendering', error: null } });
    await editorRenderQueue.add(
      `editor-render-${projectId}`,
      { projectId, tenantId } satisfies EditorRenderJobPayload,
    );
    return reply.code(202).send({ status: 'rendering' });
  });

  // ── Rendered outputs ────────────────────────────────────────────────────────
  app.get('/projects/:id/outputs', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };

    const project = await db.editProject.findFirst({ where: { id: projectId, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    const clips = await db.editClip.findMany({
      where: { projectId, outputKey: { not: null } },
      orderBy: { order: 'asc' },
    });
    const outputs = await Promise.all(
      clips.map(async (c) => ({
        id: c.id,
        title: c.title,
        durationSec: c.durationSec,
        phash: c.phash,
        sourceVideoId: c.outputSourceVideoId,
        url: c.outputKey ? await app.storage.presignedUrl(c.outputKey, 3600).catch(() => null) : null,
        thumbnailUrl: c.thumbnailKey
          ? await app.storage.presignedUrl(c.thumbnailKey, 3600).catch(() => null)
          : null,
      })),
    );
    return { outputs };
  });

  // ── Delete project ──────────────────────────────────────────────────────────
  app.delete('/projects/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };
    const project = await db.editProject.findFirst({ where: { id, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });
    await db.editProject.delete({ where: { id } });
    return reply.code(204).send();
  });
}
