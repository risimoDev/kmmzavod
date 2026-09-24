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
import { FishAudioService, FISH_AUDIO_VOICES } from '../services/fish-audio';
import { OpenRouterService, stripEmotionTags } from '../services/openrouter';

const SUBTITLE_STYLES = [
  'none',
  'default',
  'tiktok',
  'mrbeast',
  'neon_glow',
  'fire_hype',
  'single_word',
  'cinematic',
  'minimal',
] as const;

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(['uniquify_source', 'smart_montage']).default('smart_montage'),
  geometry: z.enum(['highlights', 'mix']).default('highlights'),
  aspect: z.enum(['9:16', '1:1', '16:9', '4:5']).default('9:16'),
  fps: z.number().int().min(15).max(60).default(30),
  smartCrop: z.boolean().default(true),
  audioMode: z.enum(['keep', 'replace']).default('keep'),
  subtitleStyle: z.enum(SUBTITLE_STYLES).default('tiktok'),
  useVision: z.boolean().default(false),
  targetClipCount: z.number().int().min(1).max(30).default(5),
  targetClipSeconds: z.number().min(3).max(180).default(30),
  workspaceProjectId: z.string().uuid().optional(),
  config: z.record(z.unknown()).optional(),
});

const patchProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  geometry: z.enum(['highlights', 'mix']).optional(),
  aspect: z.enum(['9:16', '1:1', '16:9', '4:5']).optional(),
  fps: z.number().int().min(15).max(60).optional(),
  targetClipCount: z.number().int().min(1).max(30).optional(),
  subtitleStyle: z.enum(SUBTITLE_STYLES).optional(),
  audioMode: z.enum(['keep', 'replace']).optional(),
  smartCrop: z.boolean().optional(),
  targetClipSeconds: z.number().min(3).max(180).optional(),
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

const createClipSchema = z.object({
  title: z.string().max(200).optional(),
  segments: z.array(z.object({
    src_idx: z.number().int().min(0),
    start: z.number().min(0),
    end: z.number().positive(),
  })).min(1).max(50),
});

const splitClipSchema = z.object({
  splitAtSec: z.number().positive(),
});

// ── Subtitle mapping (mirror of editor select.map_clip_subtitles) ─────────────
// Projects the source transcripts onto the clip's output timeline so edited
// segment boundaries immediately refresh the proposed subtitles.

interface TWord { start: number; end: number; text: string }
interface TSeg { start: number; end: number; text: string; words?: TWord[] }
interface SegIn { src_idx: number; start: number; end: number; score?: number }

