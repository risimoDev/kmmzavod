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
import { deflateSync } from 'node:zlib';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { pipelineQueue, videoComposeQueue, ALL_QUEUES } from '../lib/queues';
import { logger } from '../logger';
import { config } from '../config';

// ── Minimal PNG generator (no external deps) ─────────────────────────────────

function crc32png(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32png(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** Generate a solid-color PNG (RGB) of given dimensions. */
function solidPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(h * rowLen);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

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

  // ── AI API HEALTH CHECKS ────────────────────────────────────────────────

  // GET /api/v1/admin/api-checks — проверка доступности внешних AI-сервисов
  app.get('/api-checks', async (_req, reply) => {
    type CheckResult = { name: string; status: 'ok' | 'error'; latencyMs: number; error?: string; info?: string };

    const checks: Promise<CheckResult>[] = [];

    // HeyGen
    checks.push((async (): Promise<CheckResult> => {
      if (!config.HEYGEN_API_KEY) return { name: 'heygen', status: 'error', latencyMs: 0, error: 'API ключ не задан' };
      const start = Date.now();
      try {
        const res = await fetch('https://api.heygen.com/v2/user/remaining_quota', {
          headers: { 'X-Api-Key': config.HEYGEN_API_KEY },
          signal: AbortSignal.timeout(15_000),
        });
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { name: 'heygen', status: 'error', latencyMs, error: `HTTP ${res.status}: ${(body as any).message ?? res.statusText}` };
        }
        const data: any = await res.json();
        const credits = data?.data?.remaining_quota;
        return { name: 'heygen', status: 'ok', latencyMs, info: credits != null ? `Баланс: ${credits} кредитов` : 'API доступен' };
      } catch (e: any) {
        return { name: 'heygen', status: 'error', latencyMs: Date.now() - start, error: e.message };
      }
    })());

    // Runway
    checks.push((async (): Promise<CheckResult> => {
      if (!config.RUNWAY_API_KEY) return { name: 'runway', status: 'error', latencyMs: 0, error: 'API ключ не задан' };
      const start = Date.now();
      try {
        const res = await fetch('https://api.dev.runwayml.com/v1/organization', {
          headers: {
            'Authorization': `Bearer ${config.RUNWAY_API_KEY}`,
            'X-Runway-Version': '2024-11-06',
          },
          signal: AbortSignal.timeout(15_000),
        });
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { name: 'runway', status: 'error', latencyMs, error: `HTTP ${res.status}: ${(body as any).message ?? (body as any).error ?? res.statusText}` };
        }
        const data: any = await res.json();
        return { name: 'runway', status: 'ok', latencyMs, info: data.name ? `Орг: ${data.name}` : 'API доступен' };
      } catch (e: any) {
        return { name: 'runway', status: 'error', latencyMs: Date.now() - start, error: e.message };
      }
    })());

    // GPTunnel (OpenAI-compatible)
    checks.push((async (): Promise<CheckResult> => {
      if (!config.GPTUNNEL_API_KEY) return { name: 'gptunnel', status: 'error', latencyMs: 0, error: 'API ключ не задан' };
      const start = Date.now();
      try {
        const res = await fetch(`${config.GPTUNNEL_BASE_URL}/models`, {
          headers: { 'Authorization': `Bearer ${config.GPTUNNEL_API_KEY}` },
          signal: AbortSignal.timeout(15_000),
        });
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { name: 'gptunnel', status: 'error', latencyMs, error: `HTTP ${res.status}: ${(body as any).error?.message ?? res.statusText}` };
        }
        return { name: 'gptunnel', status: 'ok', latencyMs, info: 'Models API доступен' };
      } catch (e: any) {
        return { name: 'gptunnel', status: 'error', latencyMs: Date.now() - start, error: e.message };
      }
    })());

    const results = await Promise.all(checks);
    return reply.send({ checks: results });
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
    await redis.publish(RESTART_CHANNEL, JSON.stringify({
      service: svc,
      admin: req.user.email,
      timestamp: new Date().toISOString(),
    }));

    await audit(req.user.userId, 'restart', 'service', svc, req.ip, {
      note: `Перезапуск сервиса: ${svc}`,
    });

    logger.info({ service: svc, admin: req.user.email }, 'Команда перезапуска отправлена');

    return reply.send({ ok: true, service: svc, message: `Команда перезапуска отправлена для ${svc}` });
  });

  // ── PIPELINE TEST (step-by-step) ─────────────────────────────────────────

  const PipelineTestScriptBody = z.object({
    productName: z.string().min(1).max(200),
    productDescription: z.string().max(2000).optional(),
    features: z.array(z.string()).default([]),
    targetAudience: z.string().max(500).optional(),
    brandVoice: z.string().max(100).optional(),
    prompt: z.string().min(10).max(2000),
    language: z.string().default('ru'),
    imageKeys: z.array(z.string()).default([]),
  });

  // POST /api/v1/admin/pipeline-test/script  — Step 1: generate script via GPT
  app.post('/pipeline-test/script', async (req, reply) => {
    const body = PipelineTestScriptBody.parse(req.body);
    const storage = (app as any).storage;

    // Build product context with presigned image URLs
    const imageUrls: string[] = [];
    for (const key of body.imageKeys.slice(0, 3)) {
      try {
        const url = await storage.presignedUrl(key, 3600);
        imageUrls.push(url);
      } catch { /* skip broken keys */ }
    }

    const productContext = {
      name: body.productName,
      description: body.productDescription,
      features: body.features,
      targetAudience: body.targetAudience,
      brandVoice: body.brandVoice,
      imageUrls,
    };

    // Call GPTunnel directly (no queue, no credits)
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({
      baseURL: config.GPTUNNEL_BASE_URL,
      apiKey: config.GPTUNNEL_API_KEY ?? '',
    });

    // Build the same system prompt used in production
    const SYSTEM_PROMPT_SHORT = `You are a top-tier Russian-language copywriter and visual director for short-form viral video (TikTok/Reels/Shorts). Your scripts sound like a friend sharing a discovery, NOT like an advertisement.

━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — PRODUCT VISUAL ANALYSIS (if images attached)
━━━━━━━━━━━━━━━━━━━━━━━━━━
Analyze every product image. Extract PRODUCT_VISUAL_PROFILE:
  • Colors, shape, material, texture, packaging, distinctive features.

━━━━━━━━━━━━━━━━━━━━━━━━━━
SCENE STRUCTURE (STRICT ARC)
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. HOOK (scene 0, avatar/text, 3-5 sec) — the scroll-stopper.
   Pick ONE technique (vary across outputs):
   • Провокация: "Вам врали всё это время" / "Забудьте всё, что знали о..."
   • Шок-факт: "90% людей делают эту ошибку каждый день"
   • Личная история: "Три месяца назад я был в отчаянии..."
   • Запрет: "Никогда не покупайте [категория], пока не узнаете это"
   • Загадка: "Есть один приём, о котором молчат производители..."
   • Вызов: "Спорим, вы этого не знали?"
   • Боль: "Устали от [проблема]? Я тоже — пока не попробовал вот это"
   • Контринтуитив: "Чем дороже, тем хуже. Вот доказательство."
   Product MUST be mentioned in first 3 seconds.

2. PRODUCT REVEAL (scene 1, clip/image) — cinematic hero shot.
3. BENEFITS (scenes 2-3, avatar + clip) — цифры, сроки, сравнения. Не "эффективный", а "через 7 дней морщины на 40% меньше".
4. SOCIAL PROOF (avatar) — "50 000 клиентов", цитата, эксперт.
5. CTA (final, avatar) — "Ссылка в описании", "закажите — скидка до пятницы".

━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT SCHEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "title": "<цепляющий заголовок, до 80 символов>",
  "scenes": [
    {
      "scene_index": 0,
      "type": "avatar" | "clip" | "image" | "text",
      "script": "<текст речи — ТОЛЬКО для avatar/text>",
      "b_roll_prompt": "<промпт — ТОЛЬКО для clip/image>",
      "duration_sec": 5
    }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━
SCENE TYPE RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━
- "avatar" (40-60%): разговорная речь, 6-14 слов/предложение. Обращение "вы".
  Усилители: "реально", "честно", "послушайте", "смотрите".
  Связки: "А знаете, что самое крутое?", "Вот в чём фишка..."
- "clip" (20-30%): b_roll_prompt 50-80 слов. ВСЕ 7 элементов: кадр, камера, свет, продукт, фон, действие, качество 4K.
- "image" (10-20%): b_roll_prompt 30-50 слов. Продукт + стиль + палитра + настроение.
- "text" (<5%): max 6 слов.

ЗАПРЕЩЁННЫЕ СЛОВА:
  ✗ "уникальный", "инновационный", "революционный", "лучший на рынке"
  ✗ "не упустите шанс", "представляем вашему вниманию", "в современном мире"

ОБЯЗАТЕЛЬНЫЕ ПРИЁМЫ (2-3 на скрипт):
  ✓ Метафора/сравнение ✓ Мини-история ✓ Конкретный пример ✓ Числа

━━━━━━━━━━━━━━━━━━━━━━━━━━
HARD CONSTRAINTS
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Return VALID JSON ONLY — no markdown, no code fences
- avatar/text → "script"; clip/image → "b_roll_prompt"
- duration_sec: 4-8 avatar, 3-6 clip/image, 2-4 text
- EVERY b_roll_prompt: product name + 2 visual details from PRODUCT_VISUAL_PROFILE
- NEVER generic descriptions ("someone holds a product")
- Script sounds like SPOKEN Russian, not ad copy

━━━━━━━━━━━━━━━━━━━━━━━━━━
САМОПРОВЕРКА
━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Хук останавливает палец?
  ✓ Продукт в первые 3 сек?
  ✓ Выгоды = цифры, не прилагательные?
  ✓ Нет запрещённых слов?
  ✓ Звучит как живая речь?
  ✓ Каждый b_roll_prompt: имя + 2 детали?
  ✓ clip = 50-80 слов с 7 элементами?
Если нет — перепиши.`;

    const productSection = [
      '\n--- Product Information ---',
      `Product name: ${productContext.name}`,
      productContext.description ? `Description: ${productContext.description}` : '',
      productContext.features.length ? `Key features: ${productContext.features.join('; ')}` : '',
      productContext.targetAudience ? `Target audience: ${productContext.targetAudience}` : '',
      productContext.brandVoice ? `Brand voice: ${productContext.brandVoice}` : '',
      imageUrls.length ? 'Product images are attached.' : '',
      '--- End Product Information ---',
    ].filter(Boolean).join('\n');

    const systemContent = SYSTEM_PROMPT_SHORT + productSection + `\n\nLanguage: ${body.language}`;

    const hasImages = imageUrls.length > 0;
    const userMessage: any = hasImages
      ? {
          role: 'user',
          content: [
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
            { type: 'text', text: `Product: ${productContext.name}\n\n${body.prompt}` },
          ],
        }
      : { role: 'user', content: body.prompt };

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        userMessage,
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      return reply.code(500).send({ error: 'GPTError', message: 'OpenAI returned empty content' });
    }

    let output: { title: string; scenes: Array<{ scene_index: number; type: string; script?: string; b_roll_prompt?: string; duration_sec: number }> };
    try {
      output = JSON.parse(raw);
    } catch {
      return reply.code(500).send({ error: 'GPTError', message: 'Invalid JSON from GPT', raw: raw.slice(0, 500) });
    }

    const usage = response.usage;

    await audit(req.user.userId, 'pipeline-test.script', 'system', 'test', req.ip, {
      after: { sceneCount: output.scenes?.length, tokens: usage?.total_tokens },
    });

    return reply.send({
      title: output.title,
      scenes: output.scenes,
      usage: { prompt_tokens: usage?.prompt_tokens, completion_tokens: usage?.completion_tokens },
    });
  });

  // POST /api/v1/admin/pipeline-test/upload-scene — Upload video/image for a scene override
  app.post('/pipeline-test/upload-scene', async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Файл не передан' });
    }

    const ALLOWED_TYPES = [
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'video/webm', 'video/quicktime',
    ];
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Допустимые форматы: JPEG, PNG, WebP, MP4, WebM, MOV' });
    }

    const MAX_SIZE = 200 * 1024 * 1024; // 200MB
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      size += chunk.length;
      if (size > MAX_SIZE) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Максимальный размер файла — 200 МБ' });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const testId = crypto.randomUUID().slice(0, 8);
    const ext = file.filename.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) ?? 'mp4';
    const key = `test/pipeline/${testId}/scene_override.${ext}`;

    const storage = (app as any).storage;
    await storage.uploadBuffer(key, buffer, { contentType: file.mimetype });
    const url = await storage.presignedUrl(key, 86400);

    return reply.send({ key, url, size: buffer.length, mimetype: file.mimetype });
  });

  // ── Generate avatar video via HeyGen ──────────────────────────────────────
  const GenerateAvatarBody = z.object({
    script: z.string().min(1).max(5000),
    avatar_id: z.string().min(1),
    voice_id: z.string().min(1),
    bg_color: z.string().default('#000000'),
    target_duration: z.number().int().min(15).max(90).optional(),
  });

  app.post('/pipeline-test/generate-avatar', async (req, reply) => {
    const body = GenerateAvatarBody.parse(req.body);
    const apiKey = config.HEYGEN_API_KEY;
    if (!apiKey) {
      return reply.code(400).send({ error: 'NoApiKey', message: 'HEYGEN_API_KEY не настроен' });
    }

    const storage = (app as any).storage;
    const testId = crypto.randomUUID().slice(0, 8);

    try {
      // 1. Create video task on HeyGen
      const createRes = await fetch('https://api.heygen.com/v2/video/generate', {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_inputs: [{
            character: { type: 'avatar', avatar_id: body.avatar_id, avatar_style: 'normal' },
            voice: { type: 'text', input_text: body.script, voice_id: body.voice_id },
            background: { type: 'color', value: body.bg_color },
          }],
          dimension: { width: 1080, height: 1920 },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        return reply.code(502).send({ error: 'HeyGenCreateFailed', message: `HeyGen HTTP ${createRes.status}: ${errText}` });
      }

      const createData = (await createRes.json()) as any;
      if (createData.error) {
        const errMsg = typeof createData.error === 'string'
          ? createData.error
          : (createData.error?.message ?? JSON.stringify(createData.error));
        return reply.code(502).send({ error: 'HeyGenCreateFailed', message: errMsg });
      }

      const videoId = createData.data?.video_id;
      if (!videoId) {
        return reply.code(502).send({ error: 'HeyGenCreateFailed', message: 'No video_id returned' });
      }

      logger.info({ videoId, testId }, 'HeyGen avatar: задача создана, ожидаем рендер');

      // 2. Poll until ready (max ~20 minutes)
      let videoUrl: string | undefined;
      let duration = 0;
      for (let attempt = 1; attempt <= 80; attempt++) {
        await new Promise((r) => setTimeout(r, attempt <= 4 ? 10_000 : 15_000));

        const statusRes = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
          headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!statusRes.ok) continue;
        const statusData = (await statusRes.json()) as any;
        const status = statusData.data?.status;

        if (status === 'completed' && statusData.data?.video_url) {
          videoUrl = statusData.data.video_url;
          duration = statusData.data.duration ?? 0;
          break;
        }
        if (status === 'failed') {
          return reply.code(502).send({ error: 'HeyGenFailed', message: statusData.data?.error ?? 'Avatar rendering failed' });
        }
        logger.debug({ videoId, status, attempt }, 'HeyGen: ожидаем видео');
      }

      if (!videoUrl) {
        return reply.code(504).send({ error: 'HeyGenTimeout', message: 'Видео не готово после 20 минут ожидания' });
      }

      // 3. Download video and upload to MinIO
      const dlRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
      if (!dlRes.ok) {
        return reply.code(502).send({ error: 'DownloadFailed', message: `Не удалось скачать видео: HTTP ${dlRes.status}` });
      }
      const videoBuffer = Buffer.from(await dlRes.arrayBuffer());
      const key = `test/pipeline/${testId}/avatar_heygen.mp4`;
      await storage.uploadBuffer(key, videoBuffer, { contentType: 'video/mp4' });
      const url = await storage.presignedUrl(key, 86400);

      logger.info({ videoId, key, duration }, 'HeyGen avatar: видео загружено в MinIO');

      await audit(req.user.userId, 'pipeline-test.generate-avatar', 'system', testId, req.ip, {
        after: { videoId, avatarId: body.avatar_id, voiceId: body.voice_id, duration },
      });

      return reply.send({ key, url, duration_sec: duration, heygen_video_id: videoId });
    } catch (e: any) {
      logger.error({ err: e.message }, 'HeyGen avatar generation failed');
      return reply.code(500).send({ error: 'HeyGenError', message: e.message });
    }
  });

  const PipelineTestComposeBody = z.object({
    scenes: z.array(z.object({
      type: z.enum(['avatar', 'clip', 'image', 'text']),
      storage_key: z.string(),
      duration_sec: z.number().min(1).max(60),
      script: z.string().optional(),
    })).min(1).max(20),
    preset: z.enum(['dynamic', 'smooth', 'minimal']).default('dynamic'),
    with_subtitles: z.boolean().default(true),
    subtitle_style: z.enum(['tiktok', 'cinematic', 'minimal', 'default']).default('tiktok'),
  });

  // POST /api/v1/admin/pipeline-test/compose — Step 3: compose the final video
  app.post('/pipeline-test/compose', async (req, reply) => {
    let body;
    try {
      body = PipelineTestComposeBody.parse(req.body);
    } catch (e: any) {
      const issues = e.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? e.message;
      return reply.code(400).send({ error: 'ValidationError', message: `Ошибка валидации данных: ${issues}` });
    }
    const testId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();
    const storage = (app as any).storage;

    const vpUrl = config.VIDEO_PROCESSOR_URL;

    // Health check
    try {
      const hc = await fetch(`${vpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!hc.ok) {
        return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: `video-processor вернул HTTP ${hc.status}` });
      }
    } catch (e: any) {
      return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: `Не удалось подключиться к video-processor: ${e.message}` });
    }

    const PRESET_MAP: Record<string, { transition: string; transition_duration: number }> = {
      dynamic: { transition: 'fade', transition_duration: 0.3 },
      smooth:  { transition: 'smoothleft', transition_duration: 0.5 },
      minimal: { transition: 'cut', transition_duration: 0 },
    };
    const presetCfg = PRESET_MAP[body.preset];

    // Auto-generate placeholder images for text scenes without files
    for (const s of body.scenes) {
      if (!s.storage_key && s.type === 'text') {
        const png = solidPng(1080, 1920, 18, 18, 24); // dark background
        const placeholderKey = `test/pipeline/${testId}/text_placeholder_${crypto.randomUUID().slice(0, 6)}.png`;
        await storage.uploadBuffer(placeholderKey, png, { contentType: 'image/png' });
        s.storage_key = placeholderKey;
        (s as any)._auto_generated = true;
      }
    }

    // Validate all scenes have storage_key
    const missingSk = body.scenes.filter((s) => !s.storage_key);
    if (missingSk.length > 0) {
      return reply.code(400).send({
        error: 'ValidationError',
        message: `Для ${missingSk.length} сцен не загружены файлы. Загрузите видео/изображения для всех сцен типа avatar, clip, image.`,
      });
    }

    const scenes = body.scenes.map((s, i) => ({
      scene_id: `ptest_${testId}_${i}`,
      type: (s as any)._auto_generated ? 'image' : s.type,
      storage_key: s.storage_key,
      duration_sec: s.duration_sec,
      transition: presetCfg.transition,
      transition_duration: presetCfg.transition_duration,
      ken_burns: (s.type === 'image' || (s as any)._auto_generated) ? 'auto' : undefined,
    }));

    // Build subtitles from avatar scripts
    const subtitles: Array<{ start_sec: number; end_sec: number; text: string }> = [];
    if (body.with_subtitles) {
      let cursor = 0;
      for (const s of body.scenes) {
        if (s.script) {
          subtitles.push({ start_sec: cursor, end_sec: cursor + s.duration_sec, text: s.script });
        }
        cursor += s.duration_sec;
        // Subtract transition overlap for non-last scenes
      }
    }

    const outputKey = `test/pipeline/${testId}/final_${body.preset}.mp4`;

    try {
      const composeRes = await fetch(`${vpUrl}/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: `ptest_${testId}`,
          tenant_id: 'system',
          output_key: outputKey,
          scenes,
          subtitles,
          settings: { subtitle_style: body.subtitle_style },
        }),
        signal: AbortSignal.timeout(600_000),
      });

      if (!composeRes.ok) {
        const errBody = await composeRes.text();
        return reply.code(composeRes.status).send({ error: 'ComposeFailed', message: `video-processor HTTP ${composeRes.status}`, detail: errBody });
      }

      const result = await composeRes.json();
      const outputUrl = await storage.presignedUrl(outputKey, 86400);
      const elapsed = Date.now() - startTime;

      await audit(req.user.userId, 'pipeline-test.compose', 'system', testId, req.ip, {
        after: { preset: body.preset, scenes: scenes.length, elapsed },
      });

      return reply.send({
        test_id: testId,
        preset: body.preset,
        compose_result: result,
        output_url: outputUrl,
        elapsed_ms: elapsed,
      });
    } catch (e: any) {
      return reply.code(500).send({ error: 'ComposeError', message: e.message });
    }
  });

  // ── Layout templates ──────────────────────────────────────────────────────
  const LAYOUT_TEMPLATES: Record<string, {
    name: string;
    description: string;
    segments: Array<{ layout: string; weight: number; bg_type: 'image' | 'video' }>;
  }> = {
    presenter: {
      name: 'Презентер',
      description: 'Чередование полноэкранного аватара и PIP в углу',
      segments: [
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'pip_bl',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'pip_bl',     weight: 0.25, bg_type: 'video' },
      ],
    },
    narrator: {
      name: 'Нарратор',
      description: 'Фокус на продукте — аватар сопровождает в PIP',
      segments: [
        { layout: 'pip_bl',     weight: 0.30, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.30, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
      ],
    },
    dynamic: {
      name: 'Динамичный',
      description: 'PIP перемещается по углам — энергичный монтаж',
      segments: [
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.20, bg_type: 'video' },
        { layout: 'pip_bl',     weight: 0.20, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_tr',     weight: 0.20, bg_type: 'video' },
      ],
    },
    focus: {
      name: 'Фокус',
      description: 'Аватар чередуется с озвучкой поверх продукта',
      segments: [
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'voiceover',  weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'voiceover',  weight: 0.25, bg_type: 'video' },
      ],
    },
    blogger: {
      name: 'Блогер',
      description: 'Стиль обзора — аватар комментирует продукт',
      segments: [
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
        { layout: 'pip_tr',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.15, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.20, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.20, bg_type: 'image' },
      ],
    },
    expert: {
      name: 'Экспертный',
      description: 'Начинается с продукта, аватар меняет позицию',
      segments: [
        { layout: 'pip_bl',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
        { layout: 'pip_br',     weight: 0.25, bg_type: 'video' },
        { layout: 'fullscreen', weight: 0.25, bg_type: 'image' },
      ],
    },
  };

  app.get('/pipeline-test/layout-templates', async (_req, reply) => {
    return reply.send(LAYOUT_TEMPLATES);
  });

  // ── Generate continuous script (layout mode) ──────────────────────────────
  const LayoutScriptBody = z.object({
    productName: z.string().min(1),
    productDescription: z.string().optional(),
    features: z.array(z.string()).default([]),
    targetAudience: z.string().optional(),
    brandVoice: z.string().default('professional'),
    prompt: z.string().min(10).max(2000),
    language: z.string().default('ru'),
    imageKeys: z.array(z.string()).default([]),
    targetDuration: z.number().int().min(15).max(90).default(30),
    gender: z.enum(['male', 'female']).default('female'),
  });

  app.post('/pipeline-test/generate-script-layout', async (req, reply) => {
    const body = LayoutScriptBody.parse(req.body);
    const storage = (app as any).storage;

    const imageUrls: string[] = [];
    for (const key of body.imageKeys.slice(0, 3)) {
      try { imageUrls.push(await storage.presignedUrl(key, 3600)); } catch {}
    }

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({
      baseURL: config.GPTUNNEL_BASE_URL,
      apiKey: config.GPTUNNEL_API_KEY ?? '',
    });

    const LAYOUT_SYSTEM_PROMPT = `You are a top-tier Russian-language copywriter who writes scripts that sound like a friend talking, NOT like an ad. Your scripts must feel spontaneous, real, and impossible to skip.

━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — PRODUCT VISUAL ANALYSIS (if images attached)
━━━━━━━━━━━━━━━━━━━━━━━━━━
Analyze every attached product image. Extract and store as PRODUCT_VISUAL_PROFILE:
  • Dominant colors & palette, shape/form factor, material/texture
  • Packaging, logo, distinctive markings
Reference it in every b_roll_prompt.

━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR TASK
━━━━━━━━━━━━━━━━━━━━━━━━━━
Write ONE continuous, natural SPOKEN script for a talking-head avatar. Target duration: {{TARGET_DURATION}} seconds ({{WORD_MIN}}–{{WORD_MAX}} words). NEVER exceed {{TARGET_DURATION}} seconds.
The script must sound like a real person speaking on camera — NOT like a ChatGPT-generated ad.

━━━━━━━━━━━━━━━━━━━━━━━━━━
SCRIPT STRUCTURE (STRICT ARC)
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. HOOK (first 3 sec) — the most critical line. Pattern interrupt that stops thumbs.
   Pick ONE technique PER VIDEO (vary across outputs):
   • Провокация: "Вам врали всё это время" / "Забудьте всё, что знали о..."
   • Шок-факт: "90% людей делают эту ошибку каждый день"
   • Личная история: "Три месяца назад я был в отчаянии..." / "Я потратил 200 тысяч, прежде чем нашёл это"
   • Запрет: "Никогда не покупайте [категория], пока не узнаете это"
   • Загадка: "Есть один приём, о котором молчат производители..."
   • Вызов: "Спорим, вы этого не знали?" / "Держу пари, вы делаете это неправильно"
   • Боль: "Устали от [конкретная проблема]? Я тоже — пока не попробовал вот это"
   • Контринтуитив: "Чем дороже крем, тем хуже он работает. Вот доказательство."
   The hook MUST mention or reference the product.

2. ПРОБЛЕМА (1-2 предложения) — усиливаем боль.
   Конкретика: не "многие сталкиваются с проблемой", а "вы просыпаетесь утром, кожа тусклая, макияж ложится пятнами".
   Задайте вопрос: "Знакомо?"

3. РЕШЕНИЕ (1-2 предложения) — назовите продукт. Суть в одном предложении. Без воды.

4. ДОКАЗАТЕЛЬСТВА (2-3 предложения) — конкретные выгоды.
   Цифры, сроки, сравнения: "через 7 дней морщины на 40% меньше", "в 3 раза экономичнее аналогов".
   Сенсорные детали: как пахнет, какая текстура, как ощущается.

5. СОЦИАЛЬНОЕ ДОКАЗАТЕЛЬСТВО (1 предложение) — "50 000 клиентов", цитата, эксперт.

6. CTA (последнее предложение) — "Ссылка в описании", "закажите — скидка до пятницы".

━━━━━━━━━━━━━━━━━━━━━━━━━━
СТИЛЬ РЕЧИ
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Пиши КАК ГОВОРИШЬ, не как пишешь. Разговорная интонация.
- Короткие рубленые фразы (6-14 слов). Чередуй короткие с длиннее.
- Обращение "вы". Паузы: "..." для эмфазы.
- Риторические вопросы: "А знаете, что самое крутое?", "Понимаете, к чему я?"
- Связки: "Смотрите...", "Вот в чём фишка...", "И тут начинается самое интересное..."
- Усилители: "реально", "честно", "послушайте", "обратите внимание".
- NO stage directions, emoji, markdown — pure speech text.

ГЕНДЕР СПИКЕРА: {{SPEAKER_GENDER}}
- Если женщина: используй женские формы глаголов ("я попробовала", "я нашла", "я была в шоке", "моя подруга рассказала").
- Если мужчина: используй мужские формы ("я попробовал", "я нашёл", "я был в шоке", "мой друг рассказал").
- Все личные примеры, истории, обращения должны соответствовать полу спикера.

ПРОИЗНОШЕНИЕ И УДАРЕНИЯ (КРИТИЧЕСКИ ВАЖНО):
- Пиши слова так, как они ПРОИЗНОСЯТСЯ в разговорной русской речи.
- НЕ ставь знаки ударения (◌́). ТТС движок сам расставит ударения.
- Избегай слов, которые могут быть прочитаны неправильно TTS: "замок" (за́мок/замо́к), "мука" (му́ка/мука́) — используй контекст или альтернативные формулировки.
- Числа пиши СЛОВАМИ: "сто пятьдесят" вместо "150", "сорок процентов" вместо "40%".
- Аббревиатуры раскрывай: "эс пэ эф" вместо "SPF".

ЗАПРЕЩЁННЫЕ СЛОВА (НИКОГДА):
  ✗ "уникальный", "инновационный", "революционный", "лучший на рынке"
  ✗ "не упустите шанс", "спешите", "торопитесь"
  ✗ "данный продукт", "представляем вашему вниманию"
  ✗ "в современном мире", "в наше время", "каждый знает", "не секрет что"

ОБЯЗАТЕЛЬНЫЕ ПРИЁМЫ (2-3 в каждом скрипте):
  ✓ Метафора: "кожа как у младенца", "работает как швейцарские часы"
  ✓ Мини-история: "моя подруга попробовала и..."
  ✓ Конкретный пример: "утром нанесли — до вечера держится"
  ✓ Неожиданный поворот: "но подождите — это ещё не всё"
  ✓ Числа: "7 дней", "40%", "3 раза"

━━━━━━━━━━━━━━━━━━━━━━━━━━
b_roll_prompts — ФОНОВЫЕ ВИЗУАЛЫ
━━━━━━━━━━━━━━━━━━━━━━━━━━
2-3 промпта. "image" (30-50 слов): продукт + детали, композиция, палитра, настроение.
"video" (50-80 слов): тип кадра, камера, свет, размещение, фон, действие, качество 4K.
Каждый промпт: имя продукта + 2+ визуальных детали из PRODUCT_VISUAL_PROFILE.

━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT (VALID JSON ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "title": "<цепляющий заголовок, до 80 символов, эмодзи ОК>",
  "full_script": "<полный текст речи, 150-400 слов, без ремарок>",
  "b_roll_prompts": [
    { "type": "image"|"video", "prompt": "<промпт>" }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━
САМОПРОВЕРКА
━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Хук останавливает палец? Вызывает эмоцию?
  ✓ Продукт назван в первые 3 секунды?
  ✓ Выгоды конкретные (цифры/сроки)?
  ✓ Нет запрещённых слов?
  ✓ Текст звучит как живая речь, а не рекламный буклет?
  ✓ Есть минимум 2 приёма из ОБЯЗАТЕЛЬНЫХ?
  ✓ CTA чёткий? Каждый b_roll_prompt: имя + 2 визуальных детали?
Если нет — перепиши.`;

    const productSection = [
      '\n--- Product ---',
      `Name: ${body.productName}`,
      body.productDescription ? `Desc: ${body.productDescription}` : '',
      body.features.length ? `Features: ${body.features.join('; ')}` : '',
      body.targetAudience ? `Audience: ${body.targetAudience}` : '',
      body.brandVoice ? `Tone: ${body.brandVoice}` : '',
    ].filter(Boolean).join('\n');

    const systemContent = LAYOUT_SYSTEM_PROMPT
      .replace(/\{\{TARGET_DURATION\}\}/g, String(body.targetDuration))
      .replace('{{WORD_MIN}}', String(Math.round(body.targetDuration * 2.5)))
      .replace('{{WORD_MAX}}', String(Math.round(body.targetDuration * 4)))
      .replace('{{SPEAKER_GENDER}}', body.gender === 'female' ? 'Женщина' : 'Мужчина')
      + productSection + `\n\nLanguage: ${body.language}\nTarget video duration: ${body.targetDuration} seconds. Do NOT exceed this.`;

    const userMessage: any = imageUrls.length > 0
      ? {
          role: 'user',
          content: [
            ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
            { type: 'text', text: `Product: ${body.productName}\n\n${body.prompt}` },
          ],
        }
      : { role: 'user', content: body.prompt };

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        userMessage,
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return reply.code(502).send({ error: 'EmptyResponse', message: 'GPT вернул пустой ответ' });

    let output: { title: string; full_script: string; b_roll_prompts: Array<{ type: string; prompt: string }> };
    try { output = JSON.parse(raw); } catch {
      return reply.code(502).send({ error: 'InvalidJSON', message: 'GPT вернул невалидный JSON' });
    }

    if (!output.full_script) {
      return reply.code(502).send({ error: 'NoScript', message: 'GPT не сгенерировал скрипт' });
    }

    await audit(req.user.userId, 'pipeline-test.generate-script-layout', 'system', '', req.ip, {
      after: { title: output.title, scriptLength: output.full_script.length, bRollCount: output.b_roll_prompts?.length },
    });

    return reply.send(output);
  });

  // ── Fallback subtitle timing from word count ────────────────────────────
  function _estimateSubtitleTiming(script: string): Array<{ start_sec: number; end_sec: number; text: string }> {
    const words = script.split(/\s+/).filter(Boolean);
    const chunkSize = 12;
    const totalChunks = Math.ceil(words.length / chunkSize);
    const estimatedDuration = words.length / 2.5;
    const perChunk = estimatedDuration / Math.max(totalChunks, 1);
    const subs: Array<{ start_sec: number; end_sec: number; text: string }> = [];
    for (let c = 0; c < totalChunks; c++) {
      subs.push({
        start_sec: +(c * perChunk).toFixed(2),
        end_sec: +((c + 1) * perChunk).toFixed(2),
        text: words.slice(c * chunkSize, (c + 1) * chunkSize).join(' '),
      });
    }
    return subs;
  }

  // ── Compose layout video ──────────────────────────────────────────────────
  const LayoutComposeBody = z.object({
    avatar_storage_key: z.string().min(1),
    backgrounds: z.array(z.object({
      storage_key: z.string().min(1),
      type: z.enum(['image', 'video']),
    })).min(1),
    layout_template: z.string().min(1),
    with_subtitles: z.boolean().default(true),
    subtitle_style: z.enum(['tiktok', 'cinematic', 'minimal', 'default']).default('tiktok'),
    full_script: z.string().optional(),
    audio_track: z.object({
      storage_key: z.string().min(1),
      volume: z.number().min(0).max(1).default(0.12),
    }).optional(),
  });

  app.post('/pipeline-test/compose-layout', async (req, reply) => {
    let body;
    try {
      body = LayoutComposeBody.parse(req.body);
    } catch (e: any) {
      const issues = e.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') ?? e.message;
      return reply.code(400).send({ error: 'ValidationError', message: `Ошибка валидации: ${issues}` });
    }

    const template = LAYOUT_TEMPLATES[body.layout_template];
    if (!template) {
      return reply.code(400).send({ error: 'BadTemplate', message: `Шаблон "${body.layout_template}" не найден` });
    }

    const testId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();
    const storage = (app as any).storage;
    const vpUrl = config.VIDEO_PROCESSOR_URL;

    // Health check
    try {
      const hc = await fetch(`${vpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!hc.ok) return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: `HTTP ${hc.status}` });
    } catch (e: any) {
      return reply.code(502).send({ error: 'VideoProcessorUnavailable', message: e.message });
    }

    // Map template segments to compose-layout segments.
    // Assign backgrounds round-robin: images for "image" slots, videos for "video" slots.
    const imgBgs = body.backgrounds.filter((b) => b.type === 'image');
    const vidBgs = body.backgrounds.filter((b) => b.type === 'video');

    // Build backgrounds array with dedup
    const allBgs = [...body.backgrounds];
    const segments = template.segments.map((seg, i) => {
      let bgIdx: number;
      if (seg.bg_type === 'image' && imgBgs.length > 0) {
        const bg = imgBgs[i % imgBgs.length];
        bgIdx = allBgs.findIndex((b) => b.storage_key === bg.storage_key);
      } else if (seg.bg_type === 'video' && vidBgs.length > 0) {
        const bg = vidBgs[i % vidBgs.length];
        bgIdx = allBgs.findIndex((b) => b.storage_key === bg.storage_key);
      } else {
        bgIdx = i % allBgs.length;
      }
      return { layout: seg.layout, bg_index: Math.max(0, bgIdx), weight: seg.weight };
    });

    // Build subtitles — use Whisper transcription for accurate timing
    let subtitles: Array<{ start_sec: number; end_sec: number; text: string }> = [];
    if (body.with_subtitles) {
      try {
        const transcribeRes = await fetch(`${vpUrl}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storage_key: body.avatar_storage_key,
            language: 'ru',
            max_words_per_chunk: 12,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (transcribeRes.ok) {
          const transcription = await transcribeRes.json() as {
            subtitles: Array<{ start_sec: number; end_sec: number; text: string }>;
            word_count: number;
            duration_sec: number;
          };
          subtitles = transcription.subtitles;
          req.log.info({ subtitles: subtitles.length, wordCount: transcription.word_count }, 'Whisper transcription OK');
        } else {
          req.log.warn({ status: transcribeRes.status }, 'Whisper transcription failed, falling back to estimate');
          // Fallback to word-count estimation
          if (body.full_script) {
            subtitles = _estimateSubtitleTiming(body.full_script);
          }
        }
      } catch (transcribeErr: any) {
        req.log.warn({ err: transcribeErr.message }, 'Whisper transcription error, falling back to estimate');
        if (body.full_script) {
          subtitles = _estimateSubtitleTiming(body.full_script);
        }
      }
    }

    const outputKey = `test/pipeline/${testId}/layout_${body.layout_template}.mp4`;

    try {
      const composeRes = await fetch(`${vpUrl}/compose-layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: `layout_${testId}`,
          tenant_id: 'system',
          output_key: outputKey,
          avatar_storage_key: body.avatar_storage_key,
          backgrounds: allBgs,
          segments,
          subtitles,
          audio_track: body.audio_track ? {
            storage_key: body.audio_track.storage_key,
            volume: body.audio_track.volume,
            fade_in_sec: 1.5,
            fade_out_sec: 2.0,
          } : undefined,
          settings: { subtitle_style: body.subtitle_style },
          chroma_color: '#000000',
          pip_scale: 0.30,
          pip_margin: 30,
          transition: 'fade',
          transition_duration: 0.3,
        }),
        signal: AbortSignal.timeout(600_000),
      });

      if (!composeRes.ok) {
        const errBody = await composeRes.text();
        return reply.code(composeRes.status).send({ error: 'LayoutComposeFailed', message: `video-processor HTTP ${composeRes.status}`, detail: errBody });
      }

      const result = await composeRes.json();
      const outputUrl = await storage.presignedUrl(outputKey, 86400);
      const elapsed = Date.now() - startTime;

      await audit(req.user.userId, 'pipeline-test.compose-layout', 'system', testId, req.ip, {
        after: { template: body.layout_template, segments: segments.length, elapsed },
      });

      return reply.send({
        test_id: testId,
        layout_template: body.layout_template,
        compose_result: result,
        output_url: outputUrl,
        elapsed_ms: elapsed,
      });
    } catch (e: any) {
      return reply.code(500).send({ error: 'LayoutComposeError', message: e.message });
    }
  });

  // ── TEST COMPOSE ───────────────────────────────────────────────────────────

  const TestComposeBody = z.object({
    preset: z.enum(['dynamic', 'smooth', 'minimal']).default('dynamic'),
    scene_count: z.number().int().min(1).max(6).default(3),
    scene_duration: z.number().min(2).max(15).default(4),
    with_subtitles: z.boolean().default(true),
    scene_keys: z.array(z.string()).optional(),
  });

  // POST /api/v1/admin/test-compose
  app.post('/test-compose', async (req, reply) => {
    const body = TestComposeBody.parse(req.body ?? {});
    const testId = crypto.randomUUID().slice(0, 8);
    const startTime = Date.now();
    const storage = (app as any).storage;

    // 1. Health check video-processor
    const vpUrl = config.VIDEO_PROCESSOR_URL;
    try {
      const hc = await fetch(`${vpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!hc.ok) {
        return reply.code(502).send({
          error: 'VideoProcessorUnavailable',
          message: `video-processor вернул HTTP ${hc.status}`,
        });
      }
    } catch (e: any) {
      return reply.code(502).send({
        error: 'VideoProcessorUnavailable',
        message: `Не удалось подключиться к video-processor (${vpUrl}): ${e.message}`,
      });
    }

    // 2. Prepare scene assets
    const TEST_COLORS = [
      { r: 220, g:  50, b:  50, label: 'red'    },
      { r:  50, g: 180, b:  80, label: 'green'  },
      { r:  50, g:  80, b: 220, label: 'blue'   },
      { r: 230, g: 180, b:  40, label: 'yellow' },
      { r: 180, g:  50, b: 200, label: 'purple' },
      { r:  40, g: 200, b: 200, label: 'cyan'   },
    ];

    let sceneKeys: string[];

    if (body.scene_keys?.length) {
      sceneKeys = body.scene_keys;
    } else {
      // Generate solid-color PNGs and upload
      sceneKeys = [];
      for (let i = 0; i < body.scene_count; i++) {
        const color = TEST_COLORS[i % TEST_COLORS.length];
        const png = solidPng(540, 960, color.r, color.g, color.b);
        const key = `test/compose/${testId}/scene_${i}_${color.label}.png`;
        await storage.uploadBuffer(key, png, { contentType: 'image/png' });
        sceneKeys.push(key);
      }
      logger.info({ testId, count: sceneKeys.length }, 'Uploaded test images to MinIO');
    }

    // 3. Build compose request
    const PRESET_TRANSITIONS: Record<string, { transition: string; transition_duration: number; subtitle_style: string }> = {
      dynamic: { transition: 'fade',        transition_duration: 0.3,  subtitle_style: 'tiktok'    },
      smooth:  { transition: 'smoothleft',  transition_duration: 0.5,  subtitle_style: 'cinematic' },
      minimal: { transition: 'cut',         transition_duration: 0,    subtitle_style: 'minimal'   },
    };
    const preset = PRESET_TRANSITIONS[body.preset];

    const scenes = sceneKeys.map((key, i) => ({
      scene_id: `test_${testId}_${i}`,
      type: 'image' as const,
      storage_key: key,
      duration_sec: body.scene_duration,
      transition: preset.transition,
      transition_duration: preset.transition_duration,
      ken_burns: 'auto',
    }));

    const subtitles = body.with_subtitles
      ? sceneKeys.map((_, i) => ({
          start_sec: i * body.scene_duration,
          end_sec:   (i + 1) * body.scene_duration,
          text: `Тестовая сцена ${i + 1} — Пресет: ${body.preset}`,
        }))
      : [];

    const outputKey = `test/compose/${testId}/output_${body.preset}.mp4`;

    const composeRequest = {
      job_id:    `test_${testId}`,
      tenant_id: 'test',
      output_key: outputKey,
      scenes,
      subtitles,
      settings: { subtitle_style: preset.subtitle_style },
    };

    // 4. Call video-processor
    logger.info({ testId, preset: body.preset, scenes: scenes.length }, 'Sending test compose request');

    try {
      const composeRes = await fetch(`${vpUrl}/compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(composeRequest),
        signal: AbortSignal.timeout(600_000), // 10 min max
      });

      if (!composeRes.ok) {
        const errBody = await composeRes.text();
        logger.error({ testId, status: composeRes.status, body: errBody }, 'Test compose failed');
        return reply.code(composeRes.status).send({
          error: 'ComposeFailed',
          message: `video-processor вернул HTTP ${composeRes.status}`,
          detail: errBody,
        });
      }

      const result = await composeRes.json();

      // 5. Generate presigned URL for the output
      const outputUrl = await storage.presignedUrl(outputKey, 86400);

      const elapsed = Date.now() - startTime;
      logger.info({ testId, elapsed, outputKey }, 'Test compose completed');

      await audit(req.user.userId, 'test-compose', 'system', testId, req.ip, {
        after: { preset: body.preset, scenes: scenes.length, elapsed },
      });

      return reply.send({
        test_id: testId,
        preset: body.preset,
        compose_result: result,
        output_url: outputUrl,
        elapsed_ms: elapsed,
      });
    } catch (e: any) {
      logger.error({ testId, error: e.message }, 'Test compose error');
      return reply.code(500).send({
        error: 'ComposeError',
        message: e.message,
      });
    }
  });
}
