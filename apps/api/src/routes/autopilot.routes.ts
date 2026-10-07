/**
 * Autopilot routes — the new "factory": configure once per project, then every
 * day the orchestrator loop (apps/orchestrator/src/autopilot/loop.ts) produces
 * montages (AI script + voice + smart editor), uniquifies them into N copies and
 * publishes one copy per phone-farm account at each publish window.
 *
 * These routes own configuration + lifecycle + observability; the loop owns work.
 * See docs/AUTOPILOT_PLAN.md.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { FISH_VOICES } from '@kmmzavod/ai';
import { aiStatus } from '../lib/ai';
import { config } from '../config';

const PLATFORMS = ['tiktok', 'instagram', 'youtube_shorts', 'postbridge'] as const;
const SCRIPT_STYLES = ['blogger', 'story', 'review', 'hype', 'educational', 'sales', 'humor', 'minimal'] as const;
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

const Shape = z.object({
  name: z.string().min(1).max(200),
  projectId: z.string().uuid(),
  // Montage
  montageMode: z.enum(['single', 'multi']).default('multi'),
  sourcesPerMontage: z.number().int().min(2).max(10).default(3),
  sourceStrategy: z.enum(['fresh_first', 'pool', 'fresh_only']).default('fresh_first'),
  pace: z.enum(['calm', 'normal', 'fast']).default('normal'),
  targetSeconds: z.number().int().min(10).max(90).default(30),
  aspect: z.enum(['9:16', '1:1', '4:5', '16:9']).default('9:16'),
  subtitleStyle: z.string().max(40).default('tiktok'),
  smartCrop: z.boolean().default(true),
  bgmKeys: z.array(z.string().max(500)).max(50).default([]),
  // AI script + voice
  productInfo: z.string().max(3000).nullish(),
  scriptStyles: z.array(z.enum(SCRIPT_STYLES)).min(1).max(8).default(['blogger']),
  ctaType: z.enum(['article', 'direct', 'auto']).default('article'),
  directWord: z.string().max(50).nullish(),
  voiceIds: z.array(z.string().max(100)).max(10).default([]),
  voiceSpeed: z.number().min(0.5).max(2).default(1),
  // Uniquify
  uniquifyMode: z.enum(['preserve_context']).default('preserve_context'), // montage already carries the voice
  stealthLevel: z.enum(['standard', 'maximum']).default('maximum'),
  variantsPerMontage: z.number().int().min(1).max(50).nullish(),
  // Publishing (phone farm)
  accountGroupId: z.string().uuid().nullish(),
  socialAccountIds: z.array(z.string().uuid()).default([]),
  platforms: z.array(z.enum(PLATFORMS)).default([]),
  publishTimes: z.array(z.string().regex(HHMM, 'Формат HH:MM')).min(1).max(12),
  timezone: z.string().max(50).default('Europe/Moscow'),
  jitterMinutes: z.number().int().min(0).max(60).default(20),
  staggerMinutes: z.number().int().min(1).max(120).default(7),
  minHealth: z.number().int().min(0).max(100).default(30),
  captionTemplate: z.string().max(2000).nullish(),
  hashtags: z.array(z.string().max(100)).max(30).default([]),
  bufferWindows: z.number().int().min(1).max(10).default(2),
  maxParallelBatches: z.number().int().min(1).max(5).default(2),
});
const UpdateBody = Shape.partial();

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Normalize + validate publish windows. Returns sorted HH:MM list, errors and soft warnings. */
function checkWindows(times: string[], jitter: number): { times: string[]; error?: string; warnings: string[] } {
  const mins = [...new Set(times.map(toMinutes))].sort((a, b) => a - b);
  const norm = mins.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const warnings: string[] = [];
  if (mins.length > 1) {
    const gaps = mins.map((m, i) => (i === mins.length - 1 ? mins[0] + 1440 - m : mins[i + 1] - m));
    const minGap = Math.min(...gaps);
    if (minGap <= 2 * jitter + 1) {
      return { times: norm, warnings, error: `Окна слишком близко (${minGap} мин) для разброса ±${jitter} мин` };
    }
    if (minGap < 180) {
      warnings.push(`Между окнами ${minGap} мин: ферма держит ≥3 ч между постами одного аккаунта, поэтому часть постов сдвинется позже.`);
    }
  }
  return { times: norm, warnings };
}

function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

interface Targets {
  tenantId: string;
  accountGroupId?: string | null;
  socialAccountIds?: string[];
  platforms?: string[];
  minHealth?: number;
}

/**
 * Phone-farm accounts in scope + why each one can/can't post. Mirrors
 * eligibleAccounts() in the orchestrator loop (kept in sync by hand).
 */