function mapSubtitles(segments: SegIn[], transcripts: TSeg[][], transitionSec: number = 0): Array<{
  start: number; end: number; text: string; words: TWord[];
}> {
  const lines: Array<{ start: number; end: number; text: string; words: TWord[] }> = [];
  let offset = 0;
  segments.forEach((seg, k) => {
    if (k > 0 && transitionSec > 0) offset -= transitionSec;
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

        const wsProjectId = body.workspaceProjectId || ((body.config as any)?.workspaceProjectId as string | undefined);
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
            config: ({ ...(body.config ?? {}), ...(wsProjectId ? { workspaceProjectId: wsProjectId } : {}) }) as object,
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

    // Presign source videos, thumbnails, and outputs
    const [sources, clips] = await Promise.all([
      Promise.all(
        project.sources.map(async (s) => ({
          ...s,
          url: s.storageKey
            ? await app.storage.presignedUrl(s.storageKey, 3600).catch(() => null)
            : null,
        })),
      ),
      Promise.all(
        project.clips.map(async (c) => ({
          ...c,
          thumbnailUrl: c.thumbnailKey
            ? await app.storage.presignedUrl(c.thumbnailKey, 3600).catch(() => null)
            : null,
          outputUrl: c.outputKey
            ? await app.storage.presignedUrl(c.outputKey, 3600).catch(() => null)
            : null,
        })),
      ),
    ]);
    return { ...project, sources, clips };
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

  // ── Import sources from workspace project videos ───────────────────────────
  app.post('/projects/:id/sources/from-workspace-video', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };
    const body = z.object({
      sourceVideoIds: z.array(z.string().uuid()).min(1),
    }).parse(req.body);

    const project = await db.editProject.findFirst({ where: { id: projectId, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    const sourceVideos = await db.sourceVideo.findMany({
      where: { id: { in: body.sourceVideoIds }, tenantId },
    });
    if (sourceVideos.length === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Видео не найдены' });
    }

    const currentCount = await db.editSource.count({ where: { projectId } });
    const createdSources = await Promise.all(
      sourceVideos.map((sv, idx) =>
        db.editSource.create({
          data: {
            projectId,
            storageKey: sv.storageKey,
            order: currentCount + idx,
            durationSec: sv.durationSec,
            width: sv.width,
            height: sv.height,
            fps: sv.fps,
            analysis: (sv.sceneBreaks || sv.transcript) ? ({
              scene_breaks: sv.sceneBreaks,
              transcript: sv.transcript,
              audio_profile: sv.audioProfile,
            } as any) : undefined,
          },
        }),
      ),
    );

    return reply.code(201).send({ sources: createdSources });
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

    const thumbnailUrl = updated.thumbnailKey
      ? await app.storage.presignedUrl(updated.thumbnailKey, 3600).catch(() => null)
      : null;
    const outputUrl = updated.outputKey
      ? await app.storage.presignedUrl(updated.outputKey, 3600).catch(() => null)
      : null;

    return { ...updated, thumbnailUrl, outputUrl };
  });

  // ── Create a new manual storyboard clip ─────────────────────────────────────
  app.post('/projects/:id/clips', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };
    const body = createClipSchema.parse(req.body);

    const project = await db.editProject.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

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

    const maxOrder = await db.editClip.aggregate({
      where: { projectId },
      _max: { order: true },
    });
    const order = (maxOrder._max.order ?? -1) + 1;

    const transcripts = sources.map((s) =>
      (((s.analysis ?? {}) as Record<string, unknown>).transcript ?? []) as TSeg[]);
    const lines = mapSubtitles(body.segments, transcripts);
    const transcriptSnippet = lines.map((l) => l.text).join(' ').slice(0, 160);
    const durationSec = Math.round(body.segments.reduce((a, s) => a + (s.end - s.start), 0) * 100) / 100;

    const edl = {
      title: body.title || `Клип ${order + 1}`,
      order,
      segments: body.segments.map((s) => ({ ...s, score: 0 })),
      transcript_snippet: transcriptSnippet,
      subtitles: lines,
    };

    const clip = await db.editClip.create({
      data: {
        projectId,
        title: body.title || `Клип ${order + 1}`,
        order,
        included: true,
        score: 1.0,
        edl: edl as never,
        durationSec,
        transcriptSnippet,
      },
    });

    return reply.code(201).send(clip);
  });

  // ── Delete a storyboard clip ────────────────────────────────────────────────
  app.delete('/projects/:id/clips/:clipId', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId, clipId } = req.params as { id: string; clipId: string };

    const clip = await db.editClip.findFirst({
      where: { id: clipId, project: { id: projectId, tenantId } },
    });
    if (!clip) return reply.code(404).send({ error: 'NotFound' });

    await db.editClip.delete({ where: { id: clipId } });
    return reply.code(204).send();
  });

  // ── Split a storyboard clip at a timestamp ──────────────────────────────────
  app.post('/projects/:id/clips/:clipId/split', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId, clipId } = req.params as { id: string; clipId: string };
    const { splitAtSec } = splitClipSchema.parse(req.body);

    const clip = await db.editClip.findFirst({
      where: { id: clipId, project: { id: projectId, tenantId } },
    });
    if (!clip) return reply.code(404).send({ error: 'NotFound' });

    const edl = (clip.edl ?? {}) as { segments?: SegIn[] };
    const segments = edl.segments ?? [];
    if (segments.length === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'У клипа нет сегментов' });
    }

    const sources = await db.editSource.findMany({
      where: { projectId }, orderBy: { order: 'asc' },
      select: { durationSec: true, analysis: true },
    });
    const transcripts = sources.map((s) =>
      (((s.analysis ?? {}) as Record<string, unknown>).transcript ?? []) as TSeg[]);

    let accumulated = 0;
    let splitSegIdx = -1;
    let segSplitTime = 0;

    for (let i = 0; i < segments.length; i++) {
      const segDur = segments[i].end - segments[i].start;
      if (splitAtSec > accumulated && splitAtSec < accumulated + segDur) {
        splitSegIdx = i;
        segSplitTime = segments[i].start + (splitAtSec - accumulated);
        break;
      }
      accumulated += segDur;
    }

    if (splitSegIdx === -1) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Точка разреза должна быть внутри клипа' });
    }

    const segsPart1: SegIn[] = [
      ...segments.slice(0, splitSegIdx),
      { ...segments[splitSegIdx], end: Math.round(segSplitTime * 100) / 100 },
    ];
    const segsPart2: SegIn[] = [
      { ...segments[splitSegIdx], start: Math.round(segSplitTime * 100) / 100 },
      ...segments.slice(splitSegIdx + 1),
    ];

    const lines1 = mapSubtitles(segsPart1, transcripts);
    const dur1 = Math.round(segsPart1.reduce((a, s) => a + (s.end - s.start), 0) * 100) / 100;
    const lines2 = mapSubtitles(segsPart2, transcripts);
    const dur2 = Math.round(segsPart2.reduce((a, s) => a + (s.end - s.start), 0) * 100) / 100;

    await db.editClip.updateMany({
      where: { projectId, order: { gt: clip.order } },
      data: { order: { increment: 1 } },
    });

    const updated1 = await db.editClip.update({
      where: { id: clipId },
      data: {
        title: `${clip.title} (ч.1)`,
        durationSec: dur1,
        transcriptSnippet: lines1.map((l) => l.text).join(' ').slice(0, 160),
        edl: { ...edl, segments: segsPart1, subtitles: lines1 } as never,
      },
    });

    const created2 = await db.editClip.create({
      data: {
        projectId,
        title: `${clip.title} (ч.2)`,
        order: clip.order + 1,
        included: clip.included,
        score: clip.score,
        durationSec: dur2,
        transcriptSnippet: lines2.map((l) => l.text).join(' ').slice(0, 160),
        edl: { ...edl, segments: segsPart2, subtitles: lines2 } as never,
      },
    });

    return reply.code(200).send({ part1: updated1, part2: created2 });
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

  // ── Patch project settings ────────────────────────────────────────────────
  app.patch('/projects/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };
    const body = patchProjectSchema.parse(req.body);

    const project = await db.editProject.findFirst({ where: { id, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    const currentConfig = (project.config as Record<string, unknown>) || {};
    const updated = await db.editProject.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.geometry !== undefined ? { geometry: body.geometry } : {}),
        ...(body.aspect !== undefined ? { aspect: body.aspect } : {}),
        ...(body.fps !== undefined ? { fps: body.fps } : {}),
        ...(body.targetClipCount !== undefined ? { targetClipCount: body.targetClipCount } : {}),
        ...(body.subtitleStyle !== undefined ? { subtitleStyle: body.subtitleStyle } : {}),
        ...(body.audioMode !== undefined ? { audioMode: body.audioMode } : {}),
        ...(body.smartCrop !== undefined ? { smartCrop: body.smartCrop } : {}),
        ...(body.targetClipSeconds !== undefined ? { targetClipSeconds: body.targetClipSeconds } : {}),
        ...(body.config !== undefined ? { config: { ...currentConfig, ...body.config } as object } : {}),
      },
    });
    return updated;
  });

  // ── Presets & Voices ────────────────────────────────────────────────────────
  app.get('/voices', async (req) => {
    const query = (req.query as any) || {};
    const fishAudio = new FishAudioService(app.storage);
    const voices = await fishAudio.searchPublicVoices({
      apiKey: query.apiKey || (req.headers['x-fish-audio-key'] as string),
      query: query.query,
      language: query.language,
    });
    return { voices };
  });

  app.get('/projects/voices', async (req) => {
    const query = (req.query as any) || {};
    const fishAudio = new FishAudioService(app.storage);
    const voices = await fishAudio.searchPublicVoices({
      apiKey: query.apiKey || (req.headers['x-fish-audio-key'] as string),
      query: query.query,
      language: query.language,
    });
    return { voices };
  });

  app.get('/presets', async () => {
    return {
      subtitleStyles: [
        {
          id: 'tiktok',
          name: 'TikTok Classic',
          badge: 'Хит',
          description: 'Яркое жёлтое караоке на белом тексте, плотный контур, безопасная зона 18%.',
          highlightColor: '#FFE600',
          preview: 'Смотри ролик ДО КОНЦА',
        },
        {
          id: 'mrbeast',
          name: 'MrBeast Bouncy',
          badge: 'Вирусный',
          description: 'Электрический неон, массивный жирный шрифт, анимация отскока при произнесении.',
          highlightColor: '#00F0FF',
          preview: 'ЭТО ШОКИРУЕТ КАЖДОГО!',
        },
        {
          id: 'neon_glow',
          name: 'Cyberpunk Neon',
          badge: 'Стиль',
          description: 'Неоновое свечение Cyan/Pink с полупрозрачной подложкой.',
          highlightColor: '#00FFFF',
          preview: 'Тренды нового поколения',
        },
        {
          id: 'fire_hype',
          name: 'Fire Hype',
          badge: 'Драйв',
          description: 'Огненный градиент, акцентная подача для динамичных нарезок и юмора.',
          highlightColor: '#FF6600',
          preview: 'НЕВЕРОЯТНЫЙ РЕЗУЛЬТАТ',
        },
        {
          id: 'single_word',
          name: '1-Word Flash',
          badge: 'Удержание 100%',
          description: 'Ровно одно активное слово по центру экрана. Максимальный темп для коротких шортсов.',
          highlightColor: '#FFE600',
          preview: 'СЕКРЕТ',
        },
        {
          id: 'cinematic',
          name: 'Cinematic',
          badge: 'Кино',
          description: 'Элегантный сдержанный шрифт, нижняя треть кадра, мягкая тень.',
          highlightColor: '#FFFFFF',
          preview: 'История одного проекта...',
        },
        {
          id: 'minimal',
          name: 'Minimal Clean',
          badge: 'Минимал',
          description: 'Лаконичная аккуратная плашка с субтитрами без лишних эффектов.',
          highlightColor: '#CCCCCC',
          preview: 'Кратко и по делу',
        },
        {
          id: 'none',
          name: 'Без субтитров',
          badge: '',
          description: 'Видео рендерится без наложения субтитров.',
          highlightColor: '#888888',
          preview: '—',
        },
      ],
    };
  });

  // ── AI Script Generation (OpenRouter Free Cascade) ──────────────────────────
  app.post('/projects/:id/generate-script', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const project = await db.editProject.findFirst({
      where: { id, tenantId },
      include: { sources: { orderBy: { order: 'asc' } }, clips: { orderBy: { order: 'asc' } } },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    const schema = z.object({
      topic: z.string().min(1).max(500),
      style: z.enum(['hype', 'educational', 'story', 'sales', 'humor', 'minimal']).default('hype'),
      targetSeconds: z.number().min(5).max(180).optional(),
      productInfo: z.string().max(1000).optional(),
      useSourceTranscript: z.boolean().default(true),
      apiKey: z.string().optional(),
    });
    const body = schema.parse(req.body);

    let sourceTranscript = '';
    if (body.useSourceTranscript) {
      // Gather any recognized transcript snippets from sources
      const snippets = project.sources
        .map((s) => {
          const a = (s.analysis as any) || {};
          const t = a.transcript;
          if (Array.isArray(t) && t.length > 0) {
            return t.map((item: any) => item.text || '').join(' ');
          }
          return '';
        })
        .filter(Boolean);
      sourceTranscript = snippets.join(' ').slice(0, 2000);
    }

    const openRouter = new OpenRouterService();
    const result = await openRouter.generateScript({
      topic: body.topic,
      style: body.style,
      targetSeconds: body.targetSeconds || Number(project.targetClipSeconds) || 30,
      productInfo: body.productInfo,
      sourceTranscript,
      language: 'ru',
      variantCount: 3,
      apiKey: body.apiKey || (req.headers['x-openrouter-key'] as string),
    });

    // Save generated script into project config for convenience
    const currentConfig = (project.config as Record<string, unknown>) || {};
    await db.editProject.update({
      where: { id },
      data: {
        config: {
          ...currentConfig,
          generatedScript: result.script,
          scriptHook: result.hook,
          scriptTitle: result.title,
          socialCaptions: result.captions,
          aiModelUsed: result.modelUsed,
        } as object,
      },
    });

    return result;
  });

  // ── Fish Audio Voice Synthesis (s2.1-pro-free) ──────────────────────────────
  app.post('/projects/:id/generate-voice', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };

    const project = await db.editProject.findFirst({
      where: { id: projectId, tenantId },
      include: { clips: { orderBy: { order: 'asc' } } },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    const schema = z.object({
      text: z.string().min(1).max(3000),
      voiceId: z.string().optional(),
      speed: z.number().min(0.5).max(2.0).default(1.0),
      volume: z.number().min(-20).max(20).default(0),
      apiKey: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const fishAudio = new FishAudioService(app.storage);
    const destinationKey = `tenants/${tenantId}/editor/${projectId}/voiceover.mp3`;

    try {
      const { storageKey } = await fishAudio.ttsCreate({
        text: body.text,
        voiceId: body.voiceId,
        speed: body.speed,
        volume: body.volume,
        tenantId,
        destinationKey,
        apiKey: body.apiKey || (req.headers['x-fish-audio-key'] as string),
      });

      const presignedAudioUrl = await app.storage.presignedUrl(storageKey, 3600);
      const cleanSubText = stripEmotionTags(body.text);

      // Update project: set audioMode = 'replace', save voiceoverKey in config
      const currentConfig = (project.config as Record<string, unknown>) || {};
      await db.editProject.update({
        where: { id: projectId },
        data: {
          audioMode: 'replace',
          config: {
            ...currentConfig,
            voiceoverKey: storageKey,
            voiceId: body.voiceId,
            voiceSpeed: body.speed,
            voiceVolume: body.volume,
            voiceoverText: body.text,
            voiceoverCleanText: cleanSubText,
          } as object,
        },
      });

      // Also update transcript snippet of the first clip to reflect voiceover
      if (project.clips.length > 0) {
        const firstClip = project.clips[0];
        const clipEdl = (firstClip.edl as any) || {};
        await db.editClip.update({
          where: { id: firstClip.id },
          data: {
            transcriptSnippet: cleanSubText.slice(0, 200),
            edl: {
              ...clipEdl,
              transcript_snippet: cleanSubText.slice(0, 200),
            },
          },
        });
      }

      return {
        storageKey,
        audioUrl: presignedAudioUrl,
        voiceId: body.voiceId,
        cleanText: cleanSubText,
        status: 'ready',
      };
    } catch (err: any) {
      const isMissingKey = err.message?.includes('FISH_AUDIO_API_KEY_MISSING');
      logger.error({ err: err.message, projectId }, 'FishAudio TTS endpoint error');
      return reply.code(isMissingKey ? 400 : 502).send({
        error: isMissingKey ? 'FishAudioKeyMissing' : 'FishAudioError',
        message: err.message || 'Ошибка генерации озвучки через Fish Audio',
      });
    }
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

