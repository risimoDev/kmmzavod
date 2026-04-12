import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../lib/db';

// Расширяем типы @fastify/jwt для typed request.user
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      userId: string;
      tenantId: string;
      role: 'owner' | 'admin' | 'member' | 'viewer';
      platformRole: 'super_admin' | 'user';
      email: string;
    };
    user: {
      userId: string;
      tenantId: string;
      role: 'owner' | 'admin' | 'member' | 'viewer';
      platformRole: 'super_admin' | 'user';
      email: string;
    };
  }
}

async function authPlugin(app: FastifyInstance) {
  // Декоратор authenticate — вешается на маршруты как preHandler
  app.decorate(
    'authenticate',
    async function (req: FastifyRequest, reply: FastifyReply) {
      try {
        await req.jwtVerify();
      } catch (err) {
        reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
        return;
      }
      // Verify user and tenant are still active (token may outlive a ban)
      const user = await db.user.findUnique({
        where: { id: req.user.userId },
        select: { isActive: true, tenant: { select: { isActive: true } } },
      });
      if (!user || !user.isActive) {
        reply.code(403).send({ error: 'Forbidden', message: 'Аккаунт заблокирован' });
        return;
      }
      if (!user.tenant.isActive) {
        reply.code(403).send({ error: 'Forbidden', message: 'Организация заблокирована' });
        return;
      }
    }
  );

  // Декоратор requireAdmin
  app.decorate(
    'requireAdmin',
    async function (req: FastifyRequest, reply: FastifyReply) {
      try {
        await req.jwtVerify();
      } catch {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      const payload = req.user;
      if (payload.platformRole !== 'super_admin') {
        reply.code(403).send({ error: 'Forbidden', message: 'Недостаточно прав' });
        return;
      }
      // Verify user is still active
      const user = await db.user.findUnique({
        where: { id: payload.userId },
        select: { isActive: true, tenant: { select: { isActive: true } } },
      });
      if (!user || !user.isActive || !user.tenant.isActive) {
        reply.code(403).send({ error: 'Forbidden', message: 'Аккаунт заблокирован' });
        return;
      }
    }
  );
}

export default fp(authPlugin, { name: 'auth' });

// Объявляем декораторы для TypeScript
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

