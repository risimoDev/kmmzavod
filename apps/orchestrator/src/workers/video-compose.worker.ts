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
      type SceneRow = typeof scenes[number];

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
          logger.info({ jobId, subs: subtitles.length }, 'Combined Whisper transcription OK');
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
      const buildSceneItems = (preset: ComposePreset) =>
        scenes.map((s: SceneRow) => ({
          type: s.type,
          storage_key:
            s.type === 'avatar' ? s.avatarUrl! :
            s.type === 'clip'   ? s.clipUrl!   :
            s.type === 'image'  ? s.imageUrl!  : '',
          duration_sec: Number(s.durationSec ?? 3),
          transition: preset.transition_type,
          transition_duration: preset.transition_duration,
        }));

      // Adjust subtitle timestamps for xfade overlap per preset
      const adjustSubtitlesForPreset = (
        rawSubs: Array<{ start_sec: number; end_sec: number; text: string }>,
        preset: ComposePreset,
      ) => {
        if (preset.transition_duration <= 0 || rawSubs.length === 0) return rawSubs;

        const xfadeDur = preset.transition_duration;
        // Each transition overlaps scenes, so sceneOffset[i] should be reduced
        // by (number of transitions before that scene) * xfadeDur.
        // We need to figure out which scene each subtitle belongs to and apply
        // the cumulative overlap shift.
        const adjusted = rawSubs.map((sub) => {
          // Find which scene this subtitle belongs to (by matching raw offset ranges)
          let cumulativeOverlap = 0;
          let rawOffset = 0;
          for (let i = 0; i < scenes.length; i++) {
            const dur = Number(scenes[i].durationSec ?? 5);
            if (sub.start_sec >= rawOffset && sub.start_sec < rawOffset + dur + 0.5) {
              break;
            }
            rawOffset += dur;
            if (i > 0) {
              // transitions happen between scenes, so overlap accumulates from scene 1 onwards
            }
            cumulativeOverlap = i * xfadeDur; // overlap before next scene
          }
          // Recalculate: for scene at index i, cumulative overlap = i * xfadeDur
          // Find scene index for this subtitle
          let sceneIdx = 0;
          let off = 0;
          for (let i = 0; i < scenes.length; i++) {
            const dur = Number(scenes[i].durationSec ?? 5);
            if (sub.start_sec < off + dur + 0.5) {
              sceneIdx = i;
              break;
            }
            off += dur;
            sceneIdx = i;
          }
          const shift = sceneIdx * xfadeDur;

          return {
            start_sec: +Math.max(0, sub.start_sec - shift).toFixed(2),
            end_sec: +Math.max(0, sub.end_sec - shift).toFixed(2),
            text: sub.text,
          };
        });
        return adjusted;
      };

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
          const presetSubtitles = adjustSubtitlesForPreset(subtitles, preset);

          let response: { duration_sec: number; file_size_bytes: number };

          if (isCombinedMode) {
            // ── COMBINED MODE: /compose-layout ─────────────────────────────────
            // The combined HeyGen avatar is the main audio/video track.
            // All non-avatar scenes (clip/image/text) become background segments
            // that show at proportional time slices of the avatar duration.
            const bgScenes = scenes.filter((s: SceneRow) =>
              (s.type === 'clip' || s.type === 'image') &&
              (s.clipUrl || s.imageUrl)
            );

            // Compute per-segment weights (proportional to scene duration within non-avatar time)
            // If no b-roll, create a single fullscreen segment
            const avatarOnlyDuration = combinedAvatarDurationSec ?? (
              scenes.filter((s: SceneRow) => s.type === 'avatar').reduce((sum, s) => sum + Number(s.durationSec ?? 5), 0)
            );

            // Build segments: interleave fullscreen avatar at start, then PIP/voiceover for each b-roll
            // Simple strategy: divide total duration evenly among b-roll scenes; fill gaps with fullscreen
            const backgrounds: Array<{ storage_key: string; type: 'image' | 'video' }> = [];
            const segments: Array<{ layout: string; bg_index: number; weight: number }> = [];

            if (bgScenes.length === 0) {
              // No b-roll → pure fullscreen avatar
              backgrounds.push({ storage_key: combinedAvatarUrl!, type: 'video' });
              segments.push({ layout: 'fullscreen', bg_index: 0, weight: 1.0 });
            } else {
              // Mix: avatar fullscreen for ~60% of time, PIP/voiceover for b-roll
              // Each b-roll scene occupies its proportional slice of total avatar duration
              const totalNonAvatarDuration = bgScenes.reduce((sum, s) => sum + Number(s.durationSec ?? 5), 0);

              bgScenes.forEach((s: SceneRow, idx: number) => {
                const storageKey = (s.type === 'clip' ? s.clipUrl : s.imageUrl)!;
                backgrounds.push({
                  storage_key: storageKey,
                  type: s.type === 'clip' ? 'video' : 'image',
                });

                const sceneWeight = Number(s.durationSec ?? 5) / avatarOnlyDuration;

                // Alternate between layouts for visual variety
                const layouts = ['pip_bl', 'pip_br', 'voiceover', 'pip_tl'];
                const layout = layouts[idx % layouts.length];
                segments.push({ layout, bg_index: idx, weight: sceneWeight });
              });

              // Add a fullscreen segment at start (hook scene is avatar-only)
              // Remaining weight = 1.0 - sum(bg weights)
              const bgTotalWeight = segments.reduce((sum, s) => sum + s.weight, 0);
              const ffWeight = Math.max(0.05, 1.0 - bgTotalWeight);

              // Insert fullscreen at beginning if there's meaningful remaining time
              if (ffWeight >= 0.05) {
                backgrounds.push({ storage_key: combinedAvatarUrl!, type: 'video' });
                // Insert at front
                segments.unshift({ layout: 'fullscreen', bg_index: backgrounds.length - 1, weight: ffWeight });
              }
            }

            const layoutRes = await axios.post(`${videoProcessorUrl}/compose-layout`, {
              job_id:              jobId,
              tenant_id:           tenantId,
              output_key:          outputKey,
              avatar_storage_key:  combinedAvatarUrl,
              backgrounds,
              segments,
              subtitles:           presetSubtitles,
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
                  }
                : undefined,
              chroma_color: '#00FF00',
              pip_scale: 0.30,
              transition: preset.transition_type,
              transition_duration: preset.transition_duration,
            }, { timeout: 600_000 });

            response = layoutRes.data as { duration_sec: number; file_size_bytes: number };
          } else {
            // ── LEGACY/SLIDESHOW MODE: /compose ────────────────────────────────
            const composeRes = await axios.post(`${videoProcessorUrl}/compose`, {
              job_id:     jobId,
              tenant_id:  tenantId,
              output_key: outputKey,
              scenes:     buildSceneItems(preset),
              subtitles:  presetSubtitles,
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
                  }
                : undefined,
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
