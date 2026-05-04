/**
 * Preset routes — CRUD + preview + factory activation for VideoPreset.
 *
 * A VideoPreset is a template that generates MANY unique videos
 * from one product. Flow: create preset → preview → activate factory.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { pipelineQueue } from '../lib/queues';
import { logger } from '../logger';
import type { PipelineJobPayload } from '@kmmzavod/queue';

const EDIT_STYLES = ['dynamic', 'smooth', 'minimal', 'random'] as const;

const SOCIAL_PLATFORMS = ['tiktok', 'instagram', 'youtube_shorts', 'postbridge'] as const;

// Validates a 5-field standard cron expression (minute hour dom month dow)
function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  // [min, max] for each cron field: minute, hour, dom, month, dow
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.every((field, i) => {
    const [lo, hi] = ranges[i];
    if (field === '*') return true;
    // Step: */n or base/n
    if (field.includes('/')) {
      const [left, right] = field.split('/');
      const step = parseInt(right, 10);
      if (isNaN(step) || step < 1) return false;
      if (left === '*') return true;
      const base = parseInt(left, 10);
      return !isNaN(base) && base >= lo && base <= hi;
    }
    // List: n,m,k
    if (field.includes(',')) {
      return field.split(',').every(v => { const n = parseInt(v, 10); return !isNaN(n) && n >= lo && n <= hi; });
    }
    // Range: n-m
    if (field.includes('-')) {
      const parts = field.split('-').map(v => parseInt(v, 10));
      return parts.length === 2 && parts.every(n => !isNaN(n)) && parts[0] >= lo && parts[1] <= hi && parts[0] <= parts[1];
    }
    // Single numeric value
    const n = parseInt(field, 10);
    return !isNaN(n) && n >= lo && n <= hi;
  });
}

const CRON_REFINE = { message: 'Некорректное cron-выражение. Пример: "0 10 * * *" (5 полей: мин час день-месяца месяц день-недели)' };

const CreatePresetBody = z.object({
  productId:        z.string().uuid(),
  name:             z.string().min(1).max(100).default('Новый пресет'),
  heygenAvatarId:   z.string().default('Anna_public_20240108'),
  heygenVoiceId:    z.string().default('70856236390f4d0392d00187143d3900'),
  editStyle:        z.enum(EDIT_STYLES).default('random'),
  targetDurationSec: z.number().int().min(15).max(90).default(30),
  customPrompt:     z.string().max(2000).optional(),
  cronExpression:   z.string().min(5).max(100).refine(isValidCron, CRON_REFINE).default('0 10 * * *'),
  timezone:         z.string().default('Europe/Moscow'),
  autoPublish:      z.boolean().default(false),
  publishPlatforms: z.array(z.enum(SOCIAL_PLATFORMS)).default([]),
  socialAccountIds: z.array(z.string().uuid()).default([]),
  bgmEnabled:       z.boolean().default(true),
});

const UpdatePresetBody = z.object({
  name:             z.string().min(1).max(100).optional(),
  heygenAvatarId:   z.string().optional(),
  heygenVoiceId:    z.string().optional(),
  editStyle:        z.enum(EDIT_STYLES).optional(),
  targetDurationSec: z.number().int().min(15).max(90).optional(),
  customPrompt:     z.string().max(2000).nullable().optional(),
  cronExpression:   z.string().min(5).max(100).refine(isValidCron, CRON_REFINE).optional(),
  timezone:         z.string().optional(),
  autoPublish:      z.boolean().optional(),
  publishPlatforms: z.array(z.enum(SOCIAL_PLATFORMS)).optional(),
  socialAccountIds: z.array(z.string().uuid()).optional(),
  bgmEnabled:       z.boolean().optional(),
});

const ListQuery = z.object({
  productId: z.string().uuid().optional(),
  status:    z.enum(['draft', 'preview', 'active', 'paused']).optional(),
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(20),
});

