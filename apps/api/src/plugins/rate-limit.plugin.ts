import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getRedis } from '../lib/redis';
import { config } from '../config';

/**
 * Rate-limit key. The limiter runs in onRequest, before `authenticate`, so req.user is
 * never set yet — verify the bearer token here instead. The signature is checked: a
 * forged/unsigned token must not mint fresh buckets. Falls back to the client IP.
 */
function rateLimitKey(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = req.server.jwt.verify<{ userId?: string; type?: string }>(auth.slice(7));
      if (payload.userId && payload.type === undefined) return `rl:user:${payload.userId}`;
    } catch {
      // expired / invalid → treat as anonymous
    }
  }
  return `rl:ip:${req.ip}`;
}

async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    redis: getRedis() as any,
    // Ключ изоляции: авторизованный пользователь — по userId, иначе по IP
    keyGenerator: rateLimitKey,
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

/**
 * Per-route override for live phone control (screen frames, taps, swipes, keys):
 * a 4 fps remote view alone is 240 requests/min, well above the global limit.
 * Same per-user key, separate bucket per route.
 */
export const farmControlRateLimit = {
  rateLimit: {
    max: config.FARM_CONTROL_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  },
};

export default fp(rateLimitPlugin, { name: 'rate-limit' });
