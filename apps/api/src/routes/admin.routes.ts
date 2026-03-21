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
import { pipelineQueue, videoComposeQueue, ALL_QUEUES } from '../lib/queues';
import { logger } from '../logger';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const Pagination = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const UsersQuery = Pagination.extend({
  search:   z.string().optional(),
  tenantId: z.string().uuid().optional(),
  role:     z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  active:   z.coerce.boolean().optional(),
});

const TenantsQuery = Pagination.extend({
  search: z.string().optional(),
  plan:   z.enum(['starter', 'pro', 'enterprise']).optional(),
  active: z.coerce.boolean().optional(),
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

// ── Helper: write audit entry ─────────────────────────────────────────────────
async function audit(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  ipAddress: string,
  opts: { before?: unknown; after?: unknown; note?: string } = {}
) {
  await db.adminAuditLog.create({
    data: {
      adminId,
      action,
      targetType,
      targetId,
      before: opts.before as any,
      after:  opts.after  as any,
      ipAddress,
    },
  });
}

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

  // POST /api/v1/admin/jobs/:id/retry
  app.post('/jobs/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };

    const job = await db.job.findUniqueOrThrow({ where: { id },
      select: { id: true, tenantId: true, status: true, videoId: true } });

    if (job.status !== 'failed' && job.status !== 'cancelled') {
      return reply.code(409).send({ error: 'Conflict',
        message: `Cannot retry job with status "${job.status}"` });
    }

    await db.$transaction([
      db.job.update({ where: { id }, data: { status: 'pending', error: null } }),
      ...(job.videoId ? [
        db.video.update({ where: { id: job.videoId }, data: { status: 'pending' } }),
      ] : []),
    ]);

    await pipelineQueue.add(`pipeline:retry:${id}`, { jobId: id, tenantId: job.tenantId });

    await audit(req.user.userId, 'job.retry', 'job', id, req.ip);
    logger.info({ jobId: id, adminId: req.user.userId }, 'Job retried by admin');

    return reply.send({ jobId: id, status: 'pending' });
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
}
