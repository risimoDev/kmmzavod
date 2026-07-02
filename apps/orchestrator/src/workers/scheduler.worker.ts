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
import {
  QUEUES,
  type SchedulerTickPayload,
  type PipelineJobPayload,
  type AccountWarmupPayload,
  type DistributeJobPayload,
} from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger as rootLogger } from '../logger';

const logger = rootLogger.child({ worker: 'scheduler' });

interface Deps {
  db: PrismaClient;
  pipelineQueue: Queue<PipelineJobPayload>;
  warmupQueue?: Queue<AccountWarmupPayload>;
  distributeQueue?: Queue<DistributeJobPayload>;
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
  const { db, pipelineQueue, warmupQueue, distributeQueue, connection } = deps;

  return new Worker<SchedulerTickPayload>(
    QUEUES['scheduler'].name,
    async () => {
      const now = new Date();

      // ── Warmup promoter (ферма, приватные аккаунты) ──────────────────────
      if (warmupQueue) {
        try {
          await runWarmupTick(db, warmupQueue, now);
        } catch (err: any) {
          logger.error({ err: err.message }, 'Scheduler: warmup tick failed');
        }
      }

      // ── Distribute schedules (автопубликация уникализированных вариантов) ─
      if (distributeQueue) {
        try {
          await runDistributeSchedulesTick(db, distributeQueue, now);
        } catch (err: any) {
          logger.error({ err: err.message }, 'Scheduler: distribute schedules tick failed');
        }
      }

      // ── Daily reset of per-account post counters ──────────────────────────
      // The distribute worker blocks accounts once dailyPostCount >= maxPostsPerDay.
      // Nothing else resets it, so without this accounts would stay blocked forever.
      // Idempotent: only touches accounts whose last post was before today (UTC).
      try {
        const startOfTodayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const reset = await db.socialAccount.updateMany({
          where: {
            dailyPostCount: { gt: 0 },
            OR: [{ lastPostAt: null }, { lastPostAt: { lt: startOfTodayUTC } }],
          },
          data: { dailyPostCount: 0 },
        });
        if (reset.count > 0) logger.info({ reset: reset.count }, 'Scheduler: daily post counters reset');
      } catch (err: any) {
        logger.error({ err: err.message }, 'Scheduler: daily reset failed');
      }

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

// ─────────────────────────────────────────────────────────────────────────────
// Warmup promoter — прогрев приватных аккаунтов фермы (cold → warming → warm)
// ─────────────────────────────────────────────────────────────────────────────

/** Re-warm an account no more often than every ~22h (worker adds day-level dedupe). */
const WARMUP_INTERVAL_MS = 22 * 3600_000;
/** TikTok has no safe automated warmup action — promote by account age instead. */
const TIKTOK_WARMING_AFTER_MS = 24 * 3600_000;
const TIKTOK_WARM_AFTER_MS = 72 * 3600_000;

async function runWarmupTick(
  db: PrismaClient,
  warmupQueue: Queue<AccountWarmupPayload>,
  now: Date,
): Promise<void> {
  // 1. Instagram private: schedule a warmup session ~once a day per account.
  const igAccounts = await db.socialAccount.findMany({
    where: {
      isActive: true,
      authMethod: 'private',
      platform: 'instagram',
      warmupStatus: { in: ['cold', 'warming'] },
      healthScore: { gte: 30 },
      OR: [
        { lastWarmupAt: null },
        { lastWarmupAt: { lt: new Date(now.getTime() - WARMUP_INTERVAL_MS) } },
      ],
    },
    select: { id: true, tenantId: true },
    take: 200,
  });

  for (const acc of igAccounts) {
    // Daily jobId dedupes against repeatable 60s ticks; random delay up to 3h
    // spreads sessions across the day so the farm does not act in lock-step.
    const day = now.toISOString().slice(0, 10);
    await warmupQueue.add(
      `warmup:${acc.id}`,
      { socialAccountId: acc.id, tenantId: acc.tenantId },
      {
        jobId: `warmup-${acc.id}-${day}`,
        delay: Math.floor(Math.random() * 3 * 3600_000),
      },
    );
  }
  if (igAccounts.length > 0) {
    logger.info({ count: igAccounts.length }, 'Scheduler: warmup sessions enqueued');
  }

  // 2. TikTok private: no publisher warmup action exists (session comes from a
  //    real logged-in account), so promote purely by account age.
  const [tkWarming, tkWarm] = await Promise.all([
    db.socialAccount.updateMany({
      where: {
        isActive: true,
        authMethod: 'private',
        platform: 'tiktok',
        warmupStatus: 'cold',
        createdAt: { lt: new Date(now.getTime() - TIKTOK_WARMING_AFTER_MS) },
      },
      data: { warmupStatus: 'warming' },
    }),
    db.socialAccount.updateMany({
      where: {
        isActive: true,
        authMethod: 'private',
        platform: 'tiktok',
        warmupStatus: 'warming',
        createdAt: { lt: new Date(now.getTime() - TIKTOK_WARM_AFTER_MS) },
      },
      data: { warmupStatus: 'warm' },
    }),
  ]);
  if (tkWarming.count > 0 || tkWarm.count > 0) {
    logger.info({ toWarming: tkWarming.count, toWarm: tkWarm.count }, 'Scheduler: TikTok accounts promoted by age');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Distribute schedules — автопубликация готовых уникализированных вариантов
// ─────────────────────────────────────────────────────────────────────────────

async function runDistributeSchedulesTick(
  db: PrismaClient,
  distributeQueue: Queue<DistributeJobPayload>,
  now: Date,
): Promise<void> {
  const dueSchedules = await db.distributeSchedule.findMany({
    where: { isActive: true, nextRunAt: { lte: now } },
  });
  if (dueSchedules.length === 0) return;

  for (const schedule of dueSchedules) {
    // Always advance the schedule first so a failing run cannot re-fire every tick.
    const nextRun = nextCronDate(schedule.cronExpression, schedule.timezone ?? 'Europe/Moscow', now);
    await db.distributeSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: now, nextRunAt: nextRun, totalRuns: { increment: 1 } },
    });

    try {
      // 1. Resolve target accounts: explicit ids ∪ account group members.
      //    Cheap pre-filters only — the distribute worker re-checks daily limit,
      //    health, 3h gap and warmup gate at send time.
      const accounts = await db.socialAccount.findMany({
        where: {
          tenantId: schedule.tenantId,
          isActive: true,
          healthScore: { gte: 30 },
          NOT: { AND: [{ authMethod: 'private' }, { warmupStatus: 'cold' }] },
          OR: [
            ...(schedule.socialAccountIds.length > 0 ? [{ id: { in: schedule.socialAccountIds } }] : []),
            ...(schedule.accountGroupId ? [{ accountGroupId: schedule.accountGroupId }] : []),
          ],
        },
        select: { id: true },
      });
      if (accounts.length === 0) {
        await db.distributeSchedule.update({
          where: { id: schedule.id },
          data: { lastError: 'No eligible accounts (inactive, cold or low health)' },
        });
        continue;
      }

      // 2. Pick fresh variants: completed, never scheduled or published anywhere.
      const variants = await db.uniqueVariant.findMany({
        where: {
          tenantId: schedule.tenantId,
          status: 'completed',
          outputKey: { not: null },
          ...(schedule.uniquifyJobId ? { uniquifyJobId: schedule.uniquifyJobId } : {}),
          publishJobs: { none: {} },
          distributeItems: { none: {} },
        },
        orderBy: { createdAt: 'asc' },
        take: accounts.length * schedule.variantsPerAccount,
        select: { id: true, uniquifyJobId: true },
      });
      if (variants.length === 0) {
        await db.distributeSchedule.update({
          where: { id: schedule.id },
          data: { lastError: 'No unpublished completed variants available' },
        });
        continue;
      }

      // 3. Round-robin variants across accounts (≤ variantsPerAccount each),
      //    grouped by uniquify job because DistributeJob is scoped to one.
      const assignments = variants.map((v, i) => ({
        variantId: v.id,
        uniquifyJobId: v.uniquifyJobId,
        socialAccountId: accounts[i % accounts.length].id,
      }));
      const byUniquifyJob = new Map<string, typeof assignments>();
      for (const a of assignments) {
        const list = byUniquifyJob.get(a.uniquifyJobId) ?? [];
        list.push(a);
        byUniquifyJob.set(a.uniquifyJobId, list);
      }

      for (const [uniquifyJobId, items] of byUniquifyJob) {
        const distJob = await db.$transaction(async (tx) => {
          const dj = await tx.distributeJob.create({
            data: {
              tenantId: schedule.tenantId,
              uniquifyJobId,
              status: 'pending',
              staggerMinutes: schedule.staggerMinutes,
              captionTemplate: schedule.captionTemplate,
              hashtags: schedule.hashtags,
              totalItems: items.length,
            },
          });
          await tx.distributeItem.createMany({
            data: items.map((item) => ({
              distributeJobId: dj.id,
              uniqueVariantId: item.variantId,
              socialAccountId: item.socialAccountId,
              status: 'pending' as const,
            })),
          });
          return dj;
        });

        await distributeQueue.add(
          `distribute-${distJob.id}`,
          { distributeJobId: distJob.id, tenantId: schedule.tenantId } satisfies DistributeJobPayload,
        );

        logger.info(
          { scheduleId: schedule.id, distributeJobId: distJob.id, uniquifyJobId, items: items.length, nextRun },
          'Scheduler: auto-distribute job created',
        );
      }

      // Clear stale error from previous runs
      if (schedule.lastError) {
        await db.distributeSchedule.update({
          where: { id: schedule.id },
          data: { lastError: null },
        });
      }
    } catch (err: any) {
      logger.error({ scheduleId: schedule.id, err: err.message }, 'Scheduler: distribute schedule failed');
      await db.distributeSchedule.update({
        where: { id: schedule.id },
        data: { lastError: String(err.message ?? err).slice(0, 1000) },
      }).catch(() => {});
    }
  }
}
