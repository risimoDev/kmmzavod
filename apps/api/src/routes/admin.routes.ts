/**
 * Admin routes — cross-tenant platform management.
 *
 * All routes require role: admin | owner (app.requireAdmin).
 * All mutating actions are written to AdminAuditLog.
 *
 * Route prefix:  /api/v1/admin
 *
 * ─── Users ────────────────────────────────────────────────────────────────
 * GET    /users                     List all users (paginated, searchable)
 * GET    /users/:id                 User detail + sessions + recent jobs
 * PATCH  /users/:id                 Update role / ban / unban
 *
 * ─── Tenants ──────────────────────────────────────────────────────────────
 * GET    /tenants                   List all tenants
 * GET    /tenants/:id               Tenant detail + usage + billing
 * PATCH  /tenants/:id               Update plan / name / limits
 * PATCH  /tenants/:id/suspend       Deactivate
 * PATCH  /tenants/:id/reinstate     Reactivate
 * PATCH  /tenants/:id/credits       Grant / deduct credits
 *
 * ─── Videos ───────────────────────────────────────────────────────────────
 * GET    /videos                    All videos across tenants
 * DELETE /videos/:id                Hard-delete video + cascade
 *
 * ─── Jobs ─────────────────────────────────────────────────────────────────
 * GET    /jobs                      All jobs (paginated, filterable)
 * GET    /jobs/:id                  Job detail (scenes + event timeline)
 * POST   /jobs/:id/retry            Re-enqueue failed job
 * POST   /jobs/:id/recompose        Re-compose using existing assets (no regen)
 * POST   /jobs/:id/cancel           Cancel job
 *
 * ─── Platform ─────────────────────────────────────────────────────────────
 * GET    /stats                     Platform KPI overview
 * GET    /queue-stats               BullMQ queue counts for all 7 queues
 * GET    /usage                     Daily usage aggregates (last 30 days)
 * GET    /generations               AI generation records (cost breakdown)
 * GET    /settings                  All AdminSettings
 * PUT    /settings/:key             Upsert AdminSetting
 * DELETE /settings/:key             Remove AdminSetting
 * GET    /audit                     AdminAuditLog
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { pipelineQueue, videoComposeQueue, gptScriptQueue, heygenQueue, imageGenQueue, ALL_QUEUES } from '../lib/queues';
import { QUEUE_DEFS } from '@kmmzavod/queue';
import { logger } from '../logger';
import { config } from '../config';
import { getProxyUrl, proxyFetch, proxyFetchStrict } from '../lib/proxy';
import { Pagination, audit } from './admin/shared';
import { pipelineTestRoutes } from './admin/pipeline-test.routes';

// ── Zod schemas ───────────────────────────────────────────────────────────────
// Pagination & audit are imported from ./admin/shared

const UsersQuery = Pagination.extend({
  search:   z.string().optional(),
  tenantId: z.string().uuid().optional(),
  role:     z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  active:   z.string().optional().transform(v => v === undefined ? undefined : v === 'true' || v === '1'),
});

const TenantsQuery = Pagination.extend({
  search: z.string().optional(),
  plan:   z.enum(['starter', 'pro', 'enterprise']).optional(),
  active: z.string().optional().transform(v => v === undefined ? undefined : v === 'true' || v === '1'),
});

const VideoQuery = Pagination.extend({
  tenantId: z.string().uuid().optional(),
  status:   z.string().optional(),
  from:     z.coerce.date().optional(),
  to:       z.coerce.date().optional(),
});

const JobsQuery = Pagination.extend({
  tenantId: z.string().uuid().optional(),
  status:   z.string().optional(),
});

const UsageQuery = z.object({
  tenantId: z.string().uuid().optional(),
  from:     z.coerce.date().default(() => new Date(Date.now() - 30 * 86400_000)),
  to:       z.coerce.date().default(() => new Date()),
});

const GenerationsQuery = Pagination.extend({
  tenantId: z.string().uuid().optional(),
  provider: z.string().optional(),
  from:     z.coerce.date().optional(),
  to:       z.coerce.date().optional(),
});

const AuditQuery = Pagination.extend({
  adminId:    z.string().uuid().optional(),
  targetType: z.string().optional(),
  action:     z.string().optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

const ListJobsQuery = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function adminRoutes(app: FastifyInstance) {
  // Global guard — all admin routes require admin/owner role
  app.addHook('preHandler', app.requireAdmin);

  // ── PLATFORM STATS ─────────────────────────────────────────────────────────

  // GET /api/v1/admin/stats
  app.get('/stats', async (_req, reply) => {
    const now     = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      tenantTotal, tenantActive,
      userTotal,
      videoTotal,   videoCompletedToday, videoFailedToday,
      jobRunning,   jobFailed,
      creditBalance,
      costToday,
    ] = await Promise.all([
      db.tenant.count(),
      db.tenant.count({ where: { isActive: true } }),
      db.user.count(),
      db.video.count(),
      db.video.count({ where: { status: 'completed', updatedAt: { gte: todayStart } } }),
      db.video.count({ where: { status: 'failed',    updatedAt: { gte: todayStart } } }),
      db.job.count({ where: { status: { in: ['running', 'processing', 'composing'] } } }),
      db.job.count({ where: { status: 'failed' } }),
      db.tenant.aggregate({ _sum: { credits: true } }),
      db.generation.aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: todayStart } },
      }),
    ]);

    // Queue health: all 7 queues
    const queueCounts = await Promise.all(
      Object.entries(ALL_QUEUES).map(async ([name, q]) => ({
        name,
        ...(await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')),
      }))
    );

    return reply.send({
      tenants:       { total: tenantTotal, active: tenantActive },
      users:         { total: userTotal },
      videos:        { total: videoTotal, completedToday: videoCompletedToday, failedToday: videoFailedToday },
      jobs:          { running: jobRunning, failedAll: jobFailed },
      credits:       { totalBalance: creditBalance._sum.credits ?? 0 },
      costUsdToday:  Number(costToday._sum.costUsd ?? 0),
      queues:        queueCounts,
    });
  });

  // ── QUEUE STATS ────────────────────────────────────────────────────────────

  // GET /api/v1/admin/queue-stats
  app.get('/queue-stats', async (_req, reply) => {
    const counts = await Promise.all(
      Object.entries(ALL_QUEUES).map(async ([name, q]) => ({
        name,
        ...(await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')),
      }))
    );
    return reply.send(counts);
  });

  // ── USERS ──────────────────────────────────────────────────────────────────

  // GET /api/v1/admin/users
  app.get('/users', async (req, reply) => {
    const q = UsersQuery.parse(req.query);

    const where = {
      ...(q.search   ? { OR: [
        { email:       { contains: q.search, mode: 'insensitive' as const } },
        { displayName: { contains: q.search, mode: 'insensitive' as const } },
      ]} : {}),
      ...(q.tenantId ? { tenantId: q.tenantId } : {}),
      ...(q.role     ? { role: q.role }         : {}),
      ...(q.active !== undefined ? { isActive: q.active } : {}),
    };

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (q.page - 1) * q.limit,
        take:    q.limit,
        select: {
          id: true, email: true, displayName: true, role: true,
          isActive: true, lastLoginAt: true, createdAt: true,
          tenant: { select: { id: true, name: true, slug: true, plan: true } },
          _count: { select: { sessions: true } },
        },
      }),
      db.user.count({ where }),
    ]);

    return reply.send({ data: users, pagination: { page: q.page, limit: q.limit, total } });
  });

  // GET /api/v1/admin/users/:id
  app.get('/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const user = await db.user.findUniqueOrThrow({
      where: { id },
      select: {
        id: true, email: true, displayName: true, avatarUrl: true,
        role: true, isActive: true, lastLoginAt: true, emailVerifiedAt: true,
        createdAt: true, updatedAt: true,
        tenant: {
          select: {
            id: true, name: true, slug: true, plan: true, credits: true,
            isActive: true, createdAt: true,
          },
        },
        sessions: {
          select: { id: true, createdAt: true, expiresAt: true, userAgent: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    // Recent jobs created by this user
    const recentJobs = await db.job.findMany({
      where: { createdBy: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, status: true, createdAt: true, creditsUsed: true,
                video: { select: { title: true } } },
    });

    const lifetimeCost = await db.generation.aggregate({
      where: { userId: id },
      _sum:  { costUsd: true },
    });

    return reply.send({ ...user, recentJobs, lifetimeCostUsd: Number(lifetimeCost._sum?.costUsd ?? 0) });
  });

  // PATCH /api/v1/admin/users/:id
  app.patch('/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      role:        z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
      isActive:    z.boolean().optional(),
      displayName: z.string().min(1).max(100).optional(),
    }).parse(req.body);

    const before = await db.user.findUniqueOrThrow({ where: { id },
      select: { role: true, isActive: true, displayName: true } });

    const user = await db.user.update({ where: { id }, data: body });

    await audit(req.user.userId, 'user.update', 'user', id, req.ip,
      { before, after: body });

    const action = body.isActive === false ? 'banned'
                 : body.isActive === true  ? 'unbanned'
                 : body.role               ? `role → ${body.role}` : 'updated';
    logger.info({ targetUserId: id, adminId: req.user.userId, action }, 'User updated by admin');

    return reply.send({ id: user.id, role: user.role, isActive: user.isActive });
  });

  // ── TENANTS ────────────────────────────────────────────────────────────────

  // GET /api/v1/admin/tenants
  app.get('/tenants', async (req, reply) => {
    const q = TenantsQuery.parse(req.query);

    const where = {
      ...(q.search ? { OR: [
        { name: { contains: q.search, mode: 'insensitive' as const } },
        { slug: { contains: q.search, mode: 'insensitive' as const } },
      ]} : {}),
      ...(q.plan   ? { plan: q.plan }         : {}),
      ...(q.active !== undefined ? { isActive: q.active } : {}),
    };

    const [tenants, total] = await Promise.all([
      db.tenant.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (q.page - 1) * q.limit,
        take:    q.limit,
        include: { _count: { select: { users: true, jobs: true, videos: true } } },
      }),
      db.tenant.count({ where }),
    ]);

    return reply.send({ data: tenants, pagination: { page: q.page, limit: q.limit, total } });
  });

  // GET /api/v1/admin/tenants/:id
  app.get('/tenants/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id },
      include: {
        users: {
          select: { id: true, email: true, role: true, isActive: true, lastLoginAt: true },
          orderBy: { createdAt: 'asc' },
        },
        billingPlans: {
          include: { plan: true },
          orderBy: { activatedAt: 'desc' },
          take: 1,
        },
        _count: { select: { users: true, jobs: true, videos: true, assets: true } },
      },
    });

    // Last 30 days usage
    const usageLast30 = await db.usageRecord.findMany({
      where: { tenantId: id, date: { gte: new Date(Date.now() - 30 * 86400_000) } },
      orderBy: { date: 'asc' },
    });

    // Credit transaction history (last 20)
    const creditHistory = await db.creditTransaction.findMany({
      where:   { tenantId: id },
      orderBy: { createdAt: 'desc' },
      take:    20,
      select:  { id: true, type: true, amount: true, balanceAfter: true,
                 description: true, createdAt: true },
    });

    // Cost breakdown from generations
    const costByProvider = await db.generation.groupBy({
      where: { tenantId: id },
      by:    ['provider'],
      _sum:  { costUsd: true, creditsCharged: true },
      _count: { id: true },
    });

    return reply.send({ ...tenant, usageLast30, creditHistory, costByProvider });
  });

  // PATCH /api/v1/admin/tenants/:id
  app.patch('/tenants/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name:     z.string().min(1).max(80).optional(),
      slug:     z.string().min(2).max(40).regex(/^[a-z0-9-]+$/).optional(),
      plan:     z.enum(['starter', 'pro', 'enterprise']).optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);

    const before = await db.tenant.findUniqueOrThrow({ where: { id },
      select: { name: true, slug: true, plan: true, isActive: true } });

    const tenant = await db.tenant.update({ where: { id }, data: body });

    await audit(req.user.userId, 'tenant.update', 'tenant', id, req.ip,
      { before, after: body });

    return reply.send({ id: tenant.id, name: tenant.name, plan: tenant.plan, isActive: tenant.isActive });
  });

  // PATCH /api/v1/admin/tenants/:id/suspend
  app.patch('/tenants/:id/suspend', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tenant = await db.tenant.update({ where: { id }, data: { isActive: false } });
    await audit(req.user.userId, 'tenant.suspend', 'tenant', id, req.ip, { after: { isActive: false } });
    logger.warn({ tenantId: id, adminId: req.user.userId }, 'Tenant suspended');
    return reply.send({ id: tenant.id, isActive: tenant.isActive });
  });

  // PATCH /api/v1/admin/tenants/:id/reinstate
  app.patch('/tenants/:id/reinstate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tenant = await db.tenant.update({ where: { id }, data: { isActive: true } });
    await audit(req.user.userId, 'tenant.reinstate', 'tenant', id, req.ip, { after: { isActive: true } });
    return reply.send({ id: tenant.id, isActive: tenant.isActive });
  });

  // PATCH /api/v1/admin/tenants/:id/credits
  app.patch('/tenants/:id/credits', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount, description } = z.object({
      amount:      z.number().int(),
      description: z.string().optional(),
    }).parse(req.body);

    const tenant = await db.$transaction(async (tx) => {
      const t = await tx.tenant.update({
        where: { id },
        data:  { credits: { increment: amount } },
      });
      await tx.creditTransaction.create({
        data: {
          tenantId:     id,
          type:         amount >= 0 ? 'admin_grant' as const : 'charge' as const,
          amount,
          balanceAfter: t.credits,
          description:  description ?? `Admin ${amount >= 0 ? 'grant' : 'deduction'} by ${req.user.email}`,
        },
      });
      return t;
    });

    await audit(req.user.userId, 'tenant.credits_grant', 'tenant', id, req.ip,
      { after: { credits: tenant.credits, delta: amount } });

    return reply.send({ id: tenant.id, credits: tenant.credits });
  });

  // ── VIDEOS ─────────────────────────────────────────────────────────────────

  // GET /api/v1/admin/videos
  app.get('/videos', async (req, reply) => {
    const q = VideoQuery.parse(req.query);

    const where = {
      ...(q.tenantId ? { tenantId: q.tenantId }  : {}),
      ...(q.status   ? { status: q.status as any } : {}),
      ...(q.from || q.to ? {
        createdAt: {
          ...(q.from ? { gte: q.from } : {}),
          ...(q.to   ? { lte: q.to   } : {}),
        },
      } : {}),
    };

    const [videos, total] = await Promise.all([
      db.video.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (q.page - 1) * q.limit,
        take:    q.limit,
        include: {
          tenant:  { select: { id: true, name: true, slug: true } },
          creator: { select: { id: true, email: true, displayName: true } },
          job:     { select: { id: true, status: true, creditsUsed: true } },
        },
      }),
      db.video.count({ where }),
    ]);

    return reply.send({ data: videos, pagination: { page: q.page, limit: q.limit, total } });
  });

  // DELETE /api/v1/admin/videos/:id
  app.delete('/videos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const video = await db.video.findUniqueOrThrow({ where: { id },
      select: { id: true, title: true, tenantId: true } });

    // Cascade: delete job → scenes → generations via Prisma relations (onDelete: Cascade)
    await db.video.delete({ where: { id } });

    await audit(req.user.userId, 'video.delete', 'video', id, req.ip,
      { before: { title: video.title, tenantId: video.tenantId } });

    logger.warn({ videoId: id, adminId: req.user.userId }, 'Video force-deleted by admin');
    return reply.code(204).send();
  });

  // ── JOBS ───────────────────────────────────────────────────────────────────

  // GET /api/v1/admin/jobs
  app.get('/jobs', async (req, reply) => {
    const q = JobsQuery.parse(req.query);

    const where = {
      ...(q.tenantId ? { tenantId: q.tenantId }     : {}),
      ...(q.status   ? { status: q.status as any }  : {}),
    };

    const [jobs, total] = await Promise.all([
      db.job.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (q.page - 1) * q.limit,
        take:    q.limit,
        include: {
          tenant:  { select: { id: true, name: true, slug: true } },
          creator: { select: { id: true, email: true } },
          video:   { select: { id: true, title: true } },
          _count:  { select: { scenes: true, events: true } },
        },
      }),
      db.job.count({ where }),
    ]);

    return reply.send({ data: jobs, pagination: { page: q.page, limit: q.limit, total } });
  });

  // GET /api/v1/admin/jobs/:id
  app.get('/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const job = await db.job.findUniqueOrThrow({
      where: { id },
      include: {
        tenant:  { select: { id: true, name: true } },
        creator: { select: { id: true, email: true } },
        video:   { select: { id: true, title: true, status: true, outputUrl: true } },
        scenes: {
          orderBy: { sceneIndex: 'asc' },
          include: {
            generations: {
              select: { id: true, provider: true, model: true, status: true,
                        costUsd: true, latencyMs: true, startedAt: true, completedAt: true },
            },
          },
        },
        events:  { orderBy: { createdAt: 'asc' } },
      },
    });

    return reply.send(job);
  });

  // POST /api/v1/admin/jobs/:id/retry  — smart resume from failure point
  // • No scenes yet (gpt-script failed)     → full restart via pipeline queue
  // • All scenes done, job failed           → compose stage failed → re-enqueue video-compose
  // • Some scenes failed                    → re-enqueue only those failed scene workers
  app.post('/jobs/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };

    const job = await db.job.findUniqueOrThrow({
      where: { id },
      select: { id: true, tenantId: true, status: true, videoId: true, payload: true },
    });

    if (job.status !== 'failed' && job.status !== 'cancelled') {
      return reply.code(409).send({ error: 'Conflict',
        message: `Cannot retry job with status "${job.status}"` });
    }

    const scenes = await db.scene.findMany({
      where: { jobId: id },
      select: { id: true, type: true, status: true, script: true, bRollPrompt: true,
                durationSec: true, sceneIndex: true },
      orderBy: { sceneIndex: 'asc' },
    });

    // ── Case 1: no scenes — gpt-script stage failed → full restart ─────────────
    if (scenes.length === 0) {
      await db.$transaction([
        db.job.update({ where: { id }, data: { status: 'pending', error: null } }),
        ...(job.videoId ? [db.video.update({ where: { id: job.videoId }, data: { status: 'pending' } })] : []),
      ]);
      await pipelineQueue.add(`pipeline:retry:${id}`, { jobId: id, tenantId: job.tenantId });
      await audit(req.user.userId, 'job.retry', 'job', id, req.ip);
      logger.info({ jobId: id, adminId: req.user.userId, mode: 'full-restart' }, 'Job retried (full restart) by admin');
      return reply.send({ jobId: id, status: 'pending', mode: 'full-restart' });
    }

    const failedScenes = scenes.filter(s => s.status === 'failed');

    // ── Case 2: all scenes completed but job still failed — compose failed ──────
    if (failedScenes.length === 0) {
      await db.$transaction([
        db.job.update({ where: { id }, data: { status: 'composing', error: null } }),
        ...(job.videoId ? [db.video.update({ where: { id: job.videoId }, data: { status: 'composing' } })] : []),
      ]);
      await videoComposeQueue.add(
        `compose:retry:${id}`,
        { jobId: id, tenantId: job.tenantId },
        QUEUE_DEFS.VIDEO_COMPOSE.defaultJobOptions,
      );
      await audit(req.user.userId, 'job.retry', 'job', id, req.ip);
      logger.info({ jobId: id, adminId: req.user.userId, mode: 'resume-compose' }, 'Job retried (resume compose) by admin');
      return reply.send({ jobId: id, status: 'composing', mode: 'resume-compose' });
    }

    // ── Case 3: scene-level failures — re-enqueue only failed scenes ────────────
    // Load product image keys for reference (MinIO storage keys, not presigned URLs)
    const productImageKeys: string[] = [];
    if (job.videoId) {
      const video = await db.video.findUnique({ where: { id: job.videoId }, select: { productId: true } });
      if (video?.productId) {
        const product = await db.product.findUnique({ where: { id: video.productId }, select: { images: true } });
        if (product?.images?.length) productImageKeys.push(...product.images);
      }
    }

    // Load avatar/voice settings from job payload
    const payload = (job.payload as Record<string, unknown>) ?? {};
    const settings = (payload['settings'] as Record<string, unknown>) ?? {};
    const avatarId = ((payload['avatar_id'] ?? settings['avatar_id']) as string | undefined) ?? 'default';
    const voiceId  = ((payload['voice_id']  ?? settings['voice_id'])  as string | undefined)
      ?? '70856236390f4d0392d00187143d3900';

    // Reset failed scenes + job status
    await db.$transaction([
      ...failedScenes.map(s => db.scene.update({ where: { id: s.id }, data: { status: 'pending', error: null } })),
      db.job.update({ where: { id }, data: { status: 'running', error: null } }),
      ...(job.videoId ? [db.video.update({ where: { id: job.videoId }, data: { status: 'processing' } })] : []),
    ]);

    // Re-enqueue per scene type — avatar in combined batch, clip/image individually
    const failedAvatarScenes = failedScenes.filter(s => s.type === 'avatar' && s.script);
    const failedClipScenes   = failedScenes.filter(s => s.type === 'clip'   && s.bRollPrompt);
    const failedImageScenes  = failedScenes.filter(s => s.type === 'image'  && s.bRollPrompt);

    if (failedAvatarScenes.length > 0) {
      // Re-run as combined — use ALL avatar scenes to produce one coherent HeyGen video
      const allAvatarScenes = scenes
        .filter(s => s.type === 'avatar' && s.script)
        .sort((a, b) => a.sceneIndex - b.sceneIndex);
      await heygenQueue.add(
        `heygen-resume:${id}`,
        {
          jobId: id,
          sceneId: allAvatarScenes[0].id,
          tenantId: job.tenantId,
          avatarId, voiceId,
          script: allAvatarScenes.map(s => s.script!).join(' '),
          isCombined: true,
          combinedSceneIds: allAvatarScenes.map(s => s.id),
        },
        QUEUE_DEFS.HEYGEN_RENDER.defaultJobOptions,
      );
    }

    for (const scene of failedClipScenes) {
      // Clip: image-gen (runway-frame) → chains to runway-clip automatically
      await imageGenQueue.add(
        `imggen-frame-resume:${scene.id}`,
        {
          jobId: id, sceneId: scene.id, tenantId: job.tenantId,
          prompt: scene.bRollPrompt!,
          referenceImageKeys: productImageKeys,
          purpose: 'runway-frame',
          clipDurationSec: Number(scene.durationSec ?? 5),
        },
        QUEUE_DEFS.IMAGE_GEN.defaultJobOptions,
      );
    }

    for (const scene of failedImageScenes) {
      await imageGenQueue.add(
        `imggen-resume:${scene.id}`,
        {
          jobId: id, sceneId: scene.id, tenantId: job.tenantId,
          prompt: scene.bRollPrompt!,
          referenceImageKeys: productImageKeys,
          purpose: 'scene-image',
        },
        QUEUE_DEFS.IMAGE_GEN.defaultJobOptions,
      );
    }

    await audit(req.user.userId, 'job.retry', 'job', id, req.ip);
    logger.info(
      { jobId: id, adminId: req.user.userId, mode: 'resume-scenes',
        failedAvatar: failedAvatarScenes.length, failedClip: failedClipScenes.length, failedImage: failedImageScenes.length },
      'Job retried (resume scenes) by admin',
    );
    return reply.send({
      jobId: id, status: 'running', mode: 'resume-scenes',
      resumed: { avatar: failedAvatarScenes.length, clip: failedClipScenes.length, image: failedImageScenes.length },
    });
  });

  // POST /api/v1/admin/jobs/:id/recompose
  // Re-runs video composition using already-generated scene assets (MinIO files).
  // Works regardless of current job status (failed, running, completed).
  // Useful when: compose failed, compose settings changed, or to produce a new variant.
  // Requires ALL non-failed scenes to have their asset URLs saved in the DB.
  app.post('/jobs/:id/recompose', async (req, reply) => {
    const { id } = req.params as { id: string };

    const job = await db.job.findUniqueOrThrow({
      where: { id },
      select: { id: true, tenantId: true, status: true, videoId: true },
    });

    // Verify all non-failed scenes have their assets saved
    const scenes = await db.scene.findMany({
      where: { jobId: id },
      select: { id: true, sceneIndex: true, type: true, status: true,
                avatarUrl: true, clipUrl: true, imageUrl: true,
                avatarDone: true, clipDone: true, imageDone: true },
      orderBy: { sceneIndex: 'asc' },
    });

    if (scenes.length === 0) {
      return reply.code(409).send({ error: 'Conflict',
        message: 'No scenes found — cannot recompose. Use retry to regenerate from scratch.' });
    }

    const missing = scenes.filter(s => {
      if (s.status === 'failed') return false; // failed scenes are skipped in compose
      if (s.type === 'avatar') return !s.avatarUrl;
      if (s.type === 'clip')   return !s.clipUrl;
      if (s.type === 'image')  return !s.imageUrl;
      return false;
    });

    if (missing.length > 0) {
      const detail = missing
        .map(s => `scene ${s.sceneIndex + 1} (${s.type})`)
        .join(', ');
      return reply.code(409).send({
        error: 'Assets not ready',
        message: `Cannot recompose — missing assets for: ${detail}. ` +
                 'Some scenes may still be generating. Wait for completion or use retry.',
        missingScenes: missing.map(s => ({ id: s.id, sceneIndex: s.sceneIndex, type: s.type })),
      });
    }

    // Reset compose-level status (keep scenes intact)
    await db.$transaction([
      db.job.update({ where: { id }, data: { status: 'composing', error: null } }),
      ...(job.videoId ? [
        db.video.update({ where: { id: job.videoId }, data: { status: 'composing', error: null } }),
      ] : []),
    ]);

    await db.jobEvent.create({
      data: {
        jobId: id, tenantId: job.tenantId,
        stage: 'admin', status: 'started',
        message: 'Manual recompose triggered by admin',
      },
    });

    await videoComposeQueue.add(
      `compose:recompose:${id}`,
      { jobId: id, tenantId: job.tenantId },
      QUEUE_DEFS.VIDEO_COMPOSE.defaultJobOptions,
    );

    await audit(req.user.userId, 'job.recompose', 'job', id, req.ip);
    logger.info({ jobId: id, adminId: req.user.userId }, 'Video recompose triggered by admin');
    return reply.send({ jobId: id, status: 'composing', mode: 'recompose' });
  });

  // POST /api/v1/admin/jobs/:id/cancel
  app.post('/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };

    const job = await db.job.findUniqueOrThrow({ where: { id },
      select: { videoId: true, status: true } });

    if (job.status === 'completed' || job.status === 'cancelled') {
      return reply.code(409).send({ error: 'Conflict',
        message: `Job is already "${job.status}"` });
    }

    await db.$transaction([
      db.job.update({ where: { id }, data: { status: 'cancelled' } }),
      ...(job.videoId ? [
        db.video.update({ where: { id: job.videoId }, data: { status: 'cancelled' } }),
      ] : []),
    ]);

    const bullJob = await pipelineQueue.getJob(id);
    if (bullJob) await bullJob.discard();

    await audit(req.user.userId, 'job.cancel', 'job', id, req.ip);
    return reply.send({ jobId: id, status: 'cancelled' });
  });

  // ── USAGE & COSTS ──────────────────────────────────────────────────────────

  // GET /api/v1/admin/usage
  app.get('/usage', async (req, reply) => {
    const q = UsageQuery.parse(req.query);

    const records = await db.usageRecord.findMany({
      where: {
        ...(q.tenantId ? { tenantId: q.tenantId } : {}),
        date: { gte: q.from, lte: q.to },
      },
      orderBy: { date: 'asc' },
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });

    // Aggregate totals (field names match Prisma model)
    const totals = records.reduce(
      (acc, r) => ({
        videosCreated:  acc.videosCreated  + r.videosCreated,
        creditsUsed:    acc.creditsUsed    + r.creditsUsed,
        costUsd:        acc.costUsd        + Number(r.totalCostUsd),
        apiCalls:       acc.apiCalls       + r.apiCallsCount,
      }),
      { videosCreated: 0, creditsUsed: 0, costUsd: 0, apiCalls: 0 }
    );

    return reply.send({ data: records, totals });
  });

  // GET /api/v1/admin/generations
  app.get('/generations', async (req, reply) => {
    const q = GenerationsQuery.parse(req.query);

    const where = {
      ...(q.tenantId ? { tenantId: q.tenantId }     : {}),
      ...(q.provider ? { provider: q.provider as any } : {}),
      ...(q.from || q.to ? {
        createdAt: {
          ...(q.from ? { gte: q.from } : {}),
          ...(q.to   ? { lte: q.to   } : {}),
        },
      } : {}),
    };

    const [generations, total, byProvider] = await Promise.all([
      db.generation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (q.page - 1) * q.limit,
        take:    q.limit,
        select: {
          id: true, tenantId: true, jobId: true, sceneId: true,
          provider: true, model: true, status: true,
          costUsd: true, creditsCharged: true, latencyMs: true,
          externalTaskId: true, startedAt: true, completedAt: true, createdAt: true,
          tenant: { select: { id: true, name: true } },
        },
      }),
      db.generation.count({ where }),
      db.generation.groupBy({
        where,
        by:     ['provider'],
        _sum:   { costUsd: true, creditsCharged: true },
        _count: { id: true },
        _avg:   { latencyMs: true },
      }),
    ]);

    return reply.send({
      data:       generations,
      byProvider: byProvider.map(r => ({
        provider:         r.provider,
        count:            r._count.id,
        totalCostUsd:     Number(r._sum.costUsd ?? 0),
        totalCredits:     r._sum.creditsCharged ?? 0,
        avgLatencyMs:     Math.round(r._avg.latencyMs ?? 0),
      })),
      pagination: { page: q.page, limit: q.limit, total },
    });
  });

  // ── SETTINGS ───────────────────────────────────────────────────────────────

  // GET /api/v1/admin/settings
  app.get('/settings', async (_req, reply) => {
    const settings = await db.adminSetting.findMany({ orderBy: { key: 'asc' } });
    return reply.send(settings);
  });

  // PUT /api/v1/admin/settings/:key
  app.put('/settings/:key', async (req, reply) => {
    const { key }   = req.params as { key: string };
    const { value, description } = z.object({
      value:       z.unknown(),
      description: z.string().optional(),
    }).parse(req.body);

    const setting = await db.adminSetting.upsert({
      where:  { key },
      create: { key, value: value as any, description, updatedBy: req.user.userId },
      update: { value: value as any, description, updatedBy: req.user.userId },
    });

    await audit(req.user.userId, 'settings.update', 'admin_setting', key, req.ip, { after: { value } });

    return reply.send(setting);
  });

  // DELETE /api/v1/admin/settings/:key
  app.delete('/settings/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    await db.adminSetting.delete({ where: { key } });
    await audit(req.user.userId, 'settings.delete', 'admin_setting', key, req.ip);
    return reply.code(204).send();
  });

  // ── AUDIT LOG ──────────────────────────────────────────────────────────────

  // GET /api/v1/admin/audit
  app.get('/audit', async (req, reply) => {
    const q = AuditQuery.parse(req.query);

    const where = {
      ...(q.adminId    ? { adminId: q.adminId }       : {}),
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.action     ? { action: { contains: q.action } } : {}),
    };

    const [entries, total] = await Promise.all([
      db.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (q.page - 1) * q.limit,
        take:    q.limit,
      }),
      db.adminAuditLog.count({ where }),
    ]);

    return reply.send({ data: entries, pagination: { page: q.page, limit: q.limit, total } });
  });

  // ── AI API HEALTH CHECKS ────────────────────────────────────────────────

  // GET /api/v1/admin/api-checks — проверка доступности внешних AI-сервисов
  app.get('/api-checks', async (_req, reply) => {
    type CheckResult = { name: string; status: 'ok' | 'error'; latencyMs: number; error?: string; info?: string };
    type DualCheck = { name: string; direct: CheckResult; proxy: CheckResult | null };

    const proxyUrl = await getProxyUrl();

    async function runCheck(
      name: string,
      url: string,
      init: RequestInit,
      parseOk: (data: any, latencyMs: number) => CheckResult,
      fetchFn: typeof globalThis.fetch,
    ): Promise<CheckResult> {
      const start = Date.now();
      try {
        const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = (body as any).message ?? (body as any).error?.message ?? (body as any).error ?? res.statusText;
          return { name, status: 'error', latencyMs, error: `HTTP ${res.status}: ${msg}` };
        }
        const data: any = await res.json().catch(() => null);
        return parseOk(data, latencyMs);
      } catch (e: any) {
        const cause = e?.cause;
        const detail = cause ? (cause.message ?? String(cause)) : e.message;
        return { name, status: 'error', latencyMs: Date.now() - start, error: detail !== e.message ? `${e.message}: ${detail}` : e.message };
      }
    }

    const services: {
      name: string;
      skip?: string;
      url: string;
      init: RequestInit;
      parseOk: (data: any, latencyMs: number) => CheckResult;
    }[] = [
      {
        name: 'heygen',
        skip: config.HEYGEN_API_KEY ? undefined : 'API ключ не задан',
        url: 'https://api.heygen.com/v2/user/remaining_quota',
        init: { headers: { 'X-Api-Key': config.HEYGEN_API_KEY ?? '' } },
        parseOk: (data, latencyMs) => {
          const credits = data?.data?.remaining_quota;
          return { name: 'heygen', status: 'ok', latencyMs, info: credits != null ? `Баланс: ${credits} кредитов` : 'API доступен' };
        },
      },
      {
        name: 'runway',
        skip: config.RUNWAY_API_KEY ? undefined : 'API ключ не задан',
        url: 'https://api.dev.runwayml.com/v1/organization',
        init: { headers: { 'Authorization': `Bearer ${config.RUNWAY_API_KEY ?? ''}`, 'X-Runway-Version': '2024-11-06' } },
        parseOk: (data, latencyMs) => ({ name: 'runway', status: 'ok', latencyMs, info: data?.name ? `Орг: ${data.name}` : 'API доступен' }),
      },
      {
        name: 'gptunnel',
        skip: config.GPTUNNEL_API_KEY ? undefined : 'API ключ не задан',
        url: `${config.GPTUNNEL_BASE_URL}/models`,
        init: { headers: { 'Authorization': `Bearer ${config.GPTUNNEL_API_KEY ?? ''}` } },
        parseOk: (_data, latencyMs) => ({ name: 'gptunnel', status: 'ok', latencyMs, info: 'Models API доступен' }),
      },
    ];

    const dualChecks: Promise<DualCheck>[] = services.map(async (svc) => {
      if (svc.skip) {
        const skipped: CheckResult = { name: svc.name, status: 'error', latencyMs: 0, error: svc.skip };
        return { name: svc.name, direct: skipped, proxy: proxyUrl ? skipped : null };
      }

      const directP = runCheck(svc.name, svc.url, svc.init, svc.parseOk, globalThis.fetch);
      const proxyP = proxyUrl
        ? runCheck(svc.name, svc.url, svc.init, svc.parseOk, (url, init) => proxyFetch(String(url), init, proxyUrl))
        : null;

      const [direct, proxy] = await Promise.all([directP, proxyP ?? Promise.resolve(null)]);
      return { name: svc.name, direct, proxy };
    });

    const results = await Promise.all(dualChecks);
    return reply.send({ checks: results, proxyUrl: proxyUrl || null });
  });

  // GET /api/v1/admin/proxy-check — проверка прокси-сервера
  app.get('/proxy-check', async (_req, reply) => {
    const TEST_URL = 'https://api64.ipify.org?format=json';
    const TIMEOUT = 10_000;

    const proxyUrl = await getProxyUrl();

    async function checkDirect() {
      const start = Date.now();
      try {
        const res = await globalThis.fetch(TEST_URL, { signal: AbortSignal.timeout(TIMEOUT) });
        const latencyMs = Date.now() - start;
        if (!res.ok) return { status: 'error' as const, latencyMs, error: `HTTP ${res.status}` };
        const data: any = await res.json();
        return { status: 'ok' as const, latencyMs, ip: data?.ip ?? null };
      } catch (e: any) {
        const cause = e?.cause;
        const detail = cause ? (cause.message ?? String(cause)) : e.message;
        return { status: 'error' as const, latencyMs: Date.now() - start, error: detail !== e.message ? `${e.message}: ${detail}` : e.message };
      }
    }

    async function checkProxy() {
      if (!proxyUrl) return null;
      const start = Date.now();
      try {
        const res = await proxyFetchStrict(TEST_URL, { signal: AbortSignal.timeout(TIMEOUT) }, proxyUrl);
        const latencyMs = Date.now() - start;
        if (!res.ok) return { status: 'error' as const, latencyMs, error: `HTTP ${res.status}` };
        const data: any = await res.json();
        return { status: 'ok' as const, latencyMs, ip: data?.ip ?? null };
      } catch (e: any) {
        const cause = e?.cause;
        const detail = cause ? (cause.message ?? String(cause)) : e.message;
        return { status: 'error' as const, latencyMs: Date.now() - start, error: detail !== e.message ? `${e.message}: ${detail}` : e.message };
      }
    }

    const [direct, proxy] = await Promise.all([checkDirect(), checkProxy()]);
    return reply.send({ configured: !!proxyUrl, proxyUrl: proxyUrl || null, direct, proxy });
  });

  // ── SERVICES: HEALTH & RESTART ─────────────────────────────────────────────

  const KNOWN_SERVICES = ['api', 'orchestrator', 'video-processor'] as const;
  type ServiceName = typeof KNOWN_SERVICES[number];
  const RESTART_CHANNEL = 'kmmzavod:service:restart';

  // GET /api/v1/admin/services/health
  app.get('/services/health', async (_req, reply) => {
    const redis = getRedis();
    const services = await Promise.all(
      KNOWN_SERVICES.map(async (name) => {
        const raw = await redis.get(`kmmzavod:heartbeat:${name}`);
        if (!raw) return { name, status: 'offline' as const, details: null };
        try {
          const details = JSON.parse(raw);
          return { name, status: 'online' as const, details };
        } catch {
          return { name, status: 'online' as const, details: null };
        }
      }),
    );
    return reply.send({ services });
  });

  // POST /api/v1/admin/services/:name/restart
  app.post<{ Params: { name: string } }>('/services/:name/restart', async (req, reply) => {
    const svc = req.params.name;
    const allowed = [...KNOWN_SERVICES, 'all'] as string[];
    if (!allowed.includes(svc)) {
      return reply.code(400).send({ error: 'BadRequest', message: `Неизвестный сервис: ${svc}. Доступные: ${allowed.join(', ')}` });
    }

    const redis = getRedis();
    try {
      await redis.publish(RESTART_CHANNEL, JSON.stringify({
        service: svc,
        admin: req.user.email,
        timestamp: new Date().toISOString(),
      }));
    } catch (pubErr: any) {
      logger.error({ service: svc, err: pubErr.message }, 'Redis publish failed for service restart');
      return reply.code(503).send({ error: 'ServiceUnavailable', message: 'Не удалось отправить команду перезапуска — Redis недоступен.' });
    }

    await audit(req.user.userId, 'restart', 'service', svc, req.ip, {
      note: `Перезапуск сервиса: ${svc}`,
    });

    logger.info({ service: svc, admin: req.user.email }, 'Команда перезапуска отправлена');

    return reply.send({ ok: true, service: svc, message: `Команда перезапуска отправлена для ${svc}` });
  });

  // ── PIPELINE TEST & TEST COMPOSE (extracted to admin/pipeline-test.routes.ts) ──
  app.register(pipelineTestRoutes);
}