async function scopeAccounts(t: Targets) {
  const targets = [
    ...(t.socialAccountIds?.length ? [{ id: { in: t.socialAccountIds } }] : []),
    ...(t.accountGroupId ? [{ accountGroupId: t.accountGroupId }] : []),
  ];
  const rows = await db.socialAccount.findMany({
    where: {
      tenantId: t.tenantId,
      authMethod: 'device',
      ...(t.platforms?.length ? { platform: { in: t.platforms as any } } : {}),
      ...(targets.length ? { OR: targets } : {}),
    },
    select: {
      id: true, platform: true, accountName: true, deviceId: true, isActive: true,
      healthScore: true, shadowBanDetected: true, warmupStatus: true,
      accountGroup: { select: { name: true, enforceWarmup: true } },
    },
    orderBy: { accountName: 'asc' },
  });
  const minHealth = t.minHealth ?? 30;
  return rows.map((a) => {
    const blockers: string[] = [];
    if (!a.isActive) blockers.push('отключён');
    if (!a.deviceId) blockers.push('телефон не привязан');
    if (a.shadowBanDetected) blockers.push('теневой бан');
    if (a.healthScore < minHealth) blockers.push(`health ${a.healthScore} < ${minHealth}`);
    if (a.warmupStatus === 'cold' && a.accountGroup?.enforceWarmup) blockers.push('не прогрет');
    return {
      id: a.id, platform: a.platform, accountName: a.accountName, deviceId: a.deviceId,
      group: a.accountGroup?.name ?? null, ok: blockers.length === 0, blockers,
    };
  });
}

async function sourceStats(tenantId: string, projectId: string, autopilotId?: string) {
  const pool = await db.sourceVideo.findMany({
    where: { tenantId, projectId, status: 'ready', isArchived: false, origin: 'upload', NOT: { storageKey: '' } },
    select: { id: true },
  });
  let fresh = pool.length;
  if (autopilotId && pool.length) {
    const used = new Set(
      (await db.autopilotBatch.findMany({
        where: { autopilotId, status: { not: 'failed' } },
        select: { sourceVideoIds: true },
      })).flatMap((b) => b.sourceVideoIds),
    );
    fresh = pool.filter((s) => !used.has(s.id)).length;
  }
  return { total: pool.length, fresh };
}

async function readyVariants(autopilotId: string): Promise<number> {
  const jobs = await db.autopilotBatch.findMany({
    where: { autopilotId, status: 'ready', uniquifyJobId: { not: null } },
    select: { uniquifyJobId: true },
  });
  const ids = jobs.map((j) => j.uniquifyJobId!).filter(Boolean);
  if (!ids.length) return 0;
  return db.uniqueVariant.count({
    where: { uniquifyJobId: { in: ids }, status: 'completed', outputKey: { not: null }, distributeItems: { none: {} } },
  });
}

/** «openrouter» = any LLM provider (OpenRouter or GPTunnel) is configured. */
async function aiKeyStatus() {
  const st = await aiStatus();
  return { openrouter: st.llmProviders.length > 0, fishAudio: st.fishAudio, llmProviders: st.llmProviders };
}

