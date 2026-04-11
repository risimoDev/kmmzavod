// Video compose worker — builds scene manifest and calls video-processor HTTP API
// Now generates multiple variants in parallel (one per compose preset).

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

      // Compute scene offsets (where each scene starts in the final timeline)
      const sceneOffsets: number[] = [];
      let offset = 0;
      for (const s of scenes) {
        sceneOffsets.push(offset);
        offset += Number(s.durationSec ?? 5);
      }

      // Determine video format (slideshow = images only, no avatar)
      const settings = payload.settings as Record<string, unknown> | undefined;
      const videoFormat = (settings?.video_format as string) ?? 'standard';

      // Transcribe each avatar scene via Whisper for accurate word-level timing
      let subtitles: Array<{ start_sec: number; end_sec: number; text: string }> = [];
      const avatarScenes = scenes.filter((s: SceneRow) => s.type === 'avatar' && s.script && s.avatarUrl);

      // For slideshow format (no avatar scenes), generate subtitles from scene scripts
      if (videoFormat === 'slideshow' || avatarScenes.length === 0) {
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
      } else {

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
          // Offset timestamps to global timeline position
          for (const sub of whisperSubs) {
            subtitles.push({
              start_sec: +(sub.start_sec + sceneOffset).toFixed(2),
              end_sec: +(sub.end_sec + sceneOffset).toFixed(2),
              text: sub.text,
            });
          }
          logger.info({ jobId, sceneId: scene.id, subs: whisperSubs.length }, 'Whisper transcription OK for scene');
        } catch (err: any) {
          // Fallback: use scene duration + script as single block
          logger.warn({ jobId, sceneId: scene.id, err: err.message }, 'Whisper failed for scene, using fallback');
          subtitles.push({
            start_sec: sceneOffset,
            end_sec: sceneOffset + Number(scene.durationSec ?? 5),
            text: scene.script!,
          });
        }
      }
      } // end else (standard mode Whisper)

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

          const response = await axios.post(`${videoProcessorUrl}/compose`, {
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

          return { presetName, outputKey, response: response.data as { duration_sec: number; file_size_bytes: number } };
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
