/**
 * Scheduler worker — fires every 60 seconds as a BullMQ repeatable job.
 *
 * On each tick:
 *  1. Find all active VideoPreset rows where next_run_at <= NOW
 *  2. For each due preset:
 *     a. Create a Video + Job → enqueue to pipeline queue
 *     b. Update lastRunAt, compute nextRunAt, bump totalRuns
 *  3. AutoPublish is stored in Video.metadata for the publish worker
 *
 * Uses a minimal built-in cron parser (5-field) with tz support.
 */
import { Worker, type ConnectionOptions, type Queue } from 'bullmq';
import { QUEUES, type SchedulerTickPayload, type PipelineJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger as rootLogger } from '../logger';

const logger = rootLogger.child({ worker: 'scheduler' });

interface Deps {
  db: PrismaClient;
  pipelineQueue: Queue<PipelineJobPayload>;
  connection: ConnectionOptions;
}

/**
 * Parse a cron expression and compute the next occurrence after `after`.
 * Minimal built-in parser for standard 5-field cron (min hour dom mon dow).
 */
function nextCronDate(cron: string, timezone: string, after: Date): Date | null {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const start = new Date(after.getTime() + 60_000);
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

    const matchField = (field: string, value: number): boolean => {
      if (field === '*') return true;

      if (field.includes('/')) {
        const [range, stepStr] = field.split('/');
        const step = parseInt(stepStr, 10);
        if (range === '*') return value % step === 0;
        const [lo, hi] = range.split('-').map(Number);
        return value >= lo && value <= hi && (value - lo) % step === 0;
      }

      if (field.includes('-')) {
        const [lo, hi] = field.split('-').map(Number);
        return value >= lo && value <= hi;
      }

      if (field.includes(',')) {
        return field.split(',').map(Number).includes(value);
      }

      return parseInt(field, 10) === value;
    };

    for (let t = start.getTime(); t < end.getTime(); t += 60_000) {
      const d = new Date(t);
      const inTz = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
      const min = inTz.getMinutes();
      const hour = inTz.getHours();
      const dom = inTz.getDate();
      const mon = inTz.getMonth() + 1;
      const dow = inTz.getDay();

      if (
        matchField(parts[0], min) &&
        matchField(parts[1], hour) &&
        matchField(parts[2], dom) &&
        matchField(parts[3], mon) &&
        matchField(parts[4], dow)
      ) {
        return d;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Pick effective editStyle, resolving "random" to a concrete value. */
function resolveEditStyle(editStyle: string): string {
  if (editStyle === 'random') {
    const options = ['dynamic', 'smooth', 'minimal'];
    return options[Math.floor(Math.random() * options.length)];
  }
  return editStyle;
}

export function createSchedulerWorker(deps: Deps): Worker {
  const { db, pipelineQueue, connection } = deps;

  return new Worker<SchedulerTickPayload>(
    QUEUES['scheduler'].name,
    async () => {
      const now = new Date();

      // Find all due presets
      const duePresets = await db.videoPreset.findMany({
        where: {
          status: 'active',
          nextRunAt: { lte: now },
        },
        include: {
          product: {
            select: { id: true, name: true, tenantId: true },
          },
        },
      });

      if (duePresets.length === 0) return;

      logger.info({ count: duePresets.length }, 'Scheduler: found due presets');

      for (const preset of duePresets) {
        try {
          if (!preset.product) {
            logger.warn({ presetId: preset.id }, 'Scheduler: product not found, skipping');
            continue;
          }

          const effectiveEditStyle = resolveEditStyle(preset.editStyle);

          // Create Video linked to preset
          const video = await db.video.create({
            data: {
              tenantId: preset.tenantId,
              productId: preset.productId,
              presetId: preset.id,
              title: `${preset.product.name} — авто`,
              status: 'pending',
              metadata: {
                presetId: preset.id,
                autoPublish: preset.autoPublish,
                editStyle: effectiveEditStyle,
              },
            },
          });

          // Create Job
          const job = await db.job.create({
            data: {
              tenantId: preset.tenantId,
              videoId: video.id,
              status: 'pending',
              payload: {
                scriptPrompt: '',
                productId: preset.productId,
                presetId: preset.id,
                settings: {
                  avatar_id: preset.heygenAvatarId,
                  voice_id: preset.heygenVoiceId,
                  durationSec: preset.targetDurationSec,
                  editStyle: effectiveEditStyle,
                  bgm_enabled: true,
                },
              },
            },
          });

          // Enqueue pipeline
          await pipelineQueue.add(
            `preset:${preset.id}:${job.id}`,
            { jobId: job.id, tenantId: preset.tenantId },
            { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
          );

          // Update preset: timing + run counter
          const nextRun = preset.cronExpression
            ? nextCronDate(preset.cronExpression, preset.timezone ?? 'Europe/Moscow', now)
            : null;
          await db.videoPreset.update({
            where: { id: preset.id },
            data: {
              lastRunAt: now,
              nextRunAt: nextRun,
              totalRuns: { increment: 1 },
            },
          });

          logger.info(
            { presetId: preset.id, jobId: job.id, videoId: video.id, nextRun, editStyle: effectiveEditStyle },
            'Scheduler: created pipeline job from preset',
          );
        } catch (err: any) {
          logger.error({ presetId: preset.id, err: err.message }, 'Scheduler: failed to process preset');
        }
      }
    },
    {
      connection,
      concurrency: QUEUES['scheduler'].concurrency,
    },
  );
}