export async function autopilotRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  async function validateRefs(tenantId: string, b: Partial<z.infer<typeof Shape>>): Promise<string | null> {
    if (b.projectId) {
      const p = await db.project.findFirst({ where: { id: b.projectId, tenantId }, select: { id: true } });
      if (!p) return 'Проект не найден';
    }
    if (b.accountGroupId) {
      const g = await db.accountGroup.findFirst({ where: { id: b.accountGroupId, tenantId }, select: { id: true } });
      if (!g) return 'Группа аккаунтов не найдена';
    }
    if (b.socialAccountIds?.length) {
      const n = await db.socialAccount.count({ where: { id: { in: b.socialAccountIds }, tenantId } });
      if (n !== b.socialAccountIds.length) return 'Часть аккаунтов не принадлежит вам';
    }
    if (b.timezone && !isValidTz(b.timezone)) return `Неизвестный часовой пояс: ${b.timezone}`;
    return null;
  }

  // ── Wizard metadata: projects with footage counts, voices, AI key status ──
  app.get('/meta', async (req) => {
    const { tenantId } = req.user;
    const projects = await db.project.findMany({
      where: { tenantId, isArchived: false },
      select: { id: true, name: true, description: true },
      orderBy: { createdAt: 'desc' },
    });
    const counts = await db.sourceVideo.groupBy({
      by: ['projectId'],
      where: { tenantId, status: 'ready', isArchived: false, origin: 'upload', NOT: { storageKey: '' } },
      _count: { _all: true },
    });
    const groups = await db.accountGroup.findMany({ where: { tenantId }, select: { id: true, name: true } });
    return {
      projects: projects.map((p) => ({ ...p, sourceCount: counts.find((c) => c.projectId === p.id)?._count._all ?? 0 })),
      groups,
      voices: FISH_VOICES,
      aiKeys: await aiKeyStatus(),
    };
  });

  // ── Readiness preview for the wizard ───────────────────────────────────────
  app.post('/preview', async (req) => {
    const { tenantId } = req.user;
    const b = UpdateBody.parse(req.body ?? {});
    const accounts = await scopeAccounts({ tenantId, ...b });
    const sources = b.projectId ? await sourceStats(tenantId, b.projectId) : { total: 0, fresh: 0 };
    const window = b.publishTimes?.length ? checkWindows(b.publishTimes, b.jitterMinutes ?? 20) : null;
    const eligible = accounts.filter((a) => a.ok).length;
    return {
      accounts,
      eligible,
      sources,
      postsPerDay: eligible * (window?.times.length ?? 0),
      windowError: window?.error ?? null,
      warnings: window?.warnings ?? [],
    };
  });

  // ── List ───────────────────────────────────────────────────────────────────
  app.get('/', async (req) => {
    const { tenantId } = req.user;
    const rows = await db.autopilot.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { project: { select: { name: true } } },
    });
    const inflight = await db.autopilotBatch.groupBy({
      by: ['autopilotId'],
      where: { autopilotId: { in: rows.map((r) => r.id) }, status: { in: ['pending', 'scripting', 'analyzing', 'rendering', 'uniquifying'] } },
      _count: { _all: true },
    });
    const autopilots = await Promise.all(rows.map(async (r) => ({
      ...r,
      inFlight: inflight.find((i) => i.autopilotId === r.id)?._count._all ?? 0,
      readyVariants: await readyVariants(r.id),
    })));
    return { autopilots };
  });

  // ── Detail ─────────────────────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ap = await db.autopilot.findFirst({
      where: { id, tenantId },
      include: { project: { select: { id: true, name: true } } },
    });
    if (!ap) return reply.code(404).send({ error: 'NotFound' });

    const [batches, runs, accounts, sources, ready, posts] = await Promise.all([
      db.autopilotBatch.findMany({ where: { autopilotId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
      db.autopilotRun.findMany({ where: { autopilotId: id }, orderBy: { createdAt: 'desc' }, take: 80 }),
      scopeAccounts({ ...ap, tenantId }),
      sourceStats(tenantId, ap.projectId, ap.id),
      readyVariants(ap.id),
      db.distributeItem.findMany({
        where: { distributeJob: { autopilotId: id } },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: {
          id: true, status: true, scheduledAt: true, publishedAt: true, error: true, createdAt: true,
          socialAccount: { select: { accountName: true, platform: true, deviceId: true } },
          publishJob: { select: { status: true, externalPostId: true, error: true } },
          uniqueVariant: { select: { id: true, variantIndex: true, thumbnailKey: true, uniquifyJobId: true } },
        },
      }),
    ]);

    // Enrich batches with child-entity progress for the timeline.
    const ujIds = batches.map((b) => b.uniquifyJobId).filter((x): x is string => Boolean(x));
    const ujs = ujIds.length
      ? await db.uniquifyJob.findMany({ where: { id: { in: ujIds } }, select: { id: true, variantCount: true, completedCount: true, failedCount: true } })
      : [];
    const thumbs = new Map<string, string | null>();
    const epIds = batches.map((b) => b.editProjectId).filter((x): x is string => Boolean(x));
    if (epIds.length) {
      const clips = await db.editClip.findMany({
        where: { projectId: { in: epIds }, included: true },
        select: { projectId: true, thumbnailKey: true },
      });
      for (const c of clips) if (!thumbs.has(c.projectId)) thumbs.set(c.projectId, c.thumbnailKey);
    }
    const presign = async (key: string | null | undefined) =>
      key ? app.storage.presignedUrl(key, 3600).catch(() => null) : null;

    return {
      autopilot: ap,
      batches: await Promise.all(batches.map(async (b) => ({
        ...b,
        uniquify: ujs.find((u) => u.id === b.uniquifyJobId) ?? null,
        thumbnailUrl: await presign(b.editProjectId ? thumbs.get(b.editProjectId) : null),
      }))),
      runs,
      accounts,
      sources,
      readyVariants: ready,
      posts: await Promise.all(posts.map(async (p) => ({
        ...p,
        thumbnailUrl: await presign(p.uniqueVariant.thumbnailKey),
      }))),
      aiKeys: await aiKeyStatus(),
    };
  });

  // ── Create ─────────────────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const { tenantId } = req.user;
    const b = Shape.parse(req.body);
    const refErr = await validateRefs(tenantId, b);
    if (refErr) return reply.code(400).send({ error: 'BadRequest', message: refErr });
    const w = checkWindows(b.publishTimes, b.jitterMinutes);
    if (w.error) return reply.code(400).send({ error: 'BadRequest', message: w.error });

    const ap = await db.autopilot.create({
      data: { ...b, publishTimes: w.times, tenantId, status: 'draft' } as any,
    });
    return reply.code(201).send({ autopilot: ap, warnings: w.warnings });
  });

  // ── Update ─────────────────────────────────────────────────────────────────
  app.patch('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = UpdateBody.parse(req.body);
    const ap = await db.autopilot.findFirst({ where: { id, tenantId } });
    if (!ap) return reply.code(404).send({ error: 'NotFound' });
    const refErr = await validateRefs(tenantId, b);
    if (refErr) return reply.code(400).send({ error: 'BadRequest', message: refErr });

    let warnings: string[] = [];
    const data: Record<string, unknown> = { ...b };
    if (b.publishTimes || b.jitterMinutes !== undefined) {
      const w = checkWindows(b.publishTimes ?? ap.publishTimes, b.jitterMinutes ?? ap.jitterMinutes);
      if (w.error) return reply.code(400).send({ error: 'BadRequest', message: w.error });
      data.publishTimes = w.times;
      warnings = w.warnings;
    }
    // Schedule changed → let the loop recompute the next window.
    if (b.publishTimes || b.timezone || b.jitterMinutes !== undefined) data.nextWindowAt = null;

    const updated = await db.autopilot.update({ where: { id }, data: data as any });
    return { autopilot: updated, warnings };
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  app.post('/:id/activate', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ap = await db.autopilot.findFirst({ where: { id, tenantId } });
    if (!ap) return reply.code(404).send({ error: 'NotFound' });

    const sources = await sourceStats(tenantId, ap.projectId, ap.id);
    if (sources.total === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'В проекте нет исходных видео — загрузите footage в проект' });
    }
    const keys = await aiKeyStatus();
    if (!keys.fishAudio) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Не задан ключ Fish Audio (Админ → Настройки → FISH_AUDIO_API_KEY) — без него нет озвучки' });
    }
    const accounts = await scopeAccounts({ ...ap, tenantId });
    const eligible = accounts.filter((a) => a.ok).length;

    const updated = await db.autopilot.update({
      where: { id },
      data: { status: 'active', consecutiveFailures: 0, lastError: null, nextWindowAt: null },
    });
    await db.autopilotRun.create({
      data: { autopilotId: id, tenantId, kind: 'info', message: `Автопилот запущен (телефонов готово: ${eligible}, исходников: ${sources.total})` },
    });
    return {
      autopilot: updated,
      warnings: [
        ...(eligible === 0 ? ['Нет готовых телефонов — монтаж начнётся, как только появится хотя бы один'] : []),
        ...(!keys.openrouter ? ['Ключ OpenRouter не задан — сценарии будут шаблонными'] : []),
      ],
    };
  });

  app.post('/:id/pause', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ap = await db.autopilot.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!ap) return reply.code(404).send({ error: 'NotFound' });
    const updated = await db.autopilot.update({ where: { id }, data: { status: 'paused' } });
    await db.autopilotRun.create({ data: { autopilotId: id, tenantId, kind: 'info', message: 'Автопилот поставлен на паузу' } });
    return { autopilot: updated };
  });

  /** One extra montage right now, regardless of buffer demand. */
  app.post('/:id/produce-now', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ap = await db.autopilot.findFirst({ where: { id, tenantId }, select: { status: true } });
    if (!ap) return reply.code(404).send({ error: 'NotFound' });
    if (ap.status !== 'active') return reply.code(400).send({ error: 'BadRequest', message: 'Сначала запустите автопилот' });
    await db.autopilot.update({ where: { id }, data: { forceProduce: true } });
    return { ok: true, message: 'Новый монтаж стартует в течение минуты' };
  });

  /** Open a publish window now (the next scheduled one is recomputed afterwards). */
  app.post('/:id/publish-now', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ap = await db.autopilot.findFirst({ where: { id, tenantId }, select: { status: true } });
    if (!ap) return reply.code(404).send({ error: 'NotFound' });
    if (ap.status !== 'active') return reply.code(400).send({ error: 'BadRequest', message: 'Сначала запустите автопилот' });
    await db.autopilot.update({ where: { id }, data: { nextWindowAt: new Date() } });
    return { ok: true, message: 'Публикация готовых копий начнётся в течение минуты' };
  });

  app.delete('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ap = await db.autopilot.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!ap) return reply.code(404).send({ error: 'NotFound' });
    await db.autopilot.delete({ where: { id } });
    return reply.code(204).send();
  });
}
