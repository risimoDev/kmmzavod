import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { getRedis } from '../lib/redis';
import { config } from '../config';

async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    redis: getRedis() as any,
    // Ключ изоляции: если пользователь авторизован — по tenant_id, иначе по IP
    keyGenerator(req) {
      const user = (req as any).user;
      return user?.tenantId ? `rl:tenant:${user.tenantId}` : `rl:ip:${req.ip}`;
    },
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder(_req, context) {
      return {
        error: 'TooManyRequests',
        message: `Слишком много запросов. Повторите через ${Math.ceil(context.ttl / 1000)} сек.`,
        retryAfter: Math.ceil(context.ttl / 1000),
      };
    },
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });
