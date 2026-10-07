/**
 * Autopilot control loop — runs inside the 60s scheduler tick.
 *
 * Per active autopilot:
 *   1. ADVANCE  — move in-flight batches along analyze → render → uniquify → ready
 *                 by polling the real entities (EditProject / UniquifyJob status).
 *                 Self-healing: nothing depends on an event that could be lost.
 *   2. SUPPLY   — keep `bufferWindows` publish windows worth of unique variants
 *                 ready (+ in production); start a new montage batch when short.
 *   3. DEMAND   — at each publish window (wall-clock in the autopilot's timezone,
 *                 ± jitter) give every eligible phone account ≤1 fresh variant.
 *
 * Model: 1 window ≈ 1 montage → N unique variants → N phone accounts. An account
 * never receives two variants of the same montage; two accounts never receive
 * the same file.
 */
import type { Queue } from 'bullmq';
import {
  QUEUES,
  type AutopilotProducePayload,
  type EditorRenderJobPayload,
  type UniquifyAnalyzeJobPayload,
  type DistributeJobPayload,
} from '@kmmzavod/queue';
import type { PrismaClient, Autopilot } from '@kmmzavod/db';
import { logger as rootLogger } from '../logger';
import { nextWallClock, startOfZonedDay } from '../lib/tz';
import { journal, failBatch } from './journal';

const logger = rootLogger.child({ worker: 'autopilot-loop' });

export interface AutopilotLoopDeps {
  db: PrismaClient;
  produceQueue: Queue<AutopilotProducePayload>;
  editorRenderQueue: Queue<EditorRenderJobPayload>;
  uniquifyAnalyzeQueue: Queue<UniquifyAnalyzeJobPayload>;
  distributeQueue: Queue<DistributeJobPayload>;
}

const MIN = 60_000;
/** A stage taking longer than this is considered stuck (queues are shared, so generous). */
const STAGE_TIMEOUT_MIN: Record<string, number> = {
  pending: 30,
  scripting: 30,
  analyzing: 180,
  rendering: 180,
  uniquifying: 240,
};
/** A window missed by more than this (orchestrator was down) is skipped, not back-filled. */
const MAX_WINDOW_LATENESS_MIN = 90;
const IN_PROGRESS = ['pending', 'scripting', 'analyzing', 'rendering', 'uniquifying'] as const;
const ITEM_INFLIGHT = ['pending', 'scheduled', 'publishing'] as const;
const ITEM_COUNTED = ['pending', 'scheduled', 'publishing', 'published'] as const;

export async function runAutopilotsTick(deps: AutopilotLoopDeps, now: Date): Promise<void> {
  const { db } = deps;
  const active = await db.autopilot.findMany({ where: { status: 'active' } });
  for (const ap of active) {
    try {
      await tickOne(deps, ap, now);
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 1000);
      logger.error({ autopilotId: ap.id, err: msg }, 'Autopilot tick failed');
      await db.autopilot.update({ where: { id: ap.id }, data: { lastError: msg } }).catch(() => {});
    }
  }
}

