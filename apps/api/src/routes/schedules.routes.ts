/**
 * Schedule routes — CRUD for VideoSchedule (auto-generation + auto-publish).
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { logger } from '../logger';

const CreateScheduleBody = z.object({
  productId: z.string().uuid(),
  name: z.string().min(1).max(100).default('Auto-schedule'),
  cronExpression: z.string().min(5).max(100), // e.g. "0 10 * * 1,3,5"
  timezone: z.string().default('Europe/Moscow'),
  autoPublish: z.boolean().default(false),
  publishPlatforms: z.array(z.enum(['tiktok', 'instagram', 'youtube_shorts', 'postbridge'])).default([]),
  socialAccountIds: z.array(z.string().uuid()).default([]),
  avatarId: z.string().optional(),
  voiceId: z.string().optional(),
  durationSec: z.number().int().min(15).max(90).default(30),
  language: z.string().default('ru'),
  bgmEnabled: z.boolean().default(true),
});

const UpdateScheduleBody = z.object({
  name: z.string().min(1).max(100).optional(),
  cronExpression: z.string().min(5).max(100).optional(),
  timezone: z.string().optional(),
  isActive: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  publishPlatforms: z.array(z.enum(['tiktok', 'instagram', 'youtube_shorts', 'postbridge'])).optional(),
  socialAccountIds: z.array(z.string().uuid()).optional(),
  avatarId: z.string().nullable().optional(),
  voiceId: z.string().nullable().optional(),
  durationSec: z.number().int().min(15).max(90).optional(),
  language: z.string().optional(),
  bgmEnabled: z.boolean().optional(),
});

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function scheduleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ── List schedules ─────────────────────────────────────────────────────────
  app.get('/', async (req) => {
    const { tenantId } = req.user;
    const { page, limit } = ListQuery.parse(req.query);
    const skip = (page - 1) * limit;

    const [schedules, total] = await Promise.all([
      db.videoSchedule.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.videoSchedule.count({ where: { tenantId } }),
    ]);

    return { schedules, total, page, limit };
  });

  // ── Create schedule ────────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const { tenantId } = req.user;
    const body = CreateScheduleBody.parse(req.body);

    // Verify product belongs to tenant
    const product = await db.product.findFirst({
      where: { id: body.productId, tenantId },
      select: { id: true },
    });
    if (!product) return reply.code(404).send({ error: 'Product not found' });

    // Compute first next_run_at (naive: assume it's sometime in the next 7 days)
    const now = new Date();

    const schedule = await db.videoSchedule.create({
      data: {
        tenantId,
        productId: body.productId,
        name: body.name,
        cronExpression: body.cronExpression,
        timezone: body.timezone,
        autoPublish: body.autoPublish,
        publishPlatforms: body.publishPlatforms,
        socialAccountIds: body.socialAccountIds,
        avatarId: body.avatarId,
        voiceId: body.voiceId,
        durationSec: body.durationSec,
        language: body.language,
        bgmEnabled: body.bgmEnabled,
        nextRunAt: now, // scheduler worker will compute the accurate next run
      },
    });

    logger.info({ scheduleId: schedule.id, tenantId, cron: body.cronExpression }, 'Schedule created');
    return reply.code(201).send({ schedule });
  });

  // ── Get single schedule ────────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const schedule = await db.videoSchedule.findFirst({
      where: { id, tenantId },
    });
    if (!schedule) return reply.code(404).send({ error: 'Schedule not found' });

    return { schedule };
  });

  // ── Update schedule ────────────────────────────────────────────────────────
  app.patch('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };
    const body = UpdateScheduleBody.parse(req.body);

    const existing = await db.videoSchedule.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Schedule not found' });

    const schedule = await db.videoSchedule.update({
      where: { id },
      data: body,
    });

    return { schedule };
  });

  // ── Delete schedule ────────────────────────────────────────────────────────
  app.delete('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const existing = await db.videoSchedule.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Schedule not found' });

    await db.videoSchedule.delete({ where: { id } });
    return reply.code(204).send();
  });
}