export async function presetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ── List presets ──────────────────────────────────────────────────────────
  app.get('/', async (req) => {
    const { tenantId } = req.user;
    const { page, limit, productId, status } = ListQuery.parse(req.query);
    const skip = (page - 1) * limit;
    const where = {
      tenantId,
      ...(productId && { productId }),
      ...(status && { status }),
    };

    const [presets, total] = await Promise.all([
      db.videoPreset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          product: { select: { id: true, name: true } },
          previewVideo: { select: { id: true, status: true, outputUrl: true } },
          _count: { select: { videos: true } },
        },
      }),
      db.videoPreset.count({ where }),
    ]);

    return { presets, total, page, limit };
  });

  // ── Create preset ─────────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const { tenantId } = req.user;
    const body = CreatePresetBody.parse(req.body);

    const product = await db.product.findFirst({
      where: { id: body.productId, tenantId },
      select: { id: true },
    });
    if (!product) return reply.code(404).send({ error: 'Product not found' });

    const preset = await db.videoPreset.create({
      data: {
        tenantId,
        productId: body.productId,
        name: body.name,
        heygenAvatarId: body.heygenAvatarId,
        heygenVoiceId: body.heygenVoiceId,
        editStyle: body.editStyle,
        targetDurationSec: body.targetDurationSec,
        customPrompt: body.customPrompt,
        cronExpression: body.cronExpression,
        timezone: body.timezone,
        autoPublish: body.autoPublish,
        publishPlatforms: body.publishPlatforms,
        socialAccountIds: body.socialAccountIds,
        bgmEnabled: body.bgmEnabled,
        status: 'draft',
      },
    });

    logger.info({ presetId: preset.id, tenantId }, 'Preset created');
    return reply.code(201).send({ preset });
  });

  // ── Get single preset ─────────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const preset = await db.videoPreset.findFirst({
      where: { id, tenantId },
      include: {
        product: { select: { id: true, name: true } },
        previewVideo: { select: { id: true, status: true, outputUrl: true, thumbnailUrl: true } },
        _count: { select: { videos: true } },
      },
    });
    if (!preset) return reply.code(404).send({ error: 'Preset not found' });

    return { preset };
  });

  // ── Update preset ─────────────────────────────────────────────────────────
  app.patch('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };
    const body = UpdatePresetBody.parse(req.body);

    const existing = await db.videoPreset.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Preset not found' });

    // Don't allow editing active preset without pausing first
    if (existing.status === 'active') {
      return reply.code(409).send({ error: 'Pause the preset before editing' });
    }

    const preset = await db.videoPreset.update({
      where: { id },
      data: body,
    });

    return { preset };
  });

  // ── Delete preset ─────────────────────────────────────────────────────────
  app.delete('/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const existing = await db.videoPreset.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: 'Preset not found' });

    await db.videoPreset.delete({ where: { id } });
    return reply.code(204).send();
  });

  // ── Generate preview video ────────────────────────────────────────────────
  // POST /api/v1/presets/:id/preview
  app.post('/:id/preview', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const preset = await db.videoPreset.findFirst({
      where: { id, tenantId },
      include: { product: { select: { id: true, name: true } } },
    });
    if (!preset) return reply.code(404).send({ error: 'Preset not found' });

    // Create preview Video linked to preset
    const video = await db.video.create({
      data: {
        tenantId,
        productId: preset.productId,
        presetId: preset.id,
        title: `${preset.product?.name ?? 'Product'} — превью`,
        status: 'pending',
        metadata: { presetId: preset.id, isPreview: true },
      },
    });

    // Create Job with preset settings
    const job = await db.job.create({
      data: {
        tenantId,
        videoId: video.id,
        status: 'pending',
        payload: {
          scriptPrompt: preset.customPrompt ?? '',
          productId: preset.productId,
          presetId: preset.id,
          settings: {
            avatar_id: preset.heygenAvatarId,
            voice_id: preset.heygenVoiceId,
            durationSec: preset.targetDurationSec,
            editStyle: preset.editStyle === 'random' ? 'dynamic' : preset.editStyle,
            bgm_enabled: true,
          },
        },
      },
    });

    // Link preview video to preset
    await db.videoPreset.update({
      where: { id: preset.id },
      data: { previewVideoId: video.id, status: 'preview' },
    });

    // Enqueue pipeline
    await pipelineQueue.add(
      `preview:${preset.id}:${job.id}`,
      { jobId: job.id, tenantId } satisfies PipelineJobPayload,
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );

    logger.info({ presetId: preset.id, videoId: video.id, jobId: job.id, tenantId }, 'Preview generation started');
    return reply.code(202).send({ video, jobId: job.id });
  });

  // ── Activate factory (start auto-generation) ─────────────────────────────
  // POST /api/v1/presets/:id/activate
  app.post('/:id/activate', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const preset = await db.videoPreset.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, cronExpression: true, timezone: true },
    });
    if (!preset) return reply.code(404).send({ error: 'Preset not found' });

    if (preset.status === 'active') {
      return reply.code(409).send({ error: 'Preset is already active' });
    }

    // Compute next run time (immediate = now)
    const now = new Date();
    const updated = await db.videoPreset.update({
      where: { id },
      data: { status: 'active', nextRunAt: now },
    });

    logger.info({ presetId: id, tenantId }, 'Preset activated — factory started');
    return { preset: updated };
  });

  // ── Pause factory ─────────────────────────────────────────────────────────
  // POST /api/v1/presets/:id/pause
  app.post('/:id/pause', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const preset = await db.videoPreset.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true },
    });
    if (!preset) return reply.code(404).send({ error: 'Preset not found' });

    const updated = await db.videoPreset.update({
      where: { id },
      data: { status: 'paused', nextRunAt: null },
    });

    logger.info({ presetId: id, tenantId }, 'Preset paused');
    return { preset: updated };
  });
}
