import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';

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

    return reply.code(201).send(project);
  });

  // GET /api/v1/projects
  app.get('/', async (req, reply) => {
    const { tenantId } = req.user;
    const projects = await db.project.findMany({
      where: { tenantId, isArchived: false },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { videos: true, assets: true } } },
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
        _count: { select: { videos: true, assets: true } },
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
