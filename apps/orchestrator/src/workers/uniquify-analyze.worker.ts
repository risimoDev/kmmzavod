/**
 * Uniquify-analyze worker (montage pipeline).
 *
 * Runs ONCE per job and produces the SHARED creative assets, then fans out one
 * render job per variant. The expensive AI work happens here exactly once:
 *
 *   1. Probe the source clip(s).
 *   2. ONE GPT call  → voiceover script (from the title/description theme) + a
 *                      unique caption/hashtag set per variant.
 *   3. ONE TTS call  → the voiceover (stored job-level, reused by every variant).
 *   4. ONE Whisper run → subtitle lines timed to that voiceover.
 *   5. Create N variants and enqueue N montage renders. Each render differs only
 *      by its montage `seed`, background-music track and subtitle style — so the
 *      voice is identical, the edit/music are unique, and token spend is flat.
 */

import { Worker, Queue, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import {
  QUEUES,
  type UniquifyAnalyzeJobPayload,
  type UniquifyRenderJobPayload,
} from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger } from '../logger';
import { GptunnelService } from '../services/gptunnel';

interface Deps {
  db: PrismaClient;
  videoProcessorUrl: string;
  uniquifyRenderQueue: Queue<UniquifyRenderJobPayload>;
  gptunnelService: GptunnelService;
  connection: ConnectionOptions;
}

// Default GPTunnel TTS voice (ALEX — Russian). Valid IDs come from
// GET /v1/tts/voices; can be overridden per job via config.voiceId.
const DEFAULT_TTS_VOICE_ID = '65f4092eddc5862248a18111';

const SUBTITLE_STYLES = ['tiktok', 'cinematic', 'minimal', 'default'] as const;

/** Rough speech duration (sec) from a script — ~2.6 words/sec for Russian TTS. */
function estimateSpeechDuration(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(3, words / 2.6);
}

/**
 * Build subtitle lines from the script when Whisper is unavailable.
 * Splits into short chunks and distributes time by character proportion across
 * the voiceover length — not word-perfect, but always present and roughly synced.
 */
function buildSubtitlesFromScript(
  script: string,
  durationSec: number,
): Array<{ start_sec: number; end_sec: number; text: string }> {
  const words = script.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || durationSec <= 0) return [];

  const CHUNK = 6;
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += CHUNK) {
    chunks.push(words.slice(i, i + CHUNK).join(' '));
  }
  const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;

  const lines: Array<{ start_sec: number; end_sec: number; text: string }> = [];
  let t = 0;
  for (const text of chunks) {
    const dur = Math.max(0.6, (text.length / totalChars) * durationSec);
    const start = t;
    const end = Math.min(durationSec, t + dur);
    lines.push({
      start_sec: Number(start.toFixed(2)),
      end_sec: Number(end.toFixed(2)),
      text,
    });
    t = end;
  }
  return lines;
}