async function tickOne(deps: AutopilotLoopDeps, ap: Autopilot, now: Date): Promise<void> {
  const { db } = deps;
  await advanceBatches(deps, ap, now);

  // Re-read: advancing may have flipped the autopilot to `error`.
  const fresh = await db.autopilot.findUnique({ where: { id: ap.id } });
  if (!fresh || fresh.status !== 'active') return;

  const accounts = await eligibleAccounts(db, fresh);
  if (accounts.length === 0) {
    await setLastErrorOnce(db, fresh, 'Нет пригодных телефонов: проверьте аккаунты (device + привязанный телефон + health + прогрев)');
  }
  // «Смонтировать сейчас» works even with no phones yet — handy to preview output.
  if (accounts.length > 0 || fresh.forceProduce) {
    await topUpSupply(deps, fresh, accounts.length, now);
  }

  // ── Publish windows ────────────────────────────────────────────────────────
  if (!fresh.nextWindowAt) {
    await db.autopilot.update({
      where: { id: fresh.id },
      data: { nextWindowAt: computeNextWindow(fresh, now), lastTickAt: now },
    });
    return;
  }
  if (now >= fresh.nextWindowAt) {
    const lateMin = (now.getTime() - fresh.nextWindowAt.getTime()) / MIN;
    if (lateMin > MAX_WINDOW_LATENESS_MIN) {
      await journal(db, fresh, 'info', `Окно ${fmtTime(fresh.nextWindowAt, fresh.timezone)} пропущено (система была недоступна ${Math.round(lateMin)} мин)`);
    } else if (accounts.length > 0) {
      await distributeWindow(deps, fresh, accounts, now);
    }
    await db.autopilot.update({
      where: { id: fresh.id },
      data: { lastWindowAt: now, nextWindowAt: computeNextWindow(fresh, now), lastTickAt: now },
    });
    return;
  }
  await db.autopilot.update({ where: { id: fresh.id }, data: { lastTickAt: now } });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ADVANCE
// ─────────────────────────────────────────────────────────────────────────────

async function advanceBatches(deps: AutopilotLoopDeps, ap: Autopilot, now: Date): Promise<void> {
  const { db } = deps;
  const batches = await db.autopilotBatch.findMany({
    where: { autopilotId: ap.id, status: { in: [...IN_PROGRESS] } },
    orderBy: { createdAt: 'asc' },
  });

  for (const b of batches) {
    const ageMin = (now.getTime() - b.stageStartedAt.getTime()) / MIN;
    const timedOut = ageMin > (STAGE_TIMEOUT_MIN[b.status] ?? 180);

    if (b.status === 'pending' || b.status === 'scripting') {
      if (timedOut) await failBatch(db, b.id, `Этап «${b.status}» не завершился за ${Math.round(ageMin)} мин`);
      continue;
    }

    if (b.status === 'analyzing' || b.status === 'rendering') {
      const ep = b.editProjectId
        ? await db.editProject.findUnique({ where: { id: b.editProjectId }, select: { id: true, status: true, error: true } })
        : null;
      if (!ep) { await failBatch(db, b.id, 'Проект монтажа удалён'); continue; }
      if (ep.status === 'failed') { await failBatch(db, b.id, `Монтаж: ${ep.error ?? 'ошибка редактора'}`); continue; }

      if (b.status === 'analyzing' && ep.status === 'ready') {
        // Auto-confirm the storyboard: keep the single best-scoring clip.
        const clips = await db.editClip.findMany({ where: { projectId: ep.id }, orderBy: { score: 'desc' } });
        if (clips.length === 0) { await failBatch(db, b.id, 'Редактор не предложил ни одного клипа (исходники слишком короткие?)'); continue; }
        await db.$transaction([
          db.editClip.updateMany({ where: { projectId: ep.id }, data: { included: false } }),
          db.editClip.update({ where: { id: clips[0].id }, data: { included: true } }),
          db.autopilotBatch.update({ where: { id: b.id }, data: { status: 'rendering', stageStartedAt: now } }),
        ]);
        await deps.editorRenderQueue.add(
          `autopilot-render-${ep.id}`,
          { projectId: ep.id, tenantId: ap.tenantId },
          QUEUES['editor-render'].defaultJobOptions as any,
        );
        await journal(db, ap, 'advance', `Монтаж #${b.id.slice(0, 8)}: раскадровка подтверждена, рендер`, { summary: { batchId: b.id, clipScore: Number(clips[0].score) } });
        continue;
      }

      if (b.status === 'rendering' && ep.status === 'completed') {
        await startUniquify(deps, ap, b.id, ep.id, now);
        continue;
      }

      if (timedOut) await failBatch(db, b.id, `Этап «${b.status}» не завершился за ${Math.round(ageMin)} мин (очередь редактора занята или сервис editor недоступен)`);
      continue;
    }

    if (b.status === 'uniquifying') {
      const uj = b.uniquifyJobId
        ? await db.uniquifyJob.findUnique({ where: { id: b.uniquifyJobId }, select: { status: true, completedCount: true, error: true } })
        : null;
      if (!uj) { await failBatch(db, b.id, 'Задача уникализации удалена'); continue; }
      if (uj.status === 'completed') {
        if (uj.completedCount === 0) { await failBatch(db, b.id, 'Уникализация не дала ни одного варианта'); continue; }
        await db.$transaction([
          db.autopilotBatch.update({ where: { id: b.id }, data: { status: 'ready', completedAt: now } }),
          db.autopilot.update({
            where: { id: ap.id },
            data: {
              montagesProduced: { increment: 1 },
              variantsProduced: { increment: uj.completedCount },
              consecutiveFailures: 0,
              lastError: null,
            },
          }),
        ]);
        await journal(db, ap, 'advance', `Монтаж #${b.id.slice(0, 8)} готов: ${uj.completedCount} уникальных копий в буфере`, { summary: { batchId: b.id, variants: uj.completedCount } });
        continue;
      }
      if (uj.status === 'failed' || uj.status === 'cancelled') {
        await failBatch(db, b.id, `Уникализация: ${uj.error ?? uj.status}`);
        continue;
      }
      if (timedOut) await failBatch(db, b.id, `Уникализация не завершилась за ${Math.round(ageMin)} мин`);
    }
  }
}

async function startUniquify(deps: AutopilotLoopDeps, ap: Autopilot, batchId: string, editProjectId: string, now: Date): Promise<void> {
  const { db } = deps;
  const batch = await db.autopilotBatch.findUniqueOrThrow({ where: { id: batchId } });
  const clip = await db.editClip.findFirst({
    where: { projectId: editProjectId, included: true, outputSourceVideoId: { not: null } },
  });
  if (!clip?.outputSourceVideoId) { await failBatch(db, batchId, 'Рендер монтажа не создал файл'); return; }

  const ep = await db.editProject.findUnique({ where: { id: editProjectId }, select: { config: true } });
  const cfg = (ep?.config ?? {}) as Record<string, unknown>;
  const captions = Array.isArray(cfg.socialCaptions) ? cfg.socialCaptions : undefined;

  const uj = await db.uniquifyJob.create({
    data: {
      tenantId: ap.tenantId,
      sourceVideoId: clip.outputSourceVideoId,
      status: 'pending',
      variantCount: Math.max(1, batch.variantCount),
      targetPlatforms: ap.platforms,
      config: {
        // Always preserve_context: remix_montage would re-voice the montage with a
        // different TTS and throw away the autopilot's script + voiceover.
        mode: 'preserve_context',
        stealthLevel: ap.stealthLevel === 'standard' ? 'standard' : 'maximum',
        // The montage already carries the AI voiceover, music and burned karaoke
        // subtitles — uniquify only perturbs it, never re-voices or re-subtitles.
        enableSubtitles: false,
        enableBgm: false,
        aspectRatio: ap.aspect,
        fps: 30,
        language: 'ru',
        targetSeconds: ap.targetSeconds,
        productInfo: ap.productInfo ?? undefined,
        ...(captions ? { captions } : {}),
        autopilotId: ap.id,
        autopilotBatchId: batchId,
      } as object,
    },
  });
  await db.autopilotBatch.update({
    where: { id: batchId },
    data: { status: 'uniquifying', uniquifyJobId: uj.id, stageStartedAt: now },
  });
  await deps.uniquifyAnalyzeQueue.add(
    `uniquify-analyze-${uj.id}`,
    { sourceVideoId: clip.outputSourceVideoId, tenantId: ap.tenantId, uniquifyJobId: uj.id },
  );
  await journal(db, ap, 'advance', `Монтаж #${batchId.slice(0, 8)} отрендерен → уникализация в ${uj.variantCount} копий`, { summary: { batchId, uniquifyJobId: uj.id } });
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts (phone farm only)
// ─────────────────────────────────────────────────────────────────────────────

interface EligibleAccount {
  id: string;
  platform: string;
  deviceId: string | null;
  maxPostsPerDay: number | null;
}

export async function eligibleAccounts(db: PrismaClient, ap: Autopilot): Promise<EligibleAccount[]> {
  const targets = [
    ...(ap.socialAccountIds.length ? [{ id: { in: ap.socialAccountIds } }] : []),
    ...(ap.accountGroupId ? [{ accountGroupId: ap.accountGroupId }] : []),
  ];
  const rows = await db.socialAccount.findMany({
    where: {
      tenantId: ap.tenantId,
      isActive: true,
      authMethod: 'device',
      deviceId: { not: null },
      shadowBanDetected: false,
      healthScore: { gte: ap.minHealth },
      ...(ap.platforms.length ? { platform: { in: ap.platforms } } : {}),
      // No explicit targets → every phone account of the tenant.
      ...(targets.length ? { OR: targets } : {}),
    },
    select: {
      id: true, platform: true, deviceId: true, warmupStatus: true,
      accountGroup: { select: { enforceWarmup: true, maxPostsPerDay: true } },
    },
  });
  return rows
    .filter((a) => !(a.warmupStatus === 'cold' && a.accountGroup?.enforceWarmup === true))
    .map((a) => ({ id: a.id, platform: a.platform, deviceId: a.deviceId, maxPostsPerDay: a.accountGroup?.maxPostsPerDay ?? null }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SUPPLY
// ─────────────────────────────────────────────────────────────────────────────

async function readyJobIds(db: PrismaClient, autopilotId: string): Promise<string[]> {
  const ready = await db.autopilotBatch.findMany({
    where: { autopilotId, status: 'ready', uniquifyJobId: { not: null } },
    select: { uniquifyJobId: true },
    orderBy: { createdAt: 'asc' },
  });
  return ready.map((b) => b.uniquifyJobId!).filter(Boolean);
}

export async function countReadyVariants(db: PrismaClient, autopilotId: string): Promise<number> {
  const jobIds = await readyJobIds(db, autopilotId);
  if (jobIds.length === 0) return 0;
  return db.uniqueVariant.count({
    where: { uniquifyJobId: { in: jobIds }, status: 'completed', outputKey: { not: null }, distributeItems: { none: {} } },
  });
}

async function topUpSupply(deps: AutopilotLoopDeps, ap: Autopilot, accountCount: number, now: Date): Promise<void> {
  const { db } = deps;
  const inFlight = await db.autopilotBatch.findMany({
    where: { autopilotId: ap.id, status: { in: [...IN_PROGRESS] } },
    select: { variantCount: true },
  });
  if (inFlight.length >= Math.max(1, ap.maxParallelBatches)) return;

  const ready = await countReadyVariants(db, ap.id);
  const expected = inFlight.reduce((s, b) => s + b.variantCount, 0);
  const demand = accountCount * Math.max(1, ap.bufferWindows);
  if (!ap.forceProduce && ready + expected >= demand) return;

  const sourceIds = await selectSources(db, ap);
  if (sourceIds.length === 0) {
    await setLastErrorOnce(db, ap,
      ap.sourceStrategy === 'fresh_only'
        ? 'Новые исходники закончились — загрузите видео в проект (режим «только свежие»)'
        : 'В проекте нет загруженных исходников — загрузите видео в проект');
    return;
  }

  const variantCount = Math.max(1, Math.min(ap.variantsPerMontage ?? (accountCount > 0 ? accountCount : 3), 50));
  if (ap.forceProduce) {
    await db.autopilot.update({ where: { id: ap.id }, data: { forceProduce: false } });
  }
  const batch = await db.autopilotBatch.create({
    data: {
      autopilotId: ap.id,
      tenantId: ap.tenantId,
      status: 'pending',
      sourceVideoIds: sourceIds,
      variantCount,
      stageStartedAt: now,
    },
  });
  await deps.produceQueue.add(
    `autopilot-produce-${batch.id}`,
    { batchId: batch.id, tenantId: ap.tenantId },
    { ...(QUEUES['autopilot-produce'].defaultJobOptions as any), jobId: `autopilot-produce-${batch.id}` },
  );
  logger.info({ autopilotId: ap.id, batchId: batch.id, ready, expected, demand }, 'Autopilot: new montage batch');
}

/**
 * Pick project sources for the next montage.
 *   fresh_first — never-used uploads first (newest first), then least-used pool
 *   fresh_only  — only never-used uploads (waits for new footage otherwise)
 *   pool        — least-used across the whole library, random tie-break
 * Autopilot/editor outputs are excluded (origin='upload' only).
 */
export async function selectSources(db: PrismaClient, ap: Autopilot): Promise<string[]> {
  const pool = await db.sourceVideo.findMany({
    where: {
      tenantId: ap.tenantId,
      projectId: ap.projectId,
      status: 'ready',
      isArchived: false,
      origin: 'upload',
      NOT: { storageKey: '' },
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  if (pool.length === 0) return [];

  const history = await db.autopilotBatch.findMany({
    where: { autopilotId: ap.id, status: { not: 'failed' } },
    select: { sourceVideoIds: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });
  const usage = new Map<string, { count: number; last: number }>();
  for (const h of history) {
    for (const id of h.sourceVideoIds) {
      const u = usage.get(id) ?? { count: 0, last: 0 };
      u.count++;
      u.last = Math.max(u.last, h.createdAt.getTime());
      usage.set(id, u);
    }
  }

  const want = ap.montageMode === 'single' ? 1 : Math.max(2, Math.min(ap.sourcesPerMontage, 10));
  const fresh = pool.filter((s) => !usage.has(s.id)).map((s) => s.id);
  const used = pool
    .filter((s) => usage.has(s.id))
    .map((s) => ({ id: s.id, ...usage.get(s.id)!, r: Math.random() }))
    .sort((a, b) => a.count - b.count || a.last - b.last || a.r - b.r)
    .map((s) => s.id);

  if (ap.sourceStrategy === 'fresh_only') return fresh.slice(0, want);
  if (ap.sourceStrategy === 'pool') {
    const all = [...fresh.map((id) => ({ id, count: 0, r: Math.random() })),
      ...used.map((id) => ({ id, count: usage.get(id)!.count, r: Math.random() }))]
      .sort((a, b) => a.count - b.count || a.r - b.r);
    return all.slice(0, want).map((s) => s.id);
  }
  return [...fresh, ...used].slice(0, want);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. DEMAND — one publish window
// ─────────────────────────────────────────────────────────────────────────────

async function distributeWindow(deps: AutopilotLoopDeps, ap: Autopilot, accounts: EligibleAccount[], now: Date): Promise<void> {
  const { db } = deps;
  const sod = startOfZonedDay(now, ap.timezone);
  const ids = accounts.map((a) => a.id);
  const windowsPerDay = Math.max(1, ap.publishTimes.length);

  // Today's load per account counts SCHEDULED items too (not just published),
  // so an account whose previous post is still uploading is never double-booked.
  const recent = await db.distributeItem.findMany({
    where: {
      socialAccountId: { in: ids },
      OR: [{ createdAt: { gte: sod }, status: { in: [...ITEM_COUNTED] } }, { status: { in: [...ITEM_INFLIGHT] } }],
    },
    select: { socialAccountId: true, status: true, createdAt: true },
  });
  const todayCount = new Map<string, number>();
  const inflight = new Set<string>();
  for (const r of recent) {
    if (r.createdAt >= sod && (ITEM_COUNTED as readonly string[]).includes(r.status)) {
      todayCount.set(r.socialAccountId, (todayCount.get(r.socialAccountId) ?? 0) + 1);
    }
    if ((ITEM_INFLIGHT as readonly string[]).includes(r.status)) inflight.add(r.socialAccountId);
  }

  const jobIds = await readyJobIds(db, ap.id);
  const variants = jobIds.length
    ? await db.uniqueVariant.findMany({
        where: { uniquifyJobId: { in: jobIds }, status: 'completed', outputKey: { not: null }, distributeItems: { none: {} } },
        select: { id: true, uniquifyJobId: true },
        orderBy: [{ createdAt: 'asc' }, { variantIndex: 'asc' }],
      })
    : [];

  // Which montages each account already got — never send two copies of one montage.
  const received = new Map<string, Set<string>>();
  if (jobIds.length) {
    const prior = await db.distributeItem.findMany({
      where: { socialAccountId: { in: ids }, uniqueVariant: { uniquifyJobId: { in: jobIds } } },
      select: { socialAccountId: true, uniqueVariant: { select: { uniquifyJobId: true } } },
    });
    for (const p of prior) {
      const set = received.get(p.socialAccountId) ?? new Set<string>();
      set.add(p.uniqueVariant.uniquifyJobId);
      received.set(p.socialAccountId, set);
    }
  }

  const skipped: Record<string, number> = {};
  const bump = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  const taken = new Set<string>();
  const assignments: { variantId: string; uniquifyJobId: string; socialAccountId: string }[] = [];

  for (const acc of shuffle(accounts)) {
    const quota = Math.min(windowsPerDay, acc.maxPostsPerDay ?? windowsPerDay);
    if ((todayCount.get(acc.id) ?? 0) >= quota) { bump('дневной лимит'); continue; }
    if (inflight.has(acc.id)) { bump('прошлый пост ещё публикуется'); continue; }
    const got = received.get(acc.id) ?? new Set<string>();
    const v = variants.find((x) => !taken.has(x.id) && !got.has(x.uniquifyJobId));
    if (!v) { bump('нет свежей копии'); continue; }
    taken.add(v.id);
    got.add(v.uniquifyJobId);
    received.set(acc.id, got);
    assignments.push({ variantId: v.id, uniquifyJobId: v.uniquifyJobId, socialAccountId: acc.id });
  }

  if (assignments.length === 0) {
    const reason = variants.length === 0
      ? 'Буфер пуст: к окну не готово ни одной уникальной копии (монтаж/уникализация не успели)'
      : `Никому не назначено: ${Object.entries(skipped).map(([k, n]) => `${k} ×${n}`).join(', ')}`;
    await journal(db, ap, 'distribute', `Окно ${fmtTime(now, ap.timezone)}: ${reason}`, { summary: { skipped } });
    if (variants.length === 0) await db.autopilot.update({ where: { id: ap.id }, data: { lastError: reason } });
    return;
  }

  const byJob = new Map<string, typeof assignments>();
  for (const a of assignments) byJob.set(a.uniquifyJobId, [...(byJob.get(a.uniquifyJobId) ?? []), a]);

  for (const [uniquifyJobId, items] of byJob) {
    const dj = await db.$transaction(async (tx) => {
      const job = await tx.distributeJob.create({
        data: {
          tenantId: ap.tenantId,
          uniquifyJobId,
          autopilotId: ap.id,
          status: 'pending',
          staggerMinutes: ap.staggerMinutes,
          captionTemplate: ap.captionTemplate,
          hashtags: ap.hashtags,
          totalItems: items.length,
        },
      });
      await tx.distributeItem.createMany({
        data: items.map((it) => ({
          distributeJobId: job.id,
          uniqueVariantId: it.variantId,
          socialAccountId: it.socialAccountId,
          status: 'pending' as const,
        })),
      });
      return job;
    });
    await deps.distributeQueue.add(`distribute-${dj.id}`, { distributeJobId: dj.id, tenantId: ap.tenantId });
  }

  await db.autopilot.update({
    where: { id: ap.id },
    data: { postsScheduled: { increment: assignments.length } },
  });
  await journal(db, ap, 'distribute',
    `Окно ${fmtTime(now, ap.timezone)}: ${assignments.length} постов поставлено в очередь телефонов` +
      (Object.keys(skipped).length ? ` (пропущено: ${Object.entries(skipped).map(([k, n]) => `${k} ×${n}`).join(', ')})` : ''),
    { summary: { scheduled: assignments.length, skipped, montages: byJob.size } });
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Next publish window = next wall-clock time + random jitter. We search from
 * `now + jitter + 1min` so a window that fired early (negative jitter) is not
 * picked again (windows are validated to be far apart than 2×jitter).
 */
export function computeNextWindow(ap: Pick<Autopilot, 'publishTimes' | 'timezone' | 'jitterMinutes'>, now: Date): Date | null {
  const j = Math.max(0, ap.jitterMinutes);
  const base = nextWallClock(ap.publishTimes, ap.timezone, new Date(now.getTime() + (j + 1) * MIN));
  if (!base) return null;
  const jitter = Math.round((Math.random() * 2 - 1) * j * MIN);
  const t = new Date(base.getTime() + jitter);
  return t.getTime() > now.getTime() + MIN ? t : base;
}

async function setLastErrorOnce(db: PrismaClient, ap: Autopilot, msg: string): Promise<void> {
  if (ap.lastError === msg) return;
  await db.autopilot.update({ where: { id: ap.id }, data: { lastError: msg } });
  await journal(db, ap, 'info', msg);
}

function fmtTime(d: Date, tz: string): string {
  return d.toLocaleTimeString('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
