/**
 * Preset routes — CRUD + preview + factory activation for VideoPreset.
 *
 * A VideoPreset is a template that generates MANY unique videos
 * from one product. Flow: create preset → preview → activate factory.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { logger } from '../logger';
import { createVideoJob } from '../lib/video-job';

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

// Factory minimum interval is 1 hour: the minute field must be a single number
// (not `*`, `*/n`, a list or a range), so the cron can fire at most once per hour.
function isAtLeastHourlyCron(expr: string | null | undefined): boolean {
  if (!expr) return true; // no cron → scheduler never reschedules it
  return /^\d+$/.test(expr.trim().split(/\s+/)[0] ?? '');
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

    if (body.socialAccountIds && body.socialAccountIds.length > 0) {
      const validCount = await db.socialAccount.count({
        where: { id: { in: body.socialAccountIds }, tenantId },
      });
      if (validCount !== body.socialAccountIds.length) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Некоторые социальные аккаунты не принадлежат вашей организации' });
      }
    }

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

    if (body.socialAccountIds && body.socialAccountIds.length > 0) {
      const validCount = await db.socialAccount.count({
        where: { id: { in: body.socialAccountIds }, tenantId },
      });
      if (validCount !== body.socialAccountIds.length) {
        return reply.code(400).send({ error: 'BadRequest', message: 'Некоторые социальные аккаунты не принадлежат вашей организации' });
      }
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

    // Same reserve + create + enqueue path as POST /videos: a preview costs credits like
    // any other video. Payload is snake_case (script_prompt / avatar_id / voice_id) —
    // that's what the pipeline coordinator reads.
    const result = await createVideoJob({
      tenantId,
      userId: req.user.userId,
      title: `${preset.product?.name ?? 'Product'} — превью`,
      productId: preset.productId,
      presetId: preset.id,
      scriptPrompt: preset.customPrompt ?? '',
      avatarId: preset.heygenAvatarId,
      voiceId: preset.heygenVoiceId,
      settings: {
        durationSec: preset.targetDurationSec,
        editStyle: preset.editStyle === 'random' ? 'dynamic' : preset.editStyle,
        bgm_enabled: true,
      },
      videoMetadata: { presetId: preset.id, isPreview: true },
      reserveDescription: `Reserve for preset preview "${preset.name}"`,
    });

    if (!result.ok) {
      if (result.reason === 'insufficient_credits') {
        return reply.code(402).send({
          error: 'InsufficientCredits',
          message: 'Недостаточно кредитов для генерации превью.',
          available: result.available,
          required: result.required,
        });
      }
      return reply.code(503).send({ error: 'ServiceUnavailable', message: 'Очередь задач недоступна. Попробуйте позже.' });
    }
    const { video, job } = result;

    // Link preview video to preset
    await db.videoPreset.update({
      where: { id: preset.id },
      data: { previewVideoId: video.id, status: 'preview' },
    });

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

    // Factory presets run unattended and spend credits: no more often than once an hour.
    if (!isAtLeastHourlyCron(preset.cronExpression)) {
      return reply.code(400).send({
        error: 'BadRequest',
        message: 'Фабрика не может запускаться чаще раза в час. В поле «минуты» cron-выражения укажите одно число (например "0 10 * * *" или "30 */2 * * *").',
      });
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
