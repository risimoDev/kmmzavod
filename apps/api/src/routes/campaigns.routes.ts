/**
 * Campaign routes — end-to-end content autopilot (see docs/CAMPAIGNS_PLAN.md).
 *
 * A campaign ties content SUPPLY (ready uniquified variants) to publishing DEMAND
 * (accounts × posts/day). Phase 1 distributes already-ready variants on a cron to
 * eligible farm accounts; the control loop lives in the orchestrator scheduler.
 * These routes own the DB rows + lifecycle transitions.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { logger } from '../logger';

const PLATFORMS = ['tiktok', 'instagram', 'youtube_shorts', 'postbridge'] as const;

const CampaignShape = z.object({
  name: z.string().min(1).max(200),
  productId: z.string().uuid().optional(),
  contentSource: z.enum(['uniquify', 'generate', 'montage', 'manual']).default('uniquify'),
  sourceConfig: z.record(z.unknown()).default({}),
  bufferDays: z.number().int().min(1).max(30).default(2),
  maxBuildAhead: z.number().int().min(1).max(500).default(50),
  accountGroupId: z.string().uuid().optional(),
  socialAccountIds: z.array(z.string().uuid()).default([]),
  platforms: z.array(z.enum(PLATFORMS)).default([]),
  postsPerAccountPerDay: z.number().int().min(1).max(20).default(1),
  cronExpression: z.string().min(5).max(100),
  timezone: z.string().max(50).default('Europe/Moscow'),
  staggerMinutes: z.number().int().min(1).max(1440).default(15),
  captionTemplate: z.string().max(2000).optional(),
  hashtags: z.array(z.string().max(100)).max(30).default([]),
  minHealth: z.number().int().min(0).max(100).default(30),
  dedupPerAccount: z.boolean().default(true),
  respectWarmup: z.boolean().default(false),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
});

const CreateBody = CampaignShape.refine((b) => b.socialAccountIds.length > 0 || b.accountGroupId, {
  message: 'Provide socialAccountIds and/or accountGroupId',
});

const UpdateBody = CampaignShape.partial(); // all optional for PATCH

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  async function validateRefs(tenantId: string, b: {
    productId?: string; accountGroupId?: string; socialAccountIds?: string[];
  }): Promise<string | null> {
    if (b.productId) {
      const p = await db.product.findFirst({ where: { id: b.productId, tenantId }, select: { id: true } });
      if (!p) return 'Product not found';
    }
    if (b.accountGroupId) {
      const g = await db.accountGroup.findFirst({ where: { id: b.accountGroupId, tenantId }, select: { id: true } });
      if (!g) return 'Account group not found';
    }
    if (b.socialAccountIds?.length) {
      const n = await db.socialAccount.count({ where: { id: { in: b.socialAccountIds }, tenantId } });
      if (n !== b.socialAccountIds.length) return 'Some social accounts do not belong to tenant';
    }
    return null;
  }

  // ── List ──────────────────────────────────────────────────────────────────
  app.get('/', async (req) => {
    const { tenantId } = req.user;
    const campaigns = await db.campaign.findMany({
      where: { tenantId, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { name: true } } },
    });
    return { campaigns };
  });

  // ── Get one (+ recent runs + linked distribute jobs) ────────────────────────
  app.get('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const campaign = await db.campaign.findFirst({
      where: { id, tenantId },
      include: {
        product: { select: { id: true, name: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 20 },
      },
    });
    if (!campaign) return reply.code(404).send({ error: 'NotFound' });

    const distributeJobs = await db.distributeJob.findMany({
      where: { campaignId: id, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, status: true, totalItems: true, publishedCount: true,
        failedCount: true, createdAt: true, staggerMinutes: true, error: true,
      },
    });

    // Live buffer snapshot (Phase-1 supply = completed unpublished variants).
    const cfg = (campaign.sourceConfig ?? {}) as { uniquifyJobIds?: string[] };
    const variantWhere = {
      tenantId,
      status: 'completed' as const,
      outputKey: { not: null },
      publishJobs: { none: {} },
      distributeItems: { none: {} },
      ...(cfg.uniquifyJobIds?.length ? { uniquifyJobId: { in: cfg.uniquifyJobIds } } : {}),
    };
    const bufferReady = await db.uniqueVariant.count({ where: variantWhere });

    return { campaign, distributeJobs, bufferReady };
  });

  // ── Create (draft) ──────────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const { tenantId } = req.user;
    const b = CreateBody.parse(req.body);
    const err = await validateRefs(tenantId, b);
    if (err) return reply.code(400).send({ error: 'BadRequest', message: err });

    const campaign = await db.campaign.create({
      data: {
        tenantId,
        name: b.name,
        productId: b.productId,
        contentSource: b.contentSource,
        sourceConfig: b.sourceConfig as object,
        bufferDays: b.bufferDays,
        maxBuildAhead: b.maxBuildAhead,
        accountGroupId: b.accountGroupId,
        socialAccountIds: b.socialAccountIds,
        platforms: b.platforms,
        postsPerAccountPerDay: b.postsPerAccountPerDay,
        cronExpression: b.cronExpression,
        timezone: b.timezone,
        staggerMinutes: b.staggerMinutes,
        captionTemplate: b.captionTemplate,
        hashtags: b.hashtags,
        minHealth: b.minHealth,
        dedupPerAccount: b.dedupPerAccount,
        respectWarmup: b.respectWarmup,
        startAt: b.startAt ? new Date(b.startAt) : undefined,
        endAt: b.endAt ? new Date(b.endAt) : undefined,
        status: 'draft',
      },
    });
    logger.info({ campaignId: campaign.id, tenantId }, 'Campaign created');
    return reply.code(201).send({ campaign });
  });

  // ── Update (draft/paused only) ──────────────────────────────────────────────
  app.patch('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = UpdateBody.parse(req.body);

    const existing = await db.campaign.findFirst({ where: { id, tenantId } });
    if (!existing) return reply.code(404).send({ error: 'NotFound' });
    if (existing.status === 'active') {
      return reply.code(400).send({ error: 'BadRequest', message: 'Pause the campaign before editing' });
    }
    const err = await validateRefs(tenantId, b);
    if (err) return reply.code(400).send({ error: 'BadRequest', message: err });

    const campaign = await db.campaign.update({
      where: { id },
      data: {
        ...b,
        sourceConfig: b.sourceConfig as object | undefined,
        startAt: b.startAt ? new Date(b.startAt) : undefined,
        endAt: b.endAt ? new Date(b.endAt) : undefined,
      },
    });
    return { campaign };
  });

  // ── Lifecycle transitions ───────────────────────────────────────────────────
  app.post('/:id/activate', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId } });
    if (!c) return reply.code(404).send({ error: 'NotFound' });
    if (c.status === 'active') return { campaign: c };

    // Validate at least one account is in scope.
    const inScope = await db.socialAccount.count({
      where: {
        tenantId, isActive: true,
        OR: [
          ...(c.socialAccountIds.length ? [{ id: { in: c.socialAccountIds } }] : []),
          ...(c.accountGroupId ? [{ accountGroupId: c.accountGroupId }] : []),
        ],
      },
    });
    if (inScope === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Нет активных аккаунтов в охвате кампании' });
    }

    const campaign = await db.campaign.update({
      where: { id },
      data: { status: 'active', lastError: null, nextRunAt: new Date() }, // first tick asap
    });
    logger.info({ campaignId: id }, 'Campaign activated');
    return { campaign };
  });

  app.post('/:id/pause', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!c) return reply.code(404).send({ error: 'NotFound' });
    const campaign = await db.campaign.update({ where: { id }, data: { status: 'paused' } });
    return { campaign };
  });

  app.post('/:id/complete', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!c) return reply.code(404).send({ error: 'NotFound' });
    const campaign = await db.campaign.update({ where: { id }, data: { status: 'completed' } });
    return { campaign };
  });

  // ── Manual tick (debug / "run now") — makes the scheduler pick it up next tick.
  app.post('/:id/run-now', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId }, select: { id: true, status: true } });
    if (!c) return reply.code(404).send({ error: 'NotFound' });
    if (c.status !== 'active') return reply.code(400).send({ error: 'BadRequest', message: 'Campaign is not active' });
    await db.campaign.update({ where: { id }, data: { nextRunAt: new Date() } });
    return { queued: true };
  });

  // ── Runs journal ────────────────────────────────────────────────────────────
  app.get('/:id/runs', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!c) return reply.code(404).send({ error: 'NotFound' });
    const runs = await db.campaignRun.findMany({
      where: { campaignId: id }, orderBy: { startedAt: 'desc' }, take: 50,
    });
    return { runs };
  });

  // ── Archive ─────────────────────────────────────────────────────────────────
  app.delete('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await db.campaign.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!c) return reply.code(404).send({ error: 'NotFound' });
    await db.campaign.update({ where: { id }, data: { status: 'archived' } });
    return reply.code(204).send();
  });
}
