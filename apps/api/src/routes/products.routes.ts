import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';

const CreateProductBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  features: z.array(z.string().max(500)).max(20).default([]),
  targetAudience: z.string().max(1000).optional(),
  brandVoice: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  price: z.string().max(100).optional(),
  websiteUrl: z.string().url().max(2000).optional(),
  images: z.array(z.string()).max(10).default([]),
  projectId: z.string().uuid().optional(),
});

const UpdateProductBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  features: z.array(z.string().max(500)).max(20).optional(),
  targetAudience: z.string().max(1000).optional(),
  brandVoice: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  price: z.string().max(100).optional(),
  websiteUrl: z.string().url().max(2000).optional(),
  images: z.array(z.string()).max(10).optional(),
});

const ListProductsQuery = z.object({
  projectId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function productRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // POST /api/v1/products — создать продукт
  app.post('/', async (req, reply) => {
    const body = CreateProductBody.parse(req.body);
    const { tenantId, userId } = req.user;

    if (body.projectId) {
      const project = await db.project.findFirst({
        where: { id: body.projectId, tenantId },
      });
      if (!project) {
        return reply.code(404).send({ error: 'NotFound', message: 'Проект не найден' });
      }
    }

    const product = await db.product.create({
      data: {
        tenantId,
        projectId: body.projectId ?? null,
        createdBy: userId,
        name: body.name,
        description: body.description ?? null,
        features: body.features,
        targetAudience: body.targetAudience ?? null,
        brandVoice: body.brandVoice ?? null,
        category: body.category ?? null,
        price: body.price ?? null,
        websiteUrl: body.websiteUrl ?? null,
        images: body.images,
      },
    });

    return reply.code(201).send(product);
  });

  // GET /api/v1/products — список продуктов
  app.get('/', async (req, reply) => {
    const query = ListProductsQuery.parse(req.query);
    const { tenantId } = req.user;

    const where = {
      tenantId,
      isArchived: false,
      ...(query.projectId && { projectId: query.projectId }),
    };

    const [products, total] = await Promise.all([
      db.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { _count: { select: { videos: true } } },
      }),
      db.product.count({ where }),
    ]);

    return reply.send({
      data: products,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    });
  });

  // GET /api/v1/products/:id — детали продукта
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const product = await db.product.findFirst({
      where: { id, tenantId },
      include: {
        videos: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            title: true,
            status: true,
            thumbnailUrl: true,
            durationSec: true,
            createdAt: true,
          },
        },
      },
    });

    if (!product) {
      return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
    }

    return reply.send(product);
  });

  // PATCH /api/v1/products/:id — обновить продукт
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = UpdateProductBody.parse(req.body);
    const { tenantId } = req.user;

    const existing = await db.product.findFirst({ where: { id, tenantId } });
    if (!existing) {
      return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
    }

    const product = await db.product.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.features !== undefined && { features: body.features }),
        ...(body.targetAudience !== undefined && { targetAudience: body.targetAudience }),
        ...(body.brandVoice !== undefined && { brandVoice: body.brandVoice }),
        ...(body.category !== undefined && { category: body.category }),
        ...(body.price !== undefined && { price: body.price }),
        ...(body.websiteUrl !== undefined && { websiteUrl: body.websiteUrl }),
        ...(body.images !== undefined && { images: body.images }),
      },
    });

    return reply.send(product);
  });

  // DELETE /api/v1/products/:id — удалить (архивировать) продукт
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.user;

    const product = await db.product.findFirst({ where: { id, tenantId } });
    if (!product) {
      return reply.code(404).send({ error: 'NotFound', message: 'Продукт не найден' });
    }

    await db.product.update({ where: { id }, data: { isArchived: true } });

    return reply.code(204).send();
  });
}
