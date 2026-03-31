// Video compose worker — builds scene manifest and calls video-processor HTTP API
// Now generates multiple variants in parallel (one per compose preset).

import { Worker, type ConnectionOptions } from 'bullmq';
import axios from 'axios';
import { QUEUES, type VideoComposeJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { COMPOSE_PRESETS, DEFAULT_VARIANT_PRESETS, type ComposePreset } from '../pipeline/compose-presets';
import { settleCredits } from '../lib/credits';
import { logger } from '../logger';

interface Deps {
  db:                PrismaClient;
  videoProcessorUrl: string;
  connection:        ConnectionOptions;
}

export function createVideoComposeWorker(deps: Deps): Worker {
  const { db, videoProcessorUrl, connection } = deps;

  return new Worker<VideoComposeJobPayload>(
    QUEUES['video-compose'].name,
    async (job) => {
      const { jobId, tenantId, variants: requestedVariants } = job.data;
      const presetNames = requestedVariants?.length
        ? requestedVariants
        : [...DEFAULT_VARIANT_PRESETS];

      const [scenes, jobRow] = await Promise.all([
        db.scene.findMany({ where: { jobId }, orderBy: { sceneIndex: 'asc' } }),
        db.job.findUniqueOrThrow({ where: { id: jobId }, select: { payload: true, videoId: true, creditsUsed: true } }),
      ]);

      const payload = jobRow.payload as Record<string, unknown>;

      // Build accurate subtitles using Whisper transcription of avatar scenes
      type SceneRow = typeof scenes[number];

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

      // Fire all variant renders in parallel
      const results = await Promise.allSettled(
        presetNames.map(async (presetName) => {
          const preset = COMPOSE_PRESETS[presetName];
          if (!preset) throw new Error(`Unknown compose preset: ${presetName}`);

          const outputKey = `tenants/${tenantId}/videos/${jobId}/variant_${presetName}/final.mp4`;

          const response = await axios.post(`${videoProcessorUrl}/compose`, {
            job_id:     jobId,
            tenant_id:  tenantId,
            output_key: outputKey,
            scenes:     buildSceneItems(preset),
            subtitles,
            settings: {
              ...((payload['settings'] as object) ?? {}),
              subtitle_style: preset.subtitle_style.style,
            },
            audio_track: (payload['settings'] as Record<string, unknown>)?.audio_track
              ? {
                  ...((payload['settings'] as Record<string, unknown>).audio_track as object),
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