/** Turn an axios/other error into a precise, storable message (status + body). */
function describeAxios(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;
    const body = typeof data === 'string' ? data : data ? JSON.stringify(data) : err.message;
    return `HTTP ${status ?? '?'}: ${String(body).slice(0, 800)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function dimsForAspect(aspect: string | undefined): { width: number; height: number } {
  switch (aspect) {
    case '1:1':
      return { width: 1080, height: 1080 };
    case '16:9':
      return { width: 1920, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
    case '9:16':
    default:
      return { width: 1080, height: 1920 };
  }
}

export function createUniquifyAnalyzeWorker(deps: Deps): Worker {
  const { db, videoProcessorUrl, uniquifyRenderQueue, gptunnelService, connection } = deps;

  return new Worker<UniquifyAnalyzeJobPayload>(
    QUEUES['uniquify-analyze'].name,
    async (job) => {
      const { sourceVideoId, tenantId, uniquifyJobId } = job.data;
      logger.info({ sourceVideoId, uniquifyJobId }, 'Uniquify-analyze: starting');

      const jobCheck = await db.uniquifyJob.findUnique({
        where: { id: uniquifyJobId },
        select: { status: true },
      });
      if (jobCheck?.status === 'cancelled') {
        logger.info({ uniquifyJobId }, 'Uniquify-analyze: job cancelled, aborting');
        return;
      }

      const sourceVideo = await db.sourceVideo.findUniqueOrThrow({ where: { id: sourceVideoId } });
      const uniquifyJob = await db.uniquifyJob.findUniqueOrThrow({ where: { id: uniquifyJobId } });
      const config = (uniquifyJob.config ?? {}) as Record<string, unknown>;

      await db.$transaction([
        db.sourceVideo.update({ where: { id: sourceVideoId }, data: { status: 'analyzing' } }),
        db.uniquifyJob.update({ where: { id: uniquifyJobId }, data: { status: 'analyzing' } }),
      ]);

      try {
        // ── 1. Resolve all source clips (primary + optional pool) ────────────
        const extraIds = Array.isArray(config.additionalSourceVideoIds)
          ? (config.additionalSourceVideoIds as string[])
          : [];
        const poolVideos = extraIds.length
          ? await db.sourceVideo.findMany({
              where: { id: { in: extraIds }, tenantId },
              select: { storageKey: true },
            })
          : [];
        const sourceStorageKeys = [
          sourceVideo.storageKey,
          ...poolVideos.map((v) => v.storageKey),
        ].filter(Boolean);

        // ── 2. Probe source(s) ───────────────────────────────────────────────
        let analysis: {
          duration_sec: number;
          width: number;
          height: number;
          fps: number;
          scene_breaks: number[];
          audio_profile: Record<string, unknown>;
          sources?: Array<{ storage_key: string; scene_breaks: number[] }>;
        };
        try {
          const analyzeResp = await axios.post(`${videoProcessorUrl}/uniquify/analyze`, {
            source_video_id: sourceVideoId,
            storage_keys: sourceStorageKeys,
          }, { timeout: 300_000 });
          analysis = analyzeResp.data;
        } catch (e) {
          throw new Error(`video-analyze: ${describeAxios(e)}`);
        }

        // Scene breaks per source (aligned to sourceStorageKeys) for scene-aware cuts.
        const sceneBreaksByKey = new Map<string, number[]>();
        for (const s of analysis.sources ?? []) {
          sceneBreaksByKey.set(s.storage_key, s.scene_breaks ?? []);
        }
        const sceneBreaksBySource = sourceStorageKeys.map((k) => sceneBreaksByKey.get(k) ?? []);

        await db.sourceVideo.update({
          where: { id: sourceVideoId },
          data: {
            status: 'ready',
            durationSec: analysis.duration_sec,
            width: analysis.width,
            height: analysis.height,
            fps: analysis.fps,
            sceneBreaks: analysis.scene_breaks as unknown as any,
            audioProfile: analysis.audio_profile as unknown as any,
          },
        });

        const variantCount = uniquifyJob.variantCount;
        const language = (config.language as string) ?? uniquifyJob.language ?? 'ru';
        const voiceId = (config.voiceId as string) ?? uniquifyJob.voiceId ?? DEFAULT_TTS_VOICE_ID;
        const targetSeconds = typeof config.targetSeconds === 'number' ? config.targetSeconds : 30;
        const enableSubtitles = config.enableSubtitles !== false;
        const enableBgm = config.enableBgm !== false;
        const bgmKeys = (Array.isArray(config.bgmTrackKeys) ? config.bgmTrackKeys : []) as string[];
        const bgmVolume = typeof config.bgmVolume === 'number' ? config.bgmVolume : 0.16;
        const beatSync = config.beatSync !== false;
        const { width, height } = dimsForAspect(config.aspectRatio as string | undefined);
        const fps = typeof config.fps === 'number' ? config.fps : 30;

        // ── 3. ONE GPT call: script (from theme) + per-variant captions ───────
        let script = '';
        let captions: Array<{ caption: string; hashtags: string[] }> = [];
        try {
          ({ script, captions } = await gptunnelService.generateScript({
            title: sourceVideo.title ?? 'video',
            description: sourceVideo.description ?? '',
            productInfo: (config.productInfo as string) ?? undefined,
            language,
            variantCount,
            targetSeconds,
          }));
        } catch (e) {
          throw new Error(`gpt-script: ${describeAxios(e)}`);
        }

        // ── 4. ONE TTS call: the shared voiceover ────────────────────────────
        let tts: { storageKey: string; cost: number };
        try {
          tts = await gptunnelService.ttsCreate({
            text: script,
            voiceId,
            tenantId,
            uniquifyJobId,
          });
        } catch (e) {
          throw new Error(`tts (voiceId=${voiceId}): ${describeAxios(e)}`);
        }
        const voiceoverKey = tts.storageKey;

        // ── 5. ONE Whisper run: subtitle lines timed to the voiceover ────────
        // Whisper gives the best (word-level) sync; if it yields nothing we fall
        // back to evenly distributing the known script across the voiceover
        // length, so subtitles are always present.
        let subtitles: Array<{ start_sec: number; end_sec: number; text: string }> = [];
        if (enableSubtitles) {
          let voiceDuration = 0;
          try {
            const tr = await axios.post<{
              subtitles: Array<{ start_sec: number; end_sec: number; text: string }>;
              duration_sec?: number;
            }>(`${videoProcessorUrl}/transcribe`, {
              storage_key: voiceoverKey,
              language,
            }, { timeout: 300_000 });
            subtitles = tr.data.subtitles ?? [];
            voiceDuration = tr.data.duration_sec ?? 0;
          } catch (err: unknown) {
            logger.warn(
              { uniquifyJobId, err: describeAxios(err) },
              'Uniquify-analyze: voiceover transcription failed, will use script-based subtitles',
            );
          }

          if (subtitles.length === 0 && script.trim()) {
            if (voiceDuration <= 0) voiceDuration = estimateSpeechDuration(script);
            subtitles = buildSubtitlesFromScript(script, voiceDuration);
            logger.info(
              { uniquifyJobId, lines: subtitles.length, voiceDuration },
              'Uniquify-analyze: using script-based fallback subtitles',
            );
          }
        }

        // ── 6. Persist shared assets on the job ──────────────────────────────
        await db.uniquifyJob.update({
          where: { id: uniquifyJobId },
          data: {
            status: 'generating',
            script,
            voiceoverKey,
            voiceId,
            language,
            transcript: subtitles as unknown as any,
            creditsUsed: { increment: Math.round(tts.cost ?? 0) },
          },
        });

        // ── 7. Create variants + enqueue one montage render each ─────────────
        const seedBase = Math.floor(Math.random() * 1_000_000);

        const renderJobs: Array<{ name: string; data: UniquifyRenderJobPayload; opts: any }> = [];
        for (let i = 0; i < variantCount; i++) {
          const seed = seedBase + i * 7919; // spread seeds apart for distinct edits
          const subtitleStyle = enableSubtitles ? SUBTITLE_STYLES[i % SUBTITLE_STYLES.length] : 'none';
          const bgmKey = enableBgm && bgmKeys.length > 0 ? bgmKeys[i % bgmKeys.length] : undefined;
          const content = captions[i] ?? captions[i % Math.max(captions.length, 1)] ?? null;

          const variant = await db.uniqueVariant.create({
            data: {
              uniquifyJobId,
              tenantId,
              variantIndex: i,
              status: 'pending',
              transforms: { seed, subtitleStyle, bgmKey, width, height, fps } as any,
              subtitleStyle,
              ttsVoiceId: voiceId,
              ttsStorageKey: voiceoverKey,
              bgmTrackKey: bgmKey ?? null,
              generatedCaption: content?.caption ?? null,
              generatedHashtags: content?.hashtags ?? [],
            },
          });

          renderJobs.push({
            name: `uniquify-render-${variant.id}`,
            data: {
              uniquifyJobId,
              variantId: variant.id,
              tenantId,
              sourceStorageKeys,
              outputKey: `tenants/${tenantId}/uniquify/${uniquifyJobId}/${variant.id}.mp4`,
              seed,
              subtitleStyle,
              bgmStorageKey: bgmKey,
              bgmVolume,
              voiceoverVolume: 1.0,
              width,
              height,
              fps,
              beatSync,
              sceneBreaks: sceneBreaksBySource,
            },
            opts: QUEUES['uniquify-render'].defaultJobOptions as any,
          });
        }

        await uniquifyRenderQueue.addBulk(renderJobs);

        logger.info(
          { uniquifyJobId, variantCount, subtitleLines: subtitles.length, bgmTracks: bgmKeys.length },
          'Uniquify-analyze: complete, montage render jobs enqueued',
        );
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ sourceVideoId, uniquifyJobId, err: errorMsg }, 'Uniquify-analyze: failed');
        await db.$transaction([
          db.sourceVideo.update({ where: { id: sourceVideoId }, data: { status: 'failed', error: errorMsg } }),
          db.uniquifyJob.update({ where: { id: uniquifyJobId }, data: { status: 'failed', error: errorMsg } }),
        ]);
        throw err;
      }
    },
    {
      connection,
      concurrency: QUEUES['uniquify-analyze'].concurrency,
    },
  );
}
