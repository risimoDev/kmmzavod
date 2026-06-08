import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { uniquifyAnalyzeQueue, distributeQueue } from '../lib/queues';
import { StoragePaths } from '@kmmzavod/storage';
import { logger } from '../logger';
import type { UniquifyAnalyzeJobPayload, DistributeJobPayload } from '@kmmzavod/queue';

// ── Zod schemas ──────────────────────────────────────────────────────────────

const UploadSourceVideoBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  projectId: z.string().uuid().optional(),
});

const CreateUniquifyJobBody = z.object({
  sourceVideoId: z.string().uuid(),
  variantCount: z.number().int().min(1).max(100).default(10),
  targetPlatforms: z.array(z.enum(['tiktok', 'instagram', 'youtube_shorts', 'postbridge'])).default([]),
  config: z.object({
    bgmTrackKeys: z.array(z.string()).optional(),
    ttsVoiceIds: z.array(z.string()).optional(),
    enableSubtitles: z.boolean().default(true),
    enableTts: z.boolean().default(false),
    enableBgm: z.boolean().default(true),
  }).default({}),
});

const ListSourceVideosQuery = z.object({
  status: z.enum(['uploading', 'analyzing', 'ready', 'failed']).optional(),
  projectId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const ListUniquifyJobsQuery = z.object({
  status: z.enum(['pending', 'analyzing', 'generating', 'completed', 'failed', 'cancelled']).optional(),
  sourceVideoId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const ListVariantsQuery = z.object({
  status: z.enum(['pending', 'rendering', 'tts', 'completed', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const DistributeBody = z.object({
  socialAccountIds: z.array(z.string().uuid()).min(1),
  staggerMinutes: z.number().int().min(0).max(1440).default(15),
  captionTemplate: z.string().max(2200).optional(),
  hashtags: z.array(z.string().max(100)).max(30).default([]),
  // Optional: specific variant → account mapping. If not provided, round-robin.
  assignments: z.array(z.object({
    variantId: z.string().uuid(),
    socialAccountId: z.string().uuid(),
    caption: z.string().max(2200).optional(),
    hashtags: z.array(z.string().max(100)).max(30).optional(),
  })).optional(),
});

// ── Routes ───────────────────────────────────────────────────────────────────

export async function uniquifyRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', app.authenticate);

  // ── Source Videos ────────────────────────────────────────────────────────

  /**
   * POST /source-videos/upload-url
   * Get a presigned upload URL for a source video.
   */
  app.post('/source-videos/upload-url', async (req, reply) => {
    const body = UploadSourceVideoBody.parse(req.body);
    const { tenantId, userId } = req.user;

    // Create SourceVideo record
    const sourceVideo = await db.sourceVideo.create({
      data: {
        tenantId,
        uploadedBy: userId,
        title: body.title,
        description: body.description,
        projectId: body.projectId,
        status: 'uploading',
        storageKey: '', // Will be set after key is generated
      },
    });

    const filename = `source_${Date.now()}.mp4`;
    const storageKey = StoragePaths.sourceVideo(tenantId, sourceVideo.id, filename);

    // Update with actual key
    await db.sourceVideo.update({
      where: { id: sourceVideo.id },
      data: { storageKey },
    });

    // Generate presigned upload URL
    const uploadUrl = await app.storage.presignedPutUrl(storageKey, 'video/mp4', 3600);

    return reply.code(201).send({
      sourceVideoId: sourceVideo.id,
      storageKey,
      uploadUrl,
    });
  });

  /**
   * POST /source-videos/:id/confirm-upload
   * Confirm that upload is complete. Triggers analysis if autoAnalyze=true.
   */
  app.post('/source-videos/:id/confirm-upload', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;
    const body = z.object({ autoAnalyze: z.boolean().default(true) }).parse(req.body ?? {});

    const sourceVideo = await db.sourceVideo.findFirst({
      where: { id, tenantId },
    });
    if (!sourceVideo) return reply.code(404).send({ error: 'NotFound' });
    if (sourceVideo.status !== 'uploading') {
      return reply.code(400).send({ error: 'BadRequest', message: 'Video is not in uploading state' });
    }

    await db.sourceVideo.update({
      where: { id },
      data: { status: 'ready' },
    });

    return reply.send({ status: 'ok', sourceVideoId: id });
  });

  /**
   * GET /source-videos
   * List source videos for the tenant.
   */
  app.get('/source-videos', async (req, reply) => {
    const query = ListSourceVideosQuery.parse(req.query);
    const { tenantId } = req.user;

    const where: Record<string, unknown> = { tenantId, isArchived: false };
    if (query.status) where.status = query.status;
    if (query.projectId) where.projectId = query.projectId;

    const [items, total] = await Promise.all([
      db.sourceVideo.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.sourceVideo.count({ where: where as any }),
    ]);

    // Resolve presigned URLs for ready videos
    const enriched = await Promise.all(
      items.map(async (v) => ({
        ...v,
        downloadUrl: v.storageKey
          ? await app.storage.presignedUrl(v.storageKey, 3600).catch(() => null)
          : null,
      })),
    );

    return reply.send({
      items: enriched,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    });
  });

  /**
   * GET /source-videos/:id
   * Get a single source video with download URL.
   */
  app.get('/source-videos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const sourceVideo = await db.sourceVideo.findFirst({
      where: { id, tenantId },
    });
    if (!sourceVideo) return reply.code(404).send({ error: 'NotFound' });

    const downloadUrl = sourceVideo.storageKey
      ? await app.storage.presignedUrl(sourceVideo.storageKey, 3600).catch(() => null)
      : null;

    return reply.send({ ...sourceVideo, downloadUrl });
  });

  /**
   * DELETE /source-videos/:id
   * Soft-delete (archive) a source video.
   */
  app.delete('/source-videos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const sourceVideo = await db.sourceVideo.findFirst({
      where: { id, tenantId },
    });
    if (!sourceVideo) return reply.code(404).send({ error: 'NotFound' });

    await db.sourceVideo.update({
      where: { id },
      data: { isArchived: true },
    });

    return reply.send({ status: 'ok' });
  });

  // ── Uniquify Jobs ───────────────────────────────────────────────────────

  /**
   * POST /uniquify-jobs
   * Create a new uniquification job and start the pipeline.
   */
  app.post('/uniquify-jobs', async (req, reply) => {
    const body = CreateUniquifyJobBody.parse(req.body);
    const { tenantId, userId } = req.user;

    // Verify source video exists and belongs to tenant
    const sourceVideo = await db.sourceVideo.findFirst({
      where: { id: body.sourceVideoId, tenantId },
    });
    if (!sourceVideo) {
      return reply.code(404).send({ error: 'NotFound', message: 'Source video not found' });
    }

    // Create the uniquify job
    const uniquifyJob = await db.uniquifyJob.create({
      data: {
        tenantId,
        sourceVideoId: body.sourceVideoId,
        createdBy: userId,
        status: 'pending',
        variantCount: body.variantCount,
        targetPlatforms: body.targetPlatforms as any,
        config: body.config as any,
      },
    });

    // Enqueue the analyze job
    await uniquifyAnalyzeQueue.add(
      `uniquify-analyze-${uniquifyJob.id}`,
      {
        sourceVideoId: body.sourceVideoId,
        tenantId,
        uniquifyJobId: uniquifyJob.id,
      } satisfies UniquifyAnalyzeJobPayload,
    );

    logger.info(
      { uniquifyJobId: uniquifyJob.id, sourceVideoId: body.sourceVideoId, variantCount: body.variantCount },
      'Uniquify job created',
    );

    return reply.code(201).send(uniquifyJob);
  });

  /**
   * GET /uniquify-jobs
   * List uniquification jobs.
   */
  app.get('/uniquify-jobs', async (req, reply) => {
    const query = ListUniquifyJobsQuery.parse(req.query);
    const { tenantId } = req.user;

    const where: Record<string, unknown> = { tenantId };
    if (query.status) where.status = query.status;
    if (query.sourceVideoId) where.sourceVideoId = query.sourceVideoId;

    const [items, total] = await Promise.all([
      db.uniquifyJob.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          sourceVideo: { select: { id: true, title: true, storageKey: true, durationSec: true, status: true } },
          _count: { select: { variants: true } },
        },
      }),
      db.uniquifyJob.count({ where: where as any }),
    ]);

    return reply.send({
      items,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    });
  });

  /**
   * GET /uniquify-jobs/:id
   * Get a single uniquification job with variants.
   */
  app.get('/uniquify-jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const job = await db.uniquifyJob.findFirst({
      where: { id, tenantId },
      include: {
        sourceVideo: true,
        variants: {
          orderBy: { variantIndex: 'asc' },
        },
      },
    });
    if (!job) return reply.code(404).send({ error: 'NotFound' });

    // Resolve presigned URLs for completed variants
    const enrichedVariants = await Promise.all(
      job.variants.map(async (v) => ({
        ...v,
        downloadUrl: v.outputKey
          ? await app.storage.presignedUrl(v.outputKey, 3600).catch(() => null)
          : null,
        thumbnailUrl: v.thumbnailKey
          ? await app.storage.presignedUrl(v.thumbnailKey, 3600).catch(() => null)
          : null,
      })),
    );

    return reply.send({ ...job, variants: enrichedVariants });
  });

  /**
   * POST /uniquify-jobs/:id/cancel
   * Cancel a running uniquification job.
   */
  app.post('/uniquify-jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const job = await db.uniquifyJob.findFirst({
      where: { id, tenantId },
    });
    if (!job) return reply.code(404).send({ error: 'NotFound' });

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return reply.code(400).send({ error: 'BadRequest', message: 'Job is already in terminal state' });
    }

    await db.uniquifyJob.update({
      where: { id },
      data: { status: 'cancelled' },
    });

    return reply.send({ status: 'ok' });
  });

  // ── Variants ────────────────────────────────────────────────────────────

  /**
   * GET /uniquify-jobs/:jobId/variants
   * List variants for a uniquification job.
   */
  app.get('/uniquify-jobs/:jobId/variants', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const query = ListVariantsQuery.parse(req.query);
    const { tenantId } = req.user;

    // Verify job belongs to tenant
    const job = await db.uniquifyJob.findFirst({
      where: { id: jobId, tenantId },
      select: { id: true },
    });
    if (!job) return reply.code(404).send({ error: 'NotFound' });

    const where: Record<string, unknown> = { uniquifyJobId: jobId };
    if (query.status) where.status = query.status;

    const [items, total] = await Promise.all([
      db.uniqueVariant.findMany({
        where: where as any,
        orderBy: { variantIndex: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.uniqueVariant.count({ where: where as any }),
    ]);

    // Resolve presigned URLs
    const enriched = await Promise.all(
      items.map(async (v) => ({
        ...v,
        downloadUrl: v.outputKey
          ? await app.storage.presignedUrl(v.outputKey, 3600).catch(() => null)
          : null,
        thumbnailUrl: v.thumbnailKey
          ? await app.storage.presignedUrl(v.thumbnailKey, 3600).catch(() => null)
          : null,
      })),
    );

    return reply.send({
      items: enriched,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    });
  });

  /**
   * GET /uniquify-jobs/:jobId/variants/:variantId
   * Get a single variant with download URL.
   */
  app.get('/uniquify-jobs/:jobId/variants/:variantId', async (req, reply) => {
    const { jobId, variantId } = req.params as { jobId: string; variantId: string };
    const { tenantId } = req.user;

    const variant = await db.uniqueVariant.findFirst({
      where: { id: variantId, uniquifyJobId: jobId, tenantId },
    });
    if (!variant) return reply.code(404).send({ error: 'NotFound' });

    const downloadUrl = variant.outputKey
      ? await app.storage.presignedUrl(variant.outputKey, 3600).catch(() => null)
      : null;
    const thumbnailUrl = variant.thumbnailKey
      ? await app.storage.presignedUrl(variant.thumbnailKey, 3600).catch(() => null)
      : null;

    return reply.send({ ...variant, downloadUrl, thumbnailUrl });
  });

  // ── Distribution ──────────────────────────────────────────────────────────

  /**
   * POST /uniquify-jobs/:id/distribute
   * Create a distribution plan to publish variants across multiple accounts.
   * Automatically maps variants to accounts via round-robin if no explicit assignments.
   */
  app.post('/uniquify-jobs/:id/distribute', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = DistributeBody.parse(req.body);
    const { tenantId, userId } = req.user;

    // Verify uniquify job exists and is completed
    const uniquifyJob = await db.uniquifyJob.findFirst({
      where: { id, tenantId },
      include: {
        variants: {
          where: { status: 'completed' },
          orderBy: { variantIndex: 'asc' },
          select: { id: true, variantIndex: true },
        },
      },
    });
    if (!uniquifyJob) return reply.code(404).send({ error: 'NotFound' });
    if (uniquifyJob.status !== 'completed') {
      return reply.code(400).send({ error: 'BadRequest', message: 'Uniquify job is not completed' });
    }
    if (uniquifyJob.variants.length === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'No completed variants to distribute' });
    }

    // Verify all social accounts belong to tenant and are active
    const accounts = await db.socialAccount.findMany({
      where: { id: { in: body.socialAccountIds }, tenantId, isActive: true },
      select: { id: true, platform: true, accountName: true },
    });
    if (accounts.length === 0) {
      return reply.code(400).send({ error: 'BadRequest', message: 'No active social accounts found' });
    }

    // Build variant→account assignments
    let items: Array<{ variantId: string; socialAccountId: string; caption?: string; hashtags?: string[] }>;

    if (body.assignments && body.assignments.length > 0) {
      // Explicit mapping
      items = body.assignments;
    } else {
      // Round-robin: distribute variants across accounts
      items = [];
      const accountIds = accounts.map(a => a.id);
      for (let i = 0; i < uniquifyJob.variants.length; i++) {
        const variant = uniquifyJob.variants[i];
        const accountId = accountIds[i % accountIds.length];
        items.push({ variantId: variant.id, socialAccountId: accountId });
      }
    }

    // Create DistributeJob + items in a transaction
    const distJob = await db.$transaction(async (tx) => {
      const dj = await tx.distributeJob.create({
        data: {
          tenantId,
          uniquifyJobId: id,
          createdBy: userId,
          status: 'pending',
          staggerMinutes: body.staggerMinutes,
          captionTemplate: body.captionTemplate,
          hashtags: body.hashtags,
          totalItems: items.length,
        },
      });

      await tx.distributeItem.createMany({
        data: items.map((item) => ({
          distributeJobId: dj.id,
          uniqueVariantId: item.variantId,
          socialAccountId: item.socialAccountId,
          status: 'pending' as const,
          caption: item.caption ?? null,
          hashtags: item.hashtags ?? [],
        })),
      });

      return dj;
    });

    // Enqueue distribute job
    await distributeQueue.add(
      `distribute-${distJob.id}`,
      { distributeJobId: distJob.id, tenantId } satisfies DistributeJobPayload,
    );

    logger.info(
      { distributeJobId: distJob.id, uniquifyJobId: id, items: items.length, accounts: accounts.length },
      'Distribute job created',
    );

    return reply.code(201).send(distJob);
  });

  /**
   * GET /uniquify-jobs/:id/distribute
   * List distribution jobs for a uniquify job.
   */
  app.get('/uniquify-jobs/:id/distribute', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const distJobs = await db.distributeJob.findMany({
      where: { uniquifyJobId: id, tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { items: true } },
      },
    });

    return reply.send({ items: distJobs });
  });

  /**
   * GET /distribute-jobs/:id
   * Get a single distribute job with all items and their statuses.
   */
  app.get('/distribute-jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const distJob = await db.distributeJob.findFirst({
      where: { id, tenantId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            uniqueVariant: { select: { id: true, variantIndex: true, outputKey: true, thumbnailKey: true } },
            socialAccount: { select: { id: true, platform: true, accountName: true } },
            publishJob: { select: { id: true, status: true, publishedAt: true, externalPostId: true, error: true } },
          },
        },
      },
    });
    if (!distJob) return reply.code(404).send({ error: 'NotFound' });

    return reply.send(distJob);
  });

  /**
   * POST /distribute-jobs/:id/cancel
   * Cancel a running distribution job.
   */
  app.post('/distribute-jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const distJob = await db.distributeJob.findFirst({
      where: { id, tenantId },
    });
    if (!distJob) return reply.code(404).send({ error: 'NotFound' });

    if (distJob.status === 'completed' || distJob.status === 'failed' || distJob.status === 'cancelled') {
      return reply.code(400).send({ error: 'BadRequest', message: 'Job is already in terminal state' });
    }

    await db.distributeJob.update({
      where: { id },
      data: { status: 'cancelled' },
    });

    // Mark pending items as skipped
    await db.distributeItem.updateMany({
      where: { distributeJobId: id, status: 'pending' },
      data: { status: 'skipped', error: 'Distribution cancelled' },
    });

    return reply.send({ status: 'ok' });
  });
}
