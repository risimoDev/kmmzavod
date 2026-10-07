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
import { editorAnalyzeQueue, editorRenderQueue, uniquifyAnalyzeQueue } from '../lib/queues';
import { StoragePaths } from '@kmmzavod/storage';
import { logger } from '../logger';
import type { EditorAnalyzeJobPayload, EditorRenderJobPayload, UniquifyAnalyzeJobPayload } from '@kmmzavod/queue';
import {
  writeScript, fishTts, fishSearchVoices, paceFor, voiceGender, voiceById, stripEmotionTags,
  FISH_VOICES, DEFAULT_VOICE_ID, LlmUnavailableError, FishError,
  type ScriptStyle, type VoiceInfo,
} from '@kmmzavod/ai';
import { getLlm, getFishConfig, getPaceTable, recordPace, aiStatus } from '../lib/ai';
import { config } from '../config';

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

/**
 * Editor products (what the user is making) → engine settings:
 *   uniquify_one   — K distinct re-edits of ONE video, raw material for uniquify
 *   uniquify_multi — K distinct mixes of SEVERAL videos, raw material for uniquify
 *   smart_montage  — finished video (highlights or mix) with subtitles
 */
const PRODUCTS = ['uniquify_one', 'uniquify_multi', 'smart_montage'] as const;
const PACES = ['calm', 'normal', 'fast'] as const;

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

const createProjectSchema = z.object({
  name: z.string().min(1).max(200),
  product: z.enum(PRODUCTS).optional(),
  variantCount: z.number().int().min(1).max(10).optional(),
  pace: z.enum(PACES).optional(),
  hookFirst: z.boolean().optional(),
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
  variantCount: z.number().int().min(1).max(10).optional(),
  pace: z.enum(PACES).optional(),
  hookFirst: z.boolean().optional(),
  geometry: z.enum(['highlights', 'mix']).optional(),
  aspect: z.enum(['9:16', '1:1', '16:9', '4:5']).optional(),
  fps: z.number().int().min(15).max(60).optional(),
  targetClipCount: z.number().int().min(1).max(30).optional(),
  subtitleStyle: z.enum(SUBTITLE_STYLES).optional(),
  audioMode: z.enum(['keep', 'replace']).optional(),
  smartCrop: z.boolean().optional(),
  targetClipSeconds: z.number().min(3).max(180).optional(),
  voiceId: z.string().optional(),
  productInfo: z.string().max(3000).optional(),
  ctaType: z.enum(['article', 'direct', 'auto']).optional(),
  directWord: z.string().max(50).optional(),
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

/** Output length of a storyboard clip (rendered duration, else EDL math). */
function clipSeconds(clip: { durationSec: unknown; edl: unknown }): number {
  const rendered = Number(clip.durationSec);
  if (rendered > 0) return Math.round(rendered * 10) / 10;
  const edl = (clip.edl ?? {}) as { segments?: { start: number; end: number }[]; transitions?: boolean };
  const segs = edl.segments ?? [];
  const sum = segs.reduce((t, s) => t + Math.max(0, Number(s.end) - Number(s.start)), 0)
    - (edl.transitions ? 0.35 * Math.max(0, segs.length - 1) : 0);
  return Math.max(5, Math.round(sum * 10) / 10);
}

/** Target length for a project-level script: average included clip, else the project target. */
function projectSeconds(project: { clips: { included: boolean; durationSec: unknown; edl: unknown }[]; targetClipSeconds: unknown }): number {
  const inc = project.clips.filter((c) => c.included);
  if (inc.length) return Math.round(inc.reduce((t, c) => t + clipSeconds(c), 0) / inc.length);
  return Math.round(Number(project.targetClipSeconds) || 30);
}

/** Map AI-layer failures to precise HTTP answers the studio can show as-is. */
function sendAiError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof LlmUnavailableError) {
    return reply.code(503).send({ error: 'AiUnavailable', message: err.message });
  }
  if (err instanceof FishError) {
    const code = err.kind === 'no_key' ? 400 : err.kind === 'voice_not_found' ? 422 : err.kind === 'quota' ? 402 : 502;
    return reply.code(code).send({ error: 'FishAudio', kind: err.kind, message: err.message });
  }
  logger.error({ err: (err as Error)?.message }, 'AI studio error');
  return reply.code(502).send({ error: 'AiError', message: (err as Error)?.message ?? 'Ошибка AI' });
}

