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

/**
 * Only access tokens may authenticate requests. Legacy refresh tokens were JWTs signed
 * with the same secret (marked `type: 'refresh'`) and live 30 days — reject them.
 */
export function isAccessTokenPayload(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && (payload as { type?: unknown }).type === undefined;
}

/** Routes a read-only `viewer` may still call with a mutating method. */
const VIEWER_WRITE_ALLOWED = /^\/api\/v1\/(auth|notifications)(\/|$)/;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
      if (!isAccessTokenPayload(req.user)) {
        reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
        return;
      }
      if (
        req.user.role === 'viewer' &&
        !READ_METHODS.has(req.method) &&
        !VIEWER_WRITE_ALLOWED.test(req.routeOptions.url ?? '')
      ) {
        reply.code(403).send({ error: 'Forbidden', message: 'Роль «наблюдатель» — только просмотр' });
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
      if (!isAccessTokenPayload(req.user)) {
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

