import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db';

const listQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().min(1).max(100).default(30),
  page: z.coerce.number().min(1).default(1),
});

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // GET /api/v1/notifications
  app.get('/', async (req, reply) => {
    const { tenantId, userId } = req.user;
    const query = listQuerySchema.parse(req.query);

    const where: Record<string, unknown> = { tenantId };
    if (query.unreadOnly === 'true') {
      where.isRead = false;
    }

    const [items, total, unreadCount] = await Promise.all([
      db.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.notification.count({ where }),
      db.notification.count({ where: { tenantId, isRead: false } }),
    ]);

    return reply.send({
      items,
      total,
      unreadCount,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    });
  });

  // GET /api/v1/notifications/unread-count
  app.get('/unread-count', async (req, reply) => {
    const { tenantId } = req.user;
    const count = await db.notification.count({
      where: { tenantId, isRead: false },
    });
    return reply.send({ unreadCount: count });
  });

  // PATCH /api/v1/notifications/:id/read
  app.patch('/:id/read', async (req, reply) => {
    const { tenantId } = req.user;
    const { id } = req.params as { id: string };

    const item = await db.notification.findFirst({
      where: { id, tenantId },
    });
    if (!item) return reply.code(404).send({ error: 'NotFound' });

    const updated = await db.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
    return reply.send(updated);
  });

  // POST /api/v1/notifications/read-all
  app.post('/read-all', async (req, reply) => {
    const { tenantId } = req.user;

    await db.notification.updateMany({
      where: { tenantId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    return reply.send({ success: true });
  });
}
