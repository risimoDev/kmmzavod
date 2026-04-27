// Video compose worker — builds scene manifest and calls video-processor HTTP API
// Now generates multiple variants in parallel (one per compose preset).
//
// COMBINED MODE (new jobs): when job.payload.combinedAvatarUrl exists, the worker
// uses POST /compose-layout. The combined HeyGen video is the avatar track; all
// clip/image scenes become background segments overlaid on it.
//
// LEGACY MODE: scene-by-scene composition via POST /compose.

import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type VideoComposeJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { COMPOSE_PRESETS, DEFAULT_VARIANT_PRESETS, type ComposePreset } from '../pipeline/compose-presets';
import { settleCredits } from '../lib/credits';
import { logger } from '../logger';
import type { IStorageClient } from '@kmmzavod/storage';
import { StoragePaths } from '@kmmzavod/storage';

interface Deps {
  db:                PrismaClient;
  videoProcessorUrl: string;
  connection:        ConnectionOptions;
  storage:           IStorageClient;
}

export function createVideoComposeWorker(deps: Deps): Worker {
  const { db, videoProcessorUrl, connection, storage } = deps;

  return new Worker<VideoComposeJobPayload>(
    QUEUES['video-compose'].name,
    async (job) => {
      const { jobId, tenantId, variants: requestedVariants } = job.data;

      const [scenes, jobRow] = await Promise.all([
        db.scene.findMany({ where: { jobId }, orderBy: { sceneIndex: 'asc' } }),
        db.job.findUniqueOrThrow({ where: { id: jobId }, select: { payload: true, videoId: true, creditsUsed: true } }),
      ]);

      // ── Pre-flight: verify all required assets are in MinIO ────────────────
      // If compose was triggered before all workers finished (race condition), fail
      // fast with a clear error rather than silently producing an incomplete video.
      type SceneRow = typeof scenes[number];
      const missingAssets = scenes
        .filter((s: SceneRow) => {
          if (s.type === 'avatar') return s.status !== 'failed' && !s.avatarUrl;
          if (s.type === 'clip')   return s.status !== 'failed' && !s.clipUrl;
          if (s.type === 'image')  return s.status !== 'failed' && !s.imageUrl;
          return false;
        })
        .map((s: SceneRow) => `scene ${s.sceneIndex} (${s.type})`);

      if (missingAssets.length > 0) {
        throw new Error(
          `Video compose aborted — assets not ready: ${missingAssets.join(', ')}. ` +
          'Workers may still be running. Will retry automatically.',
        );
      }

      const payload = jobRow.payload as Record<string, unknown>;
      const settingsObj0 = (payload.settings ?? {}) as Record<string, unknown>;

      // Determine which compose presets to render:
      // 1. Explicit variants in job data → use those
      // 2. editStyle from preset settings → use that single style (uniqualization)
      // 3. Default → all 3 presets
      let presetNames: string[];
      if (requestedVariants?.length) {
        presetNames = requestedVariants;
      } else if (settingsObj0.editStyle && typeof settingsObj0.editStyle === 'string' && settingsObj0.editStyle in COMPOSE_PRESETS) {
        presetNames = [settingsObj0.editStyle];
      } else {
        presetNames = [...DEFAULT_VARIANT_PRESETS];
      }

      // Build accurate subtitles using Whisper transcription of avatar scenes
      // (SceneRow type already declared above for the pre-flight check)

      // Determine video format (slideshow = images only, no avatar)
      const settings = payload.settings as Record<string, unknown> | undefined;
      const videoFormat = (settings?.video_format as string) ?? 'standard';

      // ── COMBINED MODE detection ────────────────────────────────────────────
      const combinedAvatarUrl = payload.combinedAvatarUrl as string | undefined;
      const combinedAvatarDurationSec = typeof payload.combinedAvatarDurationSec === 'number'
        ? payload.combinedAvatarDurationSec
        : undefined;
      const isCombinedMode = !!combinedAvatarUrl && videoFormat !== 'slideshow';

      // Compute scene offsets (where each scene starts in the final timeline)
      const sceneOffsets: number[] = [];
      let offset = 0;
      for (const s of scenes) {
        sceneOffsets.push(offset);
        offset += Number(s.durationSec ?? 5);
      }

      // Transcribe each avatar scene via Whisper for accurate word-level timing
      let subtitles: Array<{ start_sec: number; end_sec: number; text: string }> = [];
      let combinedTranscribeWords: Array<{ word: string; start_sec: number; end_sec: number }> = [];
      const avatarScenes = scenes.filter((s: SceneRow) => s.type === 'avatar' && s.script && s.avatarUrl);

      if (videoFormat === 'slideshow' || (avatarScenes.length === 0 && !isCombinedMode)) {
        // Slideshow: generate subtitles from scene scripts (timing based on scene durations)
        for (let i = 0; i < scenes.length; i++) {
          const s = scenes[i];
          if (s.script) {
            subtitles.push({
              start_sec: sceneOffsets[i],
              end_sec: sceneOffsets[i] + Number(s.durationSec ?? 5),
              text: s.script,
            });
          }
        }
        logger.info({ jobId, subtitleCount: subtitles.length }, 'Slideshow mode: subtitles from scene scripts');
      } else if (isCombinedMode) {
        // Combined mode: transcribe the single combined avatar video → accurate subtitles
        try {
          const transcribeRes = await axios.post(`${videoProcessorUrl}/transcribe`, {
            storage_key: combinedAvatarUrl,
            language: 'ru',
            max_words_per_chunk: 12,
          }, { timeout: 180_000 });

          subtitles = transcribeRes.data.subtitles as Array<{ start_sec: number; end_sec: number; text: string }>;
          combinedTranscribeWords = (transcribeRes.data.words ?? []) as Array<{ word: string; start_sec: number; end_sec: number }>;
          logger.info({ jobId, subs: subtitles.length, words: combinedTranscribeWords.length }, 'Combined Whisper transcription OK');
        } catch (err: any) {
          // Fallback: build subtitles from all avatar scripts using estimated timing
          logger.warn({ jobId, err: err.message }, 'Combined Whisper failed, using script fallback');
          const avatarOnly = scenes
            .filter((s: SceneRow) => s.type === 'avatar' && s.script)
            .sort((a, b) => a.sceneIndex - b.sceneIndex);
          let cursor = 0;
          for (const s of avatarOnly) {
            const dur = Number(s.durationSec ?? 5);
            subtitles.push({ start_sec: cursor, end_sec: cursor + dur, text: s.script! });
            cursor += dur;
          }
        }
      } else {
        // Legacy per-scene mode: transcribe each avatar scene separately
        for (const scene of avatarScenes) {
          const sceneIdx = scenes.indexOf(scene);
          const sceneOffset = sceneOffsets[sceneIdx];
          try {
            const transcribeRes = await axios.post(`${videoProcessorUrl}/transcribe`, {
              storage_key: scene.avatarUrl,
              language: 'ru',
              max_words_per_chunk: 12,
            }, { timeout: 120_000 });

            const whisperSubs = transcribeRes.data.subtitles as Array<{ start_sec: number; end_sec: number; text: string }>;
            for (const sub of whisperSubs) {
              subtitles.push({
                start_sec: +(sub.start_sec + sceneOffset).toFixed(2),
                end_sec: +(sub.end_sec + sceneOffset).toFixed(2),
                text: sub.text,
              });
            }
            logger.info({ jobId, sceneId: scene.id, subs: whisperSubs.length }, 'Whisper transcription OK for scene');
          } catch (err: any) {
            logger.warn({ jobId, sceneId: scene.id, err: err.message }, 'Whisper failed for scene, using fallback');
            subtitles.push({
              start_sec: sceneOffset,
              end_sec: sceneOffset + Number(scene.durationSec ?? 5),
              text: scene.script!,
            });
          }
        }
      }

      // Create VideoVariant rows upfront (status=rendering)
      if (jobRow.videoId) {
        await db.videoVariant.createMany({
          data: presetNames.map((preset) => ({
            jobId,
            videoId: jobRow.videoId!,
            tenantId,
            preset,
            outputKey: `tenants/${tenantId}/videos/${jobId}/variant_${preset}/final.mp4`,
            status: 'rendering' as const,
          })),
          skipDuplicates: true,
        });
      }

      // Build per-preset scene items with preset-specific transitions
      // Also compute subtitle timing adjustments for each preset's transition overlap
      // L/J-cut logic: avatar→clip = J-cut (audio leads), clip→avatar = L-cut (audio lags)
      const buildSceneItems = (preset: ComposePreset) =>
        scenes
          .filter((s: SceneRow) => {
            if (s.type === 'avatar') return !!s.avatarUrl;
            if (s.type === 'clip')   return !!s.clipUrl;
            if (s.type === 'image')  return !!s.imageUrl;
            return false;
          })
          .map((s: SceneRow, idx: number, arr: SceneRow[]) => {
            // Content-aware transition + L/J-cut
            let cutType = 'hard';
            let audioOffset = 0;

            if (idx > 0) {
              const prevType = arr[idx - 1].type;
              const curType = s.type;

              // J-cut: audio of b-roll starts before video transition
              if (prevType === 'avatar' && (curType === 'clip' || curType === 'image')) {
                cutType = 'j_cut';
                audioOffset = 0.3; // Audio leads by 0.3s
              }
              // L-cut: avatar audio continues over new b-roll
              if (prevType === 'clip' && curType === 'avatar') {
                cutType = 'l_cut';
                audioOffset = -0.2; // Audio lags by 0.2s
              }
            }

            return {
              scene_id: s.id,
              type: s.type,
              storage_key:
                s.type === 'avatar' ? s.avatarUrl! :
                s.type === 'clip'   ? s.clipUrl!   :
                s.type === 'image'  ? s.imageUrl!  : '',
              duration_sec: Number(s.durationSec ?? 3),
              transition: preset.transition_type,
              transition_duration: preset.transition_duration,
              cut_type: cutType,
              audio_offset_sec: audioOffset,
              speed: 1.0,
            };
          });

      // ── Compute duck zones from Whisper word timestamps ──────────────────
      // Word-level timestamps are now returned directly from /transcribe
      // (no second Whisper call needed, no uniform-distribution approximation)
      const wordTimestamps: Array<{ word: string; start: number; end: number }> = [];
      if (isCombinedMode && combinedTranscribeWords.length > 0) {
        // Words from the first (and only) transcription call
        for (const w of combinedTranscribeWords) {
          wordTimestamps.push({ word: w.word, start: w.start_sec, end: w.end_sec });
        }
        logger.info({ jobId, wordCount: wordTimestamps.length }, 'Word timestamps from transcription used for ducking');
        } catch (err: any) {
          logger.warn({ jobId, err: err.message }, 'Failed to get word timestamps for ducking');
        }
      }

      // Compute duck zones: group words into continuous speech segments
      const computeDuckZones = (words: Array<{ start: number; end: number }>) => {
        if (words.length === 0) return [];
        const zones: Array<{ start_sec: number; end_sec: number; duck_volume: number }> = [];
        let segStart = words[0].start;
        let segEnd = words[0].end;

        for (let i = 1; i < words.length; i++) {
          const gap = words[i].start - segEnd;
          if (gap < 0.5) {
            segEnd = words[i].end;
          } else {
            zones.push({ start_sec: Math.round(segStart * 100) / 100, end_sec: Math.round(segEnd * 100) / 100, duck_volume: 0.04 });
            segStart = words[i].start;
            segEnd = words[i].end;
          }
        }
        zones.push({ start_sec: Math.round(segStart * 100) / 100, end_sec: Math.round(segEnd * 100) / 100, duck_volume: 0.04 });
        return zones;
      };

      const duckZones = computeDuckZones(wordTimestamps);

      // Subtitle timing adjustment is handled by the Python pipeline (both /compose
      // and /compose-layout). The Python side has access to ACTUAL clip durations
      // after normalization, speed ramping, and beat alignment — which the TS side
      // cannot know in advance. We pass RAW subtitles and let Python adjust them.
      // Previously adjustSubtitlesForPreset() was used but it was inaccurate:
      // it used a uniform shift (sceneIdx * xfadeDur) that didn't account for
      // CUT transitions, content-aware overrides, or beat alignment changes.
      const rawSubtitles = subtitles;

      // Fire all variant renders in parallel
      // ── BGM auto-selection from library ─────────────────────────────────────
      const settingsObj = (payload['settings'] ?? {}) as Record<string, unknown>;
      let audioTrack: Record<string, unknown> | undefined = settingsObj.audio_track as Record<string, unknown> | undefined;

      // If no explicit BGM but bgm_enabled flag is set (or bgm_enabled not explicitly false), auto-pick
      if (!audioTrack && settingsObj.bgm_enabled !== false) {
        try {
          const bgmKeys = await storage.listPrefix(StoragePaths.bgmPrefix());
          const audioFiles = bgmKeys.filter((k: string) => /\.(mp3|wav|aac|m4a|ogg)$/i.test(k));
          if (audioFiles.length > 0) {
            const randomKey = audioFiles[Math.floor(Math.random() * audioFiles.length)];
            audioTrack = { storage_key: randomKey, volume: 0.12 };
            logger.info({ jobId, bgmKey: randomKey, pool: audioFiles.length }, 'Auto-selected BGM from library');
          }
        } catch (err: any) {
          logger.warn({ jobId, err: err.message }, 'Failed to list BGM library, skipping BGM');
        }
      }

      const results = await Promise.allSettled(
        presetNames.map(async (presetName) => {
          const preset = COMPOSE_PRESETS[presetName];
          if (!preset) throw new Error(`Unknown compose preset: ${presetName}`);

          const outputKey = `tenants/${tenantId}/videos/${jobId}/variant_${presetName}/final.mp4`;

          let response: { duration_sec: number; file_size_bytes: number };

          if (isCombinedMode) {
            // ── COMBINED MODE ──────────────────────────────────────────────────
            // The combined HeyGen avatar is the main audio/video track.
            // All non-avatar scenes (clip/image) become background segments
            // overlaid on it via /compose-layout.
            // If there are no b-roll scenes, fall back to /compose (single scene).
            const bgScenes = scenes.filter((s: SceneRow) =>
              (s.type === 'clip' || s.type === 'image') &&
              (s.clipUrl || s.imageUrl)
            );

            const avatarOnlyDuration = (combinedAvatarDurationSec && combinedAvatarDurationSec > 0)
              ? combinedAvatarDurationSec
              : scenes.filter((s: SceneRow) => s.type === 'avatar').reduce((sum, s) => sum + Number(s.durationSec ?? 5), 0);
            );

            if (bgScenes.length === 0) {
              // Pure avatar video — no layout composition needed, use /compose directly
              const composeRes = await axios.post(`${videoProcessorUrl}/compose`, {
                job_id:     jobId,
                tenant_id:  tenantId,
                output_key: outputKey,
                scenes: [{
                  scene_id:            `${jobId}-combined`,
                  type:                'avatar',
                  storage_key:         combinedAvatarUrl,
                  duration_sec:        avatarOnlyDuration > 0 ? avatarOnlyDuration : 30,
                  transition:          preset.transition_type,
                  transition_duration: preset.transition_duration,
                }],
                subtitles: rawSubtitles,
                settings: {
                  ...((payload['settings'] as object) ?? {}),
                  subtitle_style: preset.subtitle_style.style,
                },
              audio_track: audioTrack
                ? {
                    ...audioTrack,
                    volume: preset.audio_preset.bgm_volume,
                    fade_in_sec: preset.audio_preset.fade_in_sec,
                    fade_out_sec: preset.audio_preset.fade_out_sec,
                    duck_zones: duckZones,
                    duck_fade_ms: 80,
                  }
                : undefined,
              beat_sync: { enabled: true, tolerance_sec: 0.5, use_onsets: false },
              content_aware_transitions: { enabled: true, rules: {} },
              color_grading: { enabled: true, method: 'histogram', strength: 0.6 },
               }, { timeout: 600_000 });
               response = composeRes.data as { duration_sec: number; file_size_bytes: number };
              } else {
              // ── /compose-layout with b-roll backgrounds ─────────────────────
              const backgrounds: Array<{ storage_key: string; type: 'image' | 'video' }> = [];
              const segments: Array<{ layout: string; bg_index: number; weight: number }> = [];

              // Push b-roll backgrounds first
              bgScenes.forEach((s: SceneRow, idx: number) => {
                const storageKey = (s.type === 'clip' ? s.clipUrl : s.imageUrl)!;
                backgrounds.push({
                  storage_key: storageKey,
                  type: s.type === 'clip' ? 'video' : 'image',
                });

                const sceneWeight = Number(s.durationSec ?? 5) / avatarOnlyDuration;
                const layouts = ['pip_bl', 'pip_br', 'voiceover', 'pip_tl'];
                segments.push({ layout: layouts[idx % layouts.length], bg_index: idx, weight: sceneWeight });
              });

              // Remaining weight → fullscreen avatar at the start (hook section)
              const bgTotalWeight = segments.reduce((sum, s) => sum + s.weight, 0);
              const ffWeight = +(Math.max(0.05, 1.0 - bgTotalWeight)).toFixed(4);

              // Use the first b-roll as background for the fullscreen segment
              // (avoids re-downloading the combined avatar just for a background track)
              segments.unshift({ layout: 'fullscreen', bg_index: 0, weight: ffWeight });

              // NOTE: Both /compose and /compose-layout receive RAW subtitles.
              // The Python pipelines adjust subtitle timings based on actual clip
              // durations and xfade overlaps — the only place with access to probed data.
              const layoutRes = await axios.post(`${videoProcessorUrl}/compose-layout`, {
                job_id:              jobId,
                tenant_id:           tenantId,
                output_key:          outputKey,
                avatar_storage_key:  combinedAvatarUrl,
                backgrounds,
                segments,
                subtitles:           subtitles, // raw, unadjusted — Python handles xfade shift
                settings: {
                  ...((payload['settings'] as object) ?? {}),
                  subtitle_style: preset.subtitle_style.style,
                },
                audio_track: audioTrack
                  ? {
                      ...audioTrack,
                      volume: preset.audio_preset.bgm_volume,
                      fade_in_sec: preset.audio_preset.fade_in_sec,
                      fade_out_sec: preset.audio_preset.fade_out_sec,
                      duck_zones: duckZones,
                      duck_fade_ms: 80,
                    }
                  : undefined,
                beat_sync: { enabled: true, tolerance_sec: 0.5, use_onsets: false },
                content_aware_transitions: { enabled: true, rules: {} },
                color_grading: { enabled: true, method: 'histogram', strength: 0.6 },
                word_timestamps: wordTimestamps,
                chroma_color: '#00FF00',
                pip_scale: 0.30,
                transition: preset.transition_type,
                transition_duration: preset.transition_duration,
              }, { timeout: 600_000 });

              response = layoutRes.data as { duration_sec: number; file_size_bytes: number };
            }
          } else {
            // ── LEGACY/SLIDESHOW MODE: /compose ────────────────────────────────
            const composeRes = await axios.post(`${videoProcessorUrl}/compose`, {
              job_id:     jobId,
              tenant_id:  tenantId,
              output_key: outputKey,
              scenes:     buildSceneItems(preset),
              subtitles:  rawSubtitles,
              settings: {
                ...((payload['settings'] as object) ?? {}),
                subtitle_style: preset.subtitle_style.style,
              },
                 audio_track: audioTrack
                   ? {
                       ...audioTrack,
                       volume: preset.audio_preset.bgm_volume,
                       fade_in_sec: preset.audio_preset.fade_in_sec,
                       fade_out_sec: preset.audio_preset.fade_out_sec,
                       duck_zones: duckZones,
                       duck_fade_ms: 80,
                     }
                   : undefined,
                  beat_sync: { enabled: true, tolerance_sec: 0.5, use_onsets: false },
                  content_aware_transitions: { enabled: true, rules: {} },
                  color_grading: { enabled: true, method: 'histogram', strength: 0.6 },
             }, { timeout: 600_000 });

            response = composeRes.data as { duration_sec: number; file_size_bytes: number };
          }

          return { presetName, outputKey, response };
        }),
      );

      // Update each variant row based on result
      let anySucceeded = false;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { presetName, outputKey, response } = result.value;
          anySucceeded = true;

          if (jobRow.videoId) {
            await db.videoVariant.updateMany({
              where: { videoId: jobRow.videoId, preset: presetName },
              data: {
                status: 'ready',
                outputKey,
                durationSec: response.duration_sec,
                fileSizeMb: Number((response.file_size_bytes / (1024 * 1024)).toFixed(2)),
              },
            });
          }
        } else {
          const presetName = presetNames[results.indexOf(result)];
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          logger.error({ jobId, preset: presetName, error: errMsg }, 'Variant render failed');

          if (jobRow.videoId) {
            await db.videoVariant.updateMany({
              where: { videoId: jobRow.videoId, preset: presetName },
              data: { status: 'failed', error: errMsg },
            });
          }
        }
      }

      if (!anySucceeded) {
        throw new Error('All variant renders failed');
      }

      // Pick the first successful variant as the default outputUrl
      const firstOk = results.find((r) => r.status === 'fulfilled') as
        PromiseFulfilledResult<{ presetName: string; outputKey: string; response: { duration_sec: number; file_size_bytes: number } }>;

      await db.$transaction([
        db.job.update({
          where: { id: jobId },
          data:  { status: 'completed', completedAt: new Date() },
        }),
        ...(jobRow.videoId ? [
          db.video.update({
            where: { id: jobRow.videoId },
            data: {
              status: 'completed',
              outputUrl: firstOk.value.outputKey,
              durationSec: firstOk.value.response.duration_sec,
              fileSizeBytes: BigInt(firstOk.value.response.file_size_bytes ?? 0),
              completedAt: new Date(),
            },
          }),
        ] : []),
      ]);

      const okCount   = results.filter((r) => r.status === 'fulfilled').length;
      const failCount = results.length - okCount;

      // ── Credit settlement: compare reserved vs actually spent ──────────
      const jobPayload = jobRow.payload as Record<string, unknown> | null;
      const reservedCredits = typeof jobPayload?.estimatedCredits === 'number' ? jobPayload.estimatedCredits : 0;
      const actualCredits = jobRow.creditsUsed ?? 0;
      if (reservedCredits > 0) {
        await settleCredits(db, { tenantId, jobId, reservedCredits, actualCredits });
      }

      await db.jobEvent.create({
        data: {
          jobId, tenantId,
          stage: 'video-compose',
          status: 'completed',
          message: `${okCount}/${results.length} variants ready` + (failCount ? ` (${failCount} failed)` : ''),
        },
      });

      // Финальный прогресс: 100%
      if (jobRow.videoId) {
        const { publishProgress } = await import('../lib/progress');
        await publishProgress(
          tenantId, jobRow.videoId, 'video-compose', 'completed', 100,
          `${okCount}/${results.length} variants ready`,
        );
      }
    },
    { connection, concurrency: QUEUES['video-compose'].concurrency },
  );
}
