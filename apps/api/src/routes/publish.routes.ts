/**
 * Маршруты управления социальными аккаунтами и публикацией видео.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { publishQueue } from '../lib/queues';
import { logger } from '../logger';
import type { PublishJobPayload } from '@kmmzavod/queue';

// ── Validation schemas ──────────────────────────────────────────────────────

const CreateSocialAccountBody = z.object({
  platform: z.enum(['tiktok', 'instagram', 'youtube_shorts']),
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  accountName: z.string().min(1).max(200),
});

const PublishVideoBody = z.object({
  socialAccountId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  caption: z.string().max(2200).optional(),
  hashtags: z.array(z.string().max(100)).max(30).default([]),
  scheduledAt: z.string().datetime().optional(),
});

const ListPublishJobsQuery = z.object({
  status: z.enum(['pending', 'scheduled', 'uploading', 'published', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── Routes ──────────────────────────────────────────────────────────────────

export async function publishRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // ── Social Accounts ─────────────────────────────────────────────────────

  /** POST /api/v1/social-accounts — подключить аккаунт соцсети */
  app.post('/social-accounts', async (req, reply) => {
    const body = CreateSocialAccountBody.parse(req.body);
    const { tenantId } = req.user;

    const account = await db.socialAccount.create({
      data: {
        tenantId,
        platform: body.platform,
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        accountName: body.accountName,
      },
    });

    logger.info({ accountId: account.id, platform: body.platform, tenantId }, 'Social account created');

    return reply.code(201).send({
      id: account.id,
      platform: account.platform,
      accountName: account.accountName,
      isActive: account.isActive,
      createdAt: account.createdAt,
    });
  });

  /** GET /api/v1/social-accounts — список подключённых аккаунтов */
  app.get('/social-accounts', async (req) => {
    const { tenantId } = req.user;

    const accounts = await db.socialAccount.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        platform: true,
        accountName: true,
        isActive: true,
        expiresAt: true,
        createdAt: true,
        _count: { select: { publishJobs: true } },
      },
    });

    return { data: accounts };
  });

  /** DELETE /api/v1/social-accounts/:id — отключить аккаунт */
  app.delete<{ Params: { id: string } }>('/social-accounts/:id', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params;

    const account = await db.socialAccount.findFirst({
      where: { id, tenantId },
    });

    if (!account) {
      return reply.code(404).send({ error: 'NotFound', message: 'Social account not found' });
    }

    await db.socialAccount.update({
      where: { id },
      data: { isActive: false },
    });

    return { success: true };
  });

  // ── Publish ──────────────────────────────────────────────────────────────

  /** POST /api/v1/videos/:videoId/publish — создать задачу публикации */
  app.post<{ Params: { videoId: string } }>('/videos/:videoId/publish', async (req, reply) => {
    const body = PublishVideoBody.parse(req.body);
    const { tenantId } = req.user;
    const { videoId } = req.params;

    // Verify video belongs to tenant and is completed
    const video = await db.video.findFirst({
      where: { id: videoId, tenantId, status: 'completed' },
    });

    if (!video) {
      return reply.code(404).send({
        error: 'NotFound',
        message: 'Video not found or not yet completed',
      });
    }

    // Verify social account belongs to tenant
    const account = await db.socialAccount.findFirst({
      where: { id: body.socialAccountId, tenantId, isActive: true },
    });

    if (!account) {
      return reply.code(404).send({
        error: 'NotFound',
        message: 'Social account not found or not active',
      });
    }

    // Verify variant if specified
    if (body.variantId) {
      const variant = await db.videoVariant.findFirst({
        where: { id: body.variantId, videoId },
      });
      if (!variant) {
        return reply.code(404).send({
          error: 'NotFound',
          message: 'Video variant not found',
        });
      }
    }

    // Create publish job record
    const publishJob = await db.publishJob.create({
      data: {
        videoId,
        tenantId,
        socialAccountId: body.socialAccountId,
        variantId: body.variantId,
        platform: account.platform,
        caption: body.caption,
        hashtags: body.hashtags,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        status: body.scheduledAt ? 'scheduled' : 'pending',
      },
    });

    // Enqueue BullMQ job
    const jobPayload: PublishJobPayload = {
      publishJobId: publishJob.id,
      videoId,
      tenantId,
      platform: account.platform,
      socialAccountId: account.id,
      scheduledAt: body.scheduledAt,
    };

    const delay = body.scheduledAt
      ? Math.max(0, new Date(body.scheduledAt).getTime() - Date.now())
      : undefined;

    await publishQueue.add(`publish:${publishJob.id}`, jobPayload, {
      delay,
      jobId: publishJob.id,
    });

    logger.info(
      { publishJobId: publishJob.id, platform: account.platform, videoId, delay },
      'Publish job enqueued',
    );

    return reply.code(201).send({
      id: publishJob.id,
      platform: publishJob.platform,
      status: publishJob.status,
      scheduledAt: publishJob.scheduledAt,
      createdAt: publishJob.createdAt,
    });
  });

  /** GET /api/v1/videos/:videoId/publish-jobs — список задач публикации для видео */
  app.get<{ Params: { videoId: string } }>('/videos/:videoId/publish-jobs', async (req) => {
    const { tenantId } = req.user;
    const { videoId } = req.params;
    const query = ListPublishJobsQuery.parse(req.query);

    const where = {
      videoId,
      tenantId,
      ...(query.status && { status: query.status }),
    };

    const [data, total] = await Promise.all([
      db.publishJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          platform: true,
          status: true,
          caption: true,
          hashtags: true,
          scheduledAt: true,
          publishedAt: true,
          externalPostId: true,
          error: true,
          createdAt: true,
          socialAccount: {
            select: { id: true, accountName: true, platform: true },
          },
        },
      }),
      db.publishJob.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    };
  });
}
