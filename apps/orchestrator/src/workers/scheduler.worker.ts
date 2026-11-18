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
  nextCronDate,
  type SchedulerTickPayload,
  type PipelineJobPayload,
  type AccountWarmupPayload,
  type DistributeJobPayload,
  type PublishJobPayload,
} from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger as rootLogger } from '../logger';
import { runAutopilotsTick, type AutopilotLoopDeps } from '../autopilot/loop';
import { scoreUniquifyJob } from './uniquify-state.worker';
import { recoverPublishes } from '../lib/recover-publish';
import { runScheduledVideoJobs } from '../lib/scheduled-video';

const logger = rootLogger.child({ worker: 'scheduler' });

interface Deps {
  db: PrismaClient;
  pipelineQueue: Queue<PipelineJobPayload>;
  warmupQueue?: Queue<AccountWarmupPayload>;
  distributeQueue?: Queue<DistributeJobPayload>;
  publishQueue: Queue<PublishJobPayload>;
  /** Autopilot loop (montage → uniquify → phone farm); omitted → disabled. */
  autopilot?: Omit<AutopilotLoopDeps, 'db'>;
  connection: ConnectionOptions;
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
  const { db, pipelineQueue, warmupQueue, distributeQueue, autopilot, connection } = deps;

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

        // ── Campaigns (сквозной автопилот, Фаза 1: распределение) ──────────
        try {
          await runCampaignsTick(db, distributeQueue, now);
        } catch (err: any) {
          logger.error({ err: err.message }, 'Scheduler: campaigns tick failed');
        }
      }

      // ── Autopilots (новая фабрика: монтаж → уникализация → ферма телефонов) ─
      if (autopilot) {
        try {
          await runAutopilotsTick({ db, ...autopilot }, now);
        } catch (err: any) {
          logger.error({ err: err.message }, 'Scheduler: autopilot tick failed');
        }
      }

      // ── Self-heal uniquify jobs stuck in generating/analyzing ────────────
      try {
        await recoverPublishes(db, deps.publishQueue, now);
      } catch (err) {
        logger.error({ err }, 'Scheduler: publish recovery failed');
      }

      // Safety net: if a state event was ever lost, finalize jobs whose variants
      // are all done. Idempotent and cheap (only touches active jobs).
      try {
        await reconcileStuckUniquifyJobs(db);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Scheduler: uniquify reconcile failed');
      }
      try {
        await db.$executeRaw`
          UPDATE social_accounts AS account SET daily_post_count = 0
          WHERE daily_post_count > 0 AND (
            last_post_at IS NULL OR EXISTS (
              SELECT 1 FROM (SELECT COALESCE((
                SELECT zone.name FROM account_groups AS grp
                JOIN pg_timezone_names AS zone ON zone.name = grp.timezone
                WHERE grp.id = account.account_group_id
              ), 'UTC') AS name) AS tz
              WHERE (last_post_at AT TIME ZONE 'UTC' AT TIME ZONE tz.name)::date
                < (${now}::timestamptz AT TIME ZONE tz.name)::date
            )
          )
        `;
      } catch (err) {
        logger.error({ err }, 'Scheduler: daily reset failed');
      }

      await runScheduledVideoJobs(db, pipelineQueue, now);
    },
    {
      connection,
      concurrency: QUEUES['scheduler'].concurrency,
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-heal: finalize uniquify jobs whose variants are all done but that never
// flipped out of generating/analyzing (lost state event / historical bug).
// ─────────────────────────────────────────────────────────────────────────────

async function reconcileStuckUniquifyJobs(db: PrismaClient): Promise<void> {
  const stuck = await db.uniquifyJob.findMany({
    where: { status: { in: ['generating', 'analyzing'] } },
    select: { id: true, variantCount: true },
  });
  for (const job of stuck) {
    const [completed, failed, total] = await Promise.all([
      db.uniqueVariant.count({ where: { uniquifyJobId: job.id, status: 'completed' } }),
      db.uniqueVariant.count({ where: { uniquifyJobId: job.id, status: 'failed' } }),
      db.uniqueVariant.count({ where: { uniquifyJobId: job.id } }),
    ]);
    // All expected variants exist AND all have terminal status.
    if (total >= job.variantCount && completed + failed >= job.variantCount) {
      const allFailed = completed === 0;
      await db.uniquifyJob.update({
        where: { id: job.id },
        data: {
          status: allFailed ? 'failed' : 'completed',
          completedCount: completed,
          failedCount: failed,
          completedAt: new Date(),
          error: allFailed ? `All ${failed} variants failed` : null,
        },
      });
      logger.info({ uniquifyJobId: job.id, completed, failed }, 'Scheduler: reconciled stuck uniquify job');
      if (!allFailed) await scoreUniquifyJob(db, job.id).catch(() => {});
    }
  }
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

  // 1b. Physical Phone Farm (authMethod=device): schedule daily smart view warmup
  const deviceAccounts = await db.socialAccount.findMany({
    where: {
      isActive: true,
      authMethod: 'device',
      deviceId: { not: null },
      platform: { in: ['instagram', 'tiktok'] },
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

  for (const acc of deviceAccounts) {
    const day = now.toISOString().slice(0, 10);
    await warmupQueue.add(
      `warmup:device:${acc.id}`,
      { socialAccountId: acc.id, tenantId: acc.tenantId },
      {
        jobId: `warmup-device-${acc.id}-${day}`,
        delay: Math.floor(Math.random() * 3 * 3600_000),
      },
    );
  }
  if (deviceAccounts.length > 0) {
    logger.info({ count: deviceAccounts.length }, 'Scheduler: device farm warmup sessions enqueued');
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
      // 1. Resolve target accounts. Only the hard, non-recoverable filters here
      //    (active, healthy) — the distribute worker applies the per-account
      //    warmup gate, session check, daily limit and 3h-gap at send time.
      const scope = {
        tenantId: schedule.tenantId,
        OR: [
          ...(schedule.socialAccountIds.length > 0 ? [{ id: { in: schedule.socialAccountIds } }] : []),
          ...(schedule.accountGroupId ? [{ accountGroupId: schedule.accountGroupId }] : []),
        ],
      };
      const accounts = await db.socialAccount.findMany({
        where: { ...scope, isActive: true, healthScore: { gte: 30 } },
        select: { id: true },
      });
      if (accounts.length === 0) {
        // Explain precisely why (helps the user fix it, e.g. all inactive).
        const [total, inactive, lowHealth] = await Promise.all([
          db.socialAccount.count({ where: scope }),
          db.socialAccount.count({ where: { ...scope, isActive: false } }),
          db.socialAccount.count({ where: { ...scope, healthScore: { lt: 30 } } }),
        ]);
        const reason = total === 0
          ? 'No accounts match this schedule (check group / selected accounts)'
          : `No eligible accounts of ${total}: ${inactive} inactive, ${lowHealth} low-health (<30)`;
        await db.distributeSchedule.update({
          where: { id: schedule.id }, data: { lastError: reason },
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
          await tx.queueIntent.create({ data: {
            queue: distributeQueue.name, name: `distribute-${dj.id}`,
            payload: { distributeJobId: dj.id, tenantId: schedule.tenantId },
          } });
          return dj;
        });

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

// ─────────────────────────────────────────────────────────────────────────────
// Campaigns control loop (Phase 1 — distribute ready variants).
// See docs/CAMPAIGNS_PLAN.md. Reuses the same anti-ban gates as distribution:
// readiness is re-checked in distribute.worker; here we do cheap pre-filters,
// per-account daily cadence, and pHash dedup so we don't create doomed items.
// ─────────────────────────────────────────────────────────────────────────────

/** Hamming distance on equal-length hex/binary phash strings (best-effort). */
function phashClose(a: string | null, b: string | null, maxDist = 6): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d <= maxDist;
}

async function runCampaignsTick(
  db: PrismaClient,
  distributeQueue: Queue<DistributeJobPayload>,
  now: Date,
): Promise<void> {
  const due = await db.campaign.findMany({
    where: {
      status: 'active',
      nextRunAt: { lte: now },
      OR: [{ startAt: null }, { startAt: { lte: now } }],
    },
  });
  if (due.length === 0) return;

  const startOfDayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (const c of due) {
    // Auto-complete when the end date has passed.
    if (c.endAt && c.endAt <= now) {
      await db.campaign.update({ where: { id: c.id }, data: { status: 'completed' } });
      continue;
    }

    const nextRun = nextCronDate(c.cronExpression, c.timezone ?? 'Europe/Moscow', now);
    await db.campaign.update({
      where: { id: c.id },
      data: { lastRunAt: now, nextRunAt: nextRun },
    });

    const run = await db.campaignRun.create({
      data: { campaignId: c.id, tenantId: c.tenantId, kind: 'distribute' },
    });
    const summary: Record<string, unknown> = {};

    try {
      // 1. Eligible accounts: active, healthy, has session (private), warmup ok.
      const accounts = await db.socialAccount.findMany({
        where: {
          tenantId: c.tenantId,
          isActive: true,
          healthScore: { gte: c.minHealth },
          ...(c.platforms.length ? { platform: { in: c.platforms } } : {}),
          OR: [
            ...(c.socialAccountIds.length ? [{ id: { in: c.socialAccountIds } }] : []),
            ...(c.accountGroupId ? [{ accountGroupId: c.accountGroupId }] : []),
          ],
        },
        select: {
          id: true, platform: true, authMethod: true, deviceId: true, sessionData: true,
          warmupStatus: true, dailyPostCount: true,
          accountGroup: { select: { enforceWarmup: true } },
        },
      });

      const eligible = accounts.filter((a) => {
        if (a.authMethod === 'private' && !a.sessionData) return false;
        if (a.authMethod === 'device' && !a.deviceId) return false;
        const warmupBlocks = (a.authMethod === 'private' || a.authMethod === 'device') &&
          a.warmupStatus === 'cold' &&
          (c.respectWarmup || a.accountGroup?.enforceWarmup === true);
        return !warmupBlocks;
      });

      if (eligible.length === 0) {
        summary.skipped = 'no eligible accounts';
        await db.campaign.update({ where: { id: c.id }, data: { lastError: 'Нет пригодных аккаунтов (сессия/health/warmup)' } });
        await db.campaignRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary: summary as any } });
        continue;
      }

      // 2. Per-account daily slots (postsPerAccountPerDay − already posted today).
      const slotsByAccount = new Map<string, number>();
      for (const a of eligible) {
        const postedToday = await db.publishJob.count({
          where: { socialAccountId: a.id, status: 'published', publishedAt: { gte: startOfDayUTC } },
        });
        const free = c.postsPerAccountPerDay - postedToday;
        if (free > 0) slotsByAccount.set(a.id, free);
      }
      const totalSlots = [...slotsByAccount.values()].reduce((s, n) => s + n, 0);
      if (totalSlots === 0) {
        summary.skipped = 'daily quota reached for all accounts';
        await db.campaignRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary: summary as any } });
        continue;
      }

      // 3. Fresh ready variants (completed, never scheduled/published).
      const cfg = (c.sourceConfig ?? {}) as { uniquifyJobIds?: string[] };
      const variants = await db.uniqueVariant.findMany({
        where: {
          tenantId: c.tenantId,
          status: 'completed',
          outputKey: { not: null },
          publishJobs: { none: {} },
          distributeItems: { none: {} },
          ...(cfg.uniquifyJobIds?.length ? { uniquifyJobId: { in: cfg.uniquifyJobIds } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: totalSlots * 2, // headroom for dedup rejects
        select: { id: true, uniquifyJobId: true, pHash: true },
      });
      if (variants.length === 0) {
        summary.skipped = 'no ready variants in buffer';
        await db.campaign.update({ where: { id: c.id }, data: { lastError: 'Буфер пуст: нет готовых неопубликованных вариантов' } });
        await db.campaignRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary: summary as any } });
        continue;
      }

      // 4. Assign variants to accounts (round-robin over slots) with pHash dedup:
      //    don't send an account a variant close to one it already received.
      const sentPhashes = new Map<string, string[]>(); // accountId → phashes
      if (c.dedupPerAccount) {
        const prior = await db.distributeItem.findMany({
          where: { socialAccount: { tenantId: c.tenantId }, uniqueVariant: { pHash: { not: null } } },
          select: { socialAccountId: true, uniqueVariant: { select: { pHash: true } } },
          take: 5000,
        });
        for (const p of prior) {
          const list = sentPhashes.get(p.socialAccountId) ?? [];
          if (p.uniqueVariant.pHash) list.push(p.uniqueVariant.pHash);
          sentPhashes.set(p.socialAccountId, list);
        }
      }

      const accountIds = [...slotsByAccount.keys()];
      const assignments: { variantId: string; uniquifyJobId: string; socialAccountId: string }[] = [];
      let vIdx = 0;
      for (const accId of accountIds) {
        let slots = slotsByAccount.get(accId) ?? 0;
        while (slots > 0 && vIdx < variants.length) {
          const v = variants[vIdx];
          // dedup check
          const seen = sentPhashes.get(accId) ?? [];
          if (c.dedupPerAccount && v.pHash && seen.some((h) => phashClose(h, v.pHash))) {
            vIdx++; continue;
          }
          assignments.push({ variantId: v.id, uniquifyJobId: v.uniquifyJobId, socialAccountId: accId });
          seen.push(v.pHash ?? '');
          sentPhashes.set(accId, seen);
          slots--; vIdx++;
        }
      }

      if (assignments.length === 0) {
        summary.skipped = 'all candidate variants were dedup-filtered';
        await db.campaignRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary: summary as any } });
        continue;
      }

      // 5. Group by uniquify job (DistributeJob is scoped to one) and enqueue.
      const byJob = new Map<string, typeof assignments>();
      for (const a of assignments) {
        const list = byJob.get(a.uniquifyJobId) ?? [];
        list.push(a);
        byJob.set(a.uniquifyJobId, list);
      }

      let created = 0;
      for (const [uniquifyJobId, items] of byJob) {
        await db.$transaction(async (tx) => {
          const dj = await tx.distributeJob.create({
            data: {
              tenantId: c.tenantId,
              uniquifyJobId,
              campaignId: c.id,
              status: 'pending',
              staggerMinutes: c.staggerMinutes,
              captionTemplate: c.captionTemplate,
              hashtags: c.hashtags,
              totalItems: items.length,
            },
          });
          await tx.distributeItem.createMany({
            data: items.map((it) => ({
              distributeJobId: dj.id,
              uniqueVariantId: it.variantId,
              socialAccountId: it.socialAccountId,
              status: 'pending' as const,
            })),
          });
          await tx.queueIntent.create({ data: {
            queue: distributeQueue.name, name: `distribute-${dj.id}`,
            payload: { distributeJobId: dj.id, tenantId: c.tenantId },
          } });
        });
        created += items.length;
      }

      summary.distributed = created;
      summary.accounts = accountIds.length;
      await db.campaign.update({
        where: { id: c.id },
        data: { lastError: null },
      });
      await db.campaignRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary: summary as any } });
      logger.info({ campaignId: c.id, distributed: created, nextRun }, 'Scheduler: campaign distributed');
    } catch (err: any) {
      const msg = String(err.message ?? err).slice(0, 1000);
      logger.error({ campaignId: c.id, err: msg }, 'Scheduler: campaign tick failed');
      await db.campaignRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), error: msg, summary: summary as any } }).catch(() => {});
      await db.campaign.update({ where: { id: c.id }, data: { lastError: msg } }).catch(() => {});
    }
  }
}
