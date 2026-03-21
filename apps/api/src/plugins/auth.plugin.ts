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
      email: string;
    };
    user: {
      userId: string;
      tenantId: string;
      role: 'owner' | 'admin' | 'member' | 'viewer';
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
      if (payload.role !== 'admin' && payload.role !== 'owner') {
        reply.code(403).send({ error: 'Forbidden', message: 'Недостаточно прав' });
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