export async function editorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ── Create project ──────────────────────────────────────────────────────────
  app.post('/projects', async (req, reply) => {
    const { tenantId, userId } = req.user;
    const body = createProjectSchema.parse(req.body);

        const wsProjectId = body.workspaceProjectId || ((body.config as any)?.workspaceProjectId as string | undefined);
        // Uniquify products are always mixes of raw material (mode/geometry are
        // implied by the product, not left to the client).
        const isUniquifyProduct = body.product === 'uniquify_one' || body.product === 'uniquify_multi';
        const montageOptions = {
          ...(body.product ? { product: body.product } : {}),
          variantCount: body.variantCount ?? (isUniquifyProduct ? 3 : 1),
          pace: body.pace ?? 'normal',
          hookFirst: body.hookFirst ?? true,
          seed: randomSeed(),
        };
        const project = await db.editProject.create({
          data: {
            tenantId,
            createdBy: userId,
            name: body.name,
            mode: isUniquifyProduct ? 'uniquify_source' : body.mode,
            geometry: isUniquifyProduct ? 'mix' : body.geometry,
            aspect: body.aspect,
            fps: body.fps,
            smartCrop: body.smartCrop,
            audioMode: body.audioMode,
            subtitleStyle: body.subtitleStyle,
            useVision: body.useVision,
            targetClipCount: body.targetClipCount,
            targetClipSeconds: body.targetClipSeconds,
            config: ({
              ...(body.config ?? {}),
              ...montageOptions,
              ...(wsProjectId ? { workspaceProjectId: wsProjectId } : {}),
            }) as object,
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

  const presignVoice = async (key: unknown) =>
    typeof key === 'string' && key ? app.storage.presignedUrl(key, 3600).catch(() => null) : null;

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
          // Per-clip AI voiceover (AI studio) — playable link for the storyboard/studio.
          voiceoverUrl: await presignVoice((c.edl as any)?.voiceover?.key),
        })),
      ),
    ]);
    const cfg = (project.config as Record<string, unknown>) || {};
    return { ...project, sources, clips, voiceoverUrl: await presignVoice(cfg.voiceoverKey) };
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
    } catch (err: any) {
      try { data.file.resume(); } catch {}
      logger.error({ err, sourceId: source.id }, 'Editor source upload failed');
      await db.editSource.delete({ where: { id: source.id } }).catch(() => {});
      const detail = err?.message ? `: ${err.message}` : '';
      return reply.code(500).send({ error: 'UploadFailed', message: `Ошибка при сохранении видео${detail}` });
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

    // «🎲 Другие варианты»: a fresh seed gives a different storyboard; cached
    // source analyses make the re-roll take seconds, not minutes.
    const { reroll } = z.object({ reroll: z.boolean().optional() }).parse(req.body ?? {});
    const cfg = (project.config as Record<string, unknown>) || {};
    await db.editProject.update({
      where: { id: projectId },
      data: {
        status: 'analyzing',
        error: null,
        ...(reroll || typeof cfg.seed !== 'number' ? { config: { ...cfg, seed: randomSeed() } as object } : {}),
      },
    });
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
      // Voiceover mixes join shots with 0.35s xfades (mirror of editor TRANSITION_SEC).
      const lines = mapSubtitles(body.segments, transcripts, edl.transitions === true ? 0.35 : 0);
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
        config: {
          ...currentConfig,
          ...(body.config ?? {}),
          ...(body.voiceId !== undefined ? { voiceId: body.voiceId } : {}),
          ...(body.productInfo !== undefined ? { productInfo: body.productInfo } : {}),
          ...(body.ctaType !== undefined ? { ctaType: body.ctaType } : {}),
          ...(body.directWord !== undefined ? { directWord: body.directWord } : {}),
          ...(body.variantCount !== undefined ? { variantCount: body.variantCount } : {}),
          ...(body.pace !== undefined ? { pace: body.pace } : {}),
          ...(body.hookFirst !== undefined ? { hookFirst: body.hookFirst } : {}),
        } as object,
      },
    });
    return updated;
  });

  // ── Presets & Voices ────────────────────────────────────────────────────────
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

  // ── AI studio: provider status, voices, voice preview ──────────────────────
  app.get('/ai/status', async () => aiStatus());

  const listVoices = async (req: { query: unknown }) => {
    const q = z.object({ query: z.string().max(100).optional() }).parse(req.query ?? {});
    const fish = await getFishConfig();
    const community = q.query && fish.apiKey
      ? await fishSearchVoices(fish, { title: q.query, language: 'ru' }).catch(() => [] as VoiceInfo[])
      : [];
    return { voices: FISH_VOICES, community, configured: Boolean(fish.apiKey) };
  };
  app.get('/voices', listVoices);
  app.get('/projects/voices', listVoices);

  /** Short sample of a voice (cached in storage per voice+speed). */
  app.post('/ai/voice-preview', async (req, reply) => {
    const body = z.object({
      voiceId: z.string().min(1).max(100),
      speed: z.number().min(0.5).max(2).default(1),
    }).parse(req.body ?? {});
    const key = `ai/voice-previews/${body.voiceId.replace(/[^\w-]/g, '')}@${body.speed.toFixed(2)}.mp3`;
    if (!(await app.storage.exists(key).catch(() => false))) {
      const text = voiceById(body.voiceId)?.previewText
        || 'Привет! Так звучит этот голос. Послушайте и выберите подходящий для ролика.';
      try {
        const tts = await fishTts(await getFishConfig(), { text, voiceId: body.voiceId, speed: body.speed });
        await app.storage.uploadBuffer(key, tts.audio, { contentType: 'audio/mpeg' });
      } catch (err) {
        return sendAiError(reply, err);
      }
    }
    return { audioUrl: await app.storage.presignedUrl(key, 3600) };
  });

  // ── AI script (per clip or per project) ─────────────────────────────────────
  app.post('/projects/:id/generate-script', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };
    const body = z.object({
      clipId: z.string().uuid().optional(),
      style: z.enum(['blogger', 'story', 'review', 'hype', 'educational', 'sales', 'humor', 'minimal']).default('blogger'),
      targetSeconds: z.number().min(5).max(180).optional(),
      productName: z.string().max(200).optional(),
      productInfo: z.string().max(3000).optional(),
      audience: z.string().max(300).optional(),
      ctaType: z.enum(['article', 'direct', 'auto', 'none']).default('article'),
      directWord: z.string().max(50).optional(),
      mode: z.enum(['generate', 'fit', 'rewrite']).default('generate'),
      currentScript: z.string().max(5000).optional(),
      measuredSeconds: z.number().positive().max(600).optional(),
      voiceId: z.string().max(100).optional(),
      speed: z.number().min(0.5).max(2).optional(),
      captionsCount: z.number().int().min(1).max(30).default(3),
      useSourceTranscript: z.boolean().default(true),
    }).parse(req.body ?? {});

    const project = await db.editProject.findFirst({
      where: { id, tenantId },
      include: { sources: { orderBy: { order: 'asc' } }, clips: { orderBy: { order: 'asc' } } },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });
    const clip = body.clipId ? project.clips.find((c) => c.id === body.clipId) : undefined;
    if (body.clipId && !clip) return reply.code(404).send({ error: 'NotFound', message: 'Клип не найден' });

    const cfg = (project.config as Record<string, unknown>) || {};
    const seconds = body.targetSeconds ?? (clip ? clipSeconds(clip) : projectSeconds(project));
    const voiceId = body.voiceId ?? (typeof cfg.voiceId === 'string' ? cfg.voiceId : DEFAULT_VOICE_ID);
    const speed = body.speed ?? (typeof cfg.voiceSpeed === 'number' ? cfg.voiceSpeed : 1);
    const wps = paceFor(await getPaceTable(), voiceId, speed);
    const history = Array.isArray(cfg.scriptHistory) ? (cfg.scriptHistory as string[]) : [];

    // What is actually said in the footage helps ground the script (keep-audio sources).
    let sourceTranscript = '';
    if (body.useSourceTranscript) {
      sourceTranscript = (clip?.transcriptSnippet ?? '') || project.sources
        .map((s) => {
          const t = ((s.analysis as any) ?? {}).transcript;
          return Array.isArray(t) ? t.map((x: any) => x?.text ?? '').join(' ') : '';
        })
        .filter(Boolean)
        .join(' ')
        .slice(0, 1500);
    }

    let result;
    try {
      result = await writeScript(await getLlm(), {
        product: body.productName?.trim() || project.name,
        productInfo: body.productInfo?.trim() || (typeof cfg.productInfo === 'string' ? cfg.productInfo : undefined),
        audience: body.audience,
        style: body.style as ScriptStyle,
        seconds,
        wps,
        narrator: voiceGender(voiceId),
        cta: { type: body.ctaType, word: body.directWord },
        avoidHooks: history,
        sourceTranscript: sourceTranscript || undefined,
        captionsCount: body.captionsCount,
        mode: body.mode,
        currentScript: body.currentScript,
        measuredSeconds: body.measuredSeconds,
        allowTemplate: true, // manual studio: a template beats an error, and it is labelled
      });
    } catch (err) {
      return sendAiError(reply, err);
    }

    const scriptRecord = {
      text: result.script, hook: result.hook, title: result.title, captions: result.captions,
      style: body.style, provider: result.provider, model: result.model, at: new Date().toISOString(),
    };
    if (clip) {
      const edl = (clip.edl ?? {}) as Record<string, unknown>;
      await db.editClip.update({ where: { id: clip.id }, data: { edl: { ...edl, script: scriptRecord } as object } });
    }
    await db.editProject.update({
      where: { id },
      data: {
        config: {
          ...cfg,
          ...(body.productInfo?.trim() ? { productInfo: body.productInfo.trim() } : {}),
          ctaType: body.ctaType,
          ...(body.directWord ? { directWord: body.directWord } : {}),
          scriptStyle: body.style,
          scriptHistory: [result.hook, ...history.filter((h) => h !== result.hook)].slice(0, 20),
          ...(!clip ? {
            generatedScript: result.script, scriptHook: result.hook, scriptTitle: result.title,
            socialCaptions: result.captions, aiModelUsed: `${result.provider}/${result.model}`,
          } : {}),
        } as object,
      },
    });

    return { ...result, targetSeconds: seconds, wps, clipId: clip?.id ?? null };
  });

  // ── AI voiceover (per clip or per project) ─────────────────────────────────
  app.post('/projects/:id/generate-voice', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId } = req.params as { id: string };
    const body = z.object({
      text: z.string().min(1).max(5000),
      voiceId: z.string().max(100).optional(),
      speed: z.number().min(0.5).max(2).default(1),
      volume: z.number().min(-20).max(20).default(0),
      clipId: z.string().uuid().optional(),
    }).parse(req.body ?? {});

    const project = await db.editProject.findFirst({ where: { id: projectId, tenantId }, include: { clips: true } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });
    const clip = body.clipId ? project.clips.find((c) => c.id === body.clipId) : undefined;
    if (body.clipId && !clip) return reply.code(404).send({ error: 'NotFound', message: 'Клип не найден' });
    const voiceId = body.voiceId || DEFAULT_VOICE_ID;

    let tts;
    try {
      tts = await fishTts(await getFishConfig(), { text: body.text, voiceId, speed: body.speed, volume: body.volume });
    } catch (err) {
      return sendAiError(reply, err);
    }
    const storageKey = `tenants/${tenantId}/editor/${projectId}/voice/${clip ? clip.id : 'project'}-${Date.now()}.mp3`;
    await app.storage.uploadBuffer(storageKey, tts.audio, { contentType: 'audio/mpeg' });
    await recordPace(voiceId, body.speed, tts.words, tts.durationSec);

    const record = {
      key: storageKey, text: body.text, voiceId, speed: body.speed,
      durationSec: tts.durationSec, model: tts.model, at: new Date().toISOString(),
    };
    const cfg = (project.config as Record<string, unknown>) || {};
    if (clip) {
      const edl = (clip.edl ?? {}) as Record<string, unknown>;
      await db.editClip.update({ where: { id: clip.id }, data: { edl: { ...edl, voiceover: record } as object } });
      await db.editProject.update({ where: { id: projectId }, data: { config: { ...cfg, voiceId, voiceSpeed: body.speed } as object } });
    } else {
      await db.editProject.update({
        where: { id: projectId },
        data: {
          audioMode: 'replace',
          config: {
            ...cfg, voiceoverKey: storageKey, voiceId, voiceSpeed: body.speed, voiceVolume: body.volume,
            voiceoverText: body.text, voiceoverCleanText: stripEmotionTags(body.text), voiceoverDuration: tts.durationSec,
          } as object,
        },
      });
    }

    const target = clip ? clipSeconds(clip) : projectSeconds(project);
    return {
      storageKey,
      audioUrl: await app.storage.presignedUrl(storageKey, 3600),
      durationSec: tts.durationSec,
      targetSeconds: target,
      diffSec: Math.round((tts.durationSec - target) * 10) / 10,
      words: tts.words,
      wps: Math.round(tts.wps * 100) / 100,
      model: tts.model,
      clipId: clip?.id ?? null,
      cleanText: stripEmotionTags(body.text),
      status: 'ready',
    };
  });

  /** Remove a clip's AI voiceover (the clip renders with the project audio again). */
  app.delete('/projects/:id/clips/:clipId/voiceover', async (req, reply) => {
    const { tenantId } = req.user;
    const { id: projectId, clipId } = req.params as { id: string; clipId: string };
    const clip = await db.editClip.findFirst({ where: { id: clipId, project: { id: projectId, tenantId } } });
    if (!clip) return reply.code(404).send({ error: 'NotFound' });
    const { voiceover: _drop, ...edl } = (clip.edl ?? {}) as Record<string, unknown>;
    await db.editClip.update({ where: { id: clipId }, data: { edl: edl as object } });
    return { ok: true };
  });

  /** Remove the project-level voiceover. */
  app.delete('/projects/:id/voiceover', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };
    const project = await db.editProject.findFirst({ where: { id, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });
    const { voiceoverKey: _k, voiceoverText: _t, voiceoverCleanText: _c, voiceoverDuration: _d, ...cfg } =
      (project.config as Record<string, unknown>) || {};
    await db.editProject.update({ where: { id }, data: { audioMode: 'keep', config: cfg as object } });
    return { ok: true };
  });

  // ── Send rendered masters to uniquification (one UniquifyJob per master) ──
  app.post('/projects/:id/send-to-uniquify', async (req, reply) => {
    const { tenantId, userId } = req.user;
    const { id: projectId } = req.params as { id: string };
    const body = z.object({
      variantCount: z.number().int().min(1).max(100).default(5),
      stealthLevel: z.enum(['standard', 'maximum']).default('maximum'),
      targetPlatforms: z.array(z.enum(['tiktok', 'instagram', 'youtube_shorts', 'postbridge'])).default([]),
      clipIds: z.array(z.string().uuid()).optional(),
    }).parse(req.body ?? {});

    const project = await db.editProject.findFirst({ where: { id: projectId, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });
    const clips = await db.editClip.findMany({
      where: {
        projectId,
        outputSourceVideoId: { not: null },
        ...(body.clipIds?.length ? { id: { in: body.clipIds } } : {}),
      },
      orderBy: { order: 'asc' },
    });
    if (clips.length === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Нет отрендеренных роликов — сначала запустите рендер' });
    }

    const jobs: { clipId: string; uniquifyJobId: string; title: string }[] = [];
    for (const clip of clips) {
      const uj = await db.uniquifyJob.create({
        data: {
          tenantId,
          sourceVideoId: clip.outputSourceVideoId!,
          createdBy: userId,
          status: 'pending',
          variantCount: body.variantCount,
          targetPlatforms: body.targetPlatforms as any,
          config: {
            // The master keeps its own sound/subtitles; uniquify only perturbs it.
            mode: 'preserve_context',
            stealthLevel: body.stealthLevel,
            enableSubtitles: false,
            enableBgm: false,
            aspectRatio: project.aspect,
            fps: project.fps,
            language: 'ru',
            targetSeconds: Math.round(Number(clip.durationSec ?? project.targetClipSeconds)),
            editProjectId: projectId,
          } as object,
        },
      });
      await uniquifyAnalyzeQueue.add(`uniquify-analyze-${uj.id}`, {
        sourceVideoId: clip.outputSourceVideoId!,
        tenantId,
        uniquifyJobId: uj.id,
      } satisfies UniquifyAnalyzeJobPayload);
      jobs.push({ clipId: clip.id, uniquifyJobId: uj.id, title: clip.title });
    }
    await db.editProject.update({
      where: { id: projectId },
      data: { config: { ...((project.config as object) ?? {}), uniquifyJobIds: jobs.map((j) => j.uniquifyJobId) } as object },
    });
    return reply.code(201).send({ jobs, totalVariants: jobs.length * body.variantCount });
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

