import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';
import { StoragePaths } from '@kmmzavod/storage';
import { emitNotification } from '../lib/notifications';
import { logger } from '../logger';

const CreateProjectBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  settings: z.record(z.unknown()).optional(),
});

export async function projectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // POST /api/v1/projects
  app.post('/', async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);
    const { tenantId } = req.user;

    const project = await db.project.create({
      data: {
        tenantId,
        name: body.name,
        description: body.description ?? null,
        settings: (body.settings as any) ?? {},
      },
    });

    await emitNotification({
      tenantId,
      userId: req.user.userId,
      type: 'system',
      title: 'Проект создан',
      body: `Создан новый проект "${project.name}"`,
      actionUrl: `/projects?selected=${project.id}`,
    });

    return reply.code(201).send(project);
  });

  // GET /api/v1/projects
  app.get('/', async (req, reply) => {
    const { tenantId } = req.user;
    const projects = await db.project.findMany({
      where: { tenantId, isArchived: false },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { videos: true, assets: true, sourceVideos: true } } },
    });
    return reply.send(projects);
  });

  // GET /api/v1/projects/:id
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const project = await db.project.findFirst({
      where: { id, tenantId },
      include: {
        _count: { select: { videos: true, assets: true, sourceVideos: true } },
        videos: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, title: true, status: true, createdAt: true },
        },
        assets: {
          where: { isDeleted: false },
          take: 20,
        },
      },
    });

    if (!project) {
      return reply.code(404).send({ error: 'NotFound' });
    }

    return reply.send(project);
  });

  // GET /api/v1/projects/:id/hub - Consolidated 4-stage data hub
  app.get('/:id/hub', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const project = await db.project.findFirst({
      where: { id, tenantId },
      include: {
        _count: { select: { videos: true, assets: true, sourceVideos: true } },
      },
    });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    // 1. Raw source videos uploaded to this project
    const rawVideos = await db.sourceVideo.findMany({
      where: { projectId: id, tenantId, isArchived: false },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { uniquifyJobs: true } },
      },
    });

    const enrichedRawVideos = await Promise.all(
      rawVideos.map(async (v) => ({
        ...v,
        url: v.storageKey ? await app.storage.presignedUrl(v.storageKey, 3600).catch(() => null) : null,
      })),
    );

    // 2. Master clips from Smart Editor (editClips with outputKey, linked to project)
    const editorClips = await db.editClip.findMany({
      where: {
        outputKey: { not: null },
        project: {
          tenantId,
          OR: [
            { config: { path: ['workspaceProjectId'], equals: id } },
            { name: { contains: project.name } },
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        project: { select: { id: true, name: true, mode: true, aspect: true } },
      },
    });

    const enrichedMasterClips = await Promise.all(
      editorClips.map(async (c) => ({
        ...c,
        url: c.outputKey ? await app.storage.presignedUrl(c.outputKey, 3600).catch(() => null) : null,
        thumbnailUrl: c.thumbnailKey ? await app.storage.presignedUrl(c.thumbnailKey, 3600).catch(() => null) : null,
      })),
    );

    // 3. Unique variants generated for this project's source videos
    const projectSourceIds = rawVideos.map((v) => v.id);
    const uniqueVariants = projectSourceIds.length > 0
      ? await db.uniqueVariant.findMany({
          where: {
            uniquifyJob: {
              sourceVideoId: { in: projectSourceIds },
            },
          },
          orderBy: { createdAt: 'desc' },
          include: {
            uniquifyJob: {
              select: { id: true, status: true, variantCount: true, sourceVideoId: true },
            },
          },
        })
      : [];

    const enrichedUniqueVariants = await Promise.all(
      uniqueVariants.map(async (uv) => ({
        ...uv,
        url: uv.outputKey ? await app.storage.presignedUrl(uv.outputKey, 3600).catch(() => null) : null,
        thumbnailUrl: uv.thumbnailKey ? await app.storage.presignedUrl(uv.thumbnailKey, 3600).catch(() => null) : null,
      })),
    );

    // 4. Distribute jobs for this project's variants
    const distributeJobs = projectSourceIds.length > 0
      ? await db.distributeJob.findMany({
          where: {
            uniquifyJob: {
              sourceVideoId: { in: projectSourceIds },
            },
          },
          orderBy: { createdAt: 'desc' },
          include: {
            items: {
              include: {
                socialAccount: { select: { id: true, accountName: true, platform: true, deviceId: true } },
              },
            },
          },
        })
      : [];

    return reply.send({
      project,
      rawVideos: enrichedRawVideos,
      masterClips: enrichedMasterClips,
      uniqueVariants: enrichedUniqueVariants,
      distributeJobs,
    });
  });

  // POST /api/v1/projects/:id/source-videos/upload - Direct upload of raw footage into project
  app.post('/:id/source-videos/upload', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    const { tenantId, userId } = req.user;

    const project = await db.project.findFirst({ where: { id: projectId, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound', message: 'Проект не найден' });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'BadRequest', message: 'Файл не передан' });
    if (!data.mimetype.startsWith('video/')) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Допустим только видеофайл' });
    }

    const filename = data.filename || `source_${Date.now()}.mp4`;
    const source = await db.sourceVideo.create({
      data: {
        tenantId,
        projectId,
        uploadedBy: userId,
        title: data.filename?.replace(/\.[^/.]+$/, '') || 'Новое видео',
        status: 'uploading',
        storageKey: '',
        mimeType: data.mimetype,
      },
    });

    const storageKey = StoragePaths.sourceVideo(tenantId, source.id, filename);
    try {
      await app.storage.uploadStream(storageKey, data.file, undefined, { contentType: data.mimetype });
      if (data.file.truncated) {
        await db.sourceVideo.delete({ where: { id: source.id } }).catch(() => {});
        return reply.code(413).send({ error: 'PayloadTooLarge', message: 'Файл превышает лимит' });
      }

      const updated = await db.sourceVideo.update({
        where: { id: source.id },
        data: { storageKey, status: 'ready' },
      });

      await emitNotification({
        tenantId,
        userId,
        type: 'system',
        title: 'Видео загружено в проект',
        body: `Видео "${updated.title}" успешно загружено в проект "${project.name}"`,
        actionUrl: `/projects?selected=${projectId}`,
      });

      const url = await app.storage.presignedUrl(storageKey, 3600).catch(() => null);
      return reply.code(201).send({ ...updated, url });
    } catch (err) {
      logger.error({ err, sourceId: source.id }, 'Project source video upload failed');
      await db.sourceVideo.delete({ where: { id: source.id } }).catch(() => {});
      return reply.code(500).send({ error: 'UploadFailed', message: 'Ошибка при сохранении видео' });
    }
  });

  // DELETE /api/v1/projects/:id/source-videos/:videoId
  app.delete('/:id/source-videos/:videoId', async (req, reply) => {
    const { id, videoId } = req.params as { id: string; videoId: string };
    const { tenantId } = req.user;

    const source = await db.sourceVideo.findFirst({
      where: { id: videoId, projectId: id, tenantId },
    });
    if (!source) return reply.code(404).send({ error: 'NotFound' });

    await db.sourceVideo.update({
      where: { id: videoId },
      data: { isArchived: true },
    });
    return reply.code(204).send();
  });

  // PATCH /api/v1/projects/:id
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;
    const body = CreateProjectBody.partial().parse(req.body);

    const project = await db.project.findFirst({ where: { id, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    const updated = await db.project.update({
      where: { id },
      data: {
        ...(body.name && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.settings && { settings: body.settings as any }),
      },
    });

    return reply.send(updated);
  });

  // DELETE /api/v1/projects/:id (архивирует, не удаляет)
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const project = await db.project.findFirst({ where: { id, tenantId } });
    if (!project) return reply.code(404).send({ error: 'NotFound' });

    await db.project.update({ where: { id }, data: { isArchived: true } });
    return reply.code(204).send();
  });
}
