/**
 * Distribute schedule routes — CRUD for DistributeSchedule.
 *
 * A schedule periodically (cron) takes fresh completed UniqueVariants that were
 * never scheduled/published and spreads them across farm accounts through the
 * standard DistributeJob pipeline (all anti-ban gates apply). The tick lives in
 * the orchestrator's scheduler worker.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { logger } from '../logger';

const CreateBody = z.object({
  name: z.string().min(1).max(200).default('Auto-distribute'),
  cronExpression: z.string().min(5).max(100), // e.g. "0 12,18 * * *"
  timezone: z.string().max(50).default('Europe/Moscow'),
  isActive: z.boolean().default(true),
  uniquifyJobId: z.string().uuid().optional(),
  socialAccountIds: z.array(z.string().uuid()).default([]),
  accountGroupId: z.string().uuid().optional(),
  variantsPerAccount: z.number().int().min(1).max(10).default(1),
  staggerMinutes: z.number().int().min(1).max(1440).default(15),
  captionTemplate: z.string().max(2000).optional(),
  hashtags: z.array(z.string().max(100)).max(30).default([]),
}).refine((b) => b.socialAccountIds.length > 0 || b.accountGroupId, {
  message: 'Provide socialAccountIds and/or accountGroupId',
});

const UpdateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  cronExpression: z.string().min(5).max(100).optional(),
  timezone: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
  uniquifyJobId: z.string().uuid().nullable().optional(),
  socialAccountIds: z.array(z.string().uuid()).optional(),
  accountGroupId: z.string().uuid().nullable().optional(),
  variantsPerAccount: z.number().int().min(1).max(10).optional(),
  staggerMinutes: z.number().int().min(1).max(1440).optional(),
  captionTemplate: z.string().max(2000).nullable().optional(),
  hashtags: z.array(z.string().max(100)).max(30).optional(),
});

export async function distributeScheduleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ── List ────────────────────────────────────────────────────────────────
  app.get('/', async (req) => {
    const { tenantId } = req.user;
    const schedules = await db.distributeSchedule.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return { schedules };
  });

  // ── Create ──────────────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const { tenantId } = req.user;
    const body = CreateBody.parse(req.body);

    // Validate referenced entities belong to the tenant
    if (body.uniquifyJobId) {
      const job = await db.uniquifyJob.findFirst({
        where: { id: body.uniquifyJobId, tenantId }, select: { id: true },
      });
      if (!job) return reply.code(404).send({ error: 'Uniquify job not found' });
    }
    if (body.accountGroupId) {
      const group = await db.accountGroup.findFirst({
        where: { id: body.accountGroupId, tenantId }, select: { id: true },
      });
      if (!group) return reply.code(404).send({ error: 'Account group not found' });
    }
    if (body.socialAccountIds.length > 0) {
      const count = await db.socialAccount.count({
        where: { id: { in: body.socialAccountIds }, tenantId },
      });
      if (count !== body.socialAccountIds.length) {
        return reply.code(400).send({ error: 'Some social accounts do not belong to tenant' });
      }
    }

    const schedule = await db.distributeSchedule.create({
      data: {
        tenantId,
        name: body.name,
        cronExpression: body.cronExpression,
        timezone: body.timezone,
        isActive: body.isActive,
        uniquifyJobId: body.uniquifyJobId,
        socialAccountIds: body.socialAccountIds,
        accountGroupId: body.accountGroupId,
        variantsPerAccount: body.variantsPerAccount,
        staggerMinutes: body.staggerMinutes,
        captionTemplate: body.captionTemplate,
        hashtags: body.hashtags,
        // The scheduler worker computes the accurate next cron occurrence;
        // seeding with `now` makes the first run happen on the next tick.
        nextRunAt: new Date(),
      },
    });

    logger.info({ scheduleId: schedule.id, tenantId, cron: body.cronExpression }, 'Distribute schedule created');
    return reply.code(201).send({ schedule });
  });

  // ── Get ─────────────────────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const schedule = await db.distributeSchedule.findFirst({ where: { id, tenantId } });
    if (!schedule) return reply.code(404).send({ error: 'Schedule not found' });
    return { schedule };
  });

  // ── Update ──────────────────────────────────────────────────────────────
  app.patch('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = UpdateBody.parse(req.body);

    const existing = await db.distributeSchedule.findFirst({
      where: { id, tenantId }, select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Schedule not found' });

    const schedule = await db.distributeSchedule.update({
      where: { id },
      data: {
        ...body,
        // Cron/timezone change → recompute on the next tick, starting from now
        ...(body.cronExpression || body.timezone ? { nextRunAt: new Date() } : {}),
      },
    });
    return { schedule };
  });

  // ── Delete ──────────────────────────────────────────────────────────────
  app.delete('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const existing = await db.distributeSchedule.findFirst({
      where: { id, tenantId }, select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Schedule not found' });
    await db.distributeSchedule.delete({ where: { id } });
    return reply.code(204).send();
  });
}
