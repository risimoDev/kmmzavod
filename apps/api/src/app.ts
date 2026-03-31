// Prisma returns BigInt for autoincrement IDs and large integer columns.
// JSON.stringify doesn't know how to serialize BigInt natively, so we add toJSON.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fp from 'fastify-plugin';
import { config } from './config';
import { logger } from './logger';
import { db } from './lib/db';
import { MinioStorageClient } from '@kmmzavod/storage';

import authPlugin from './plugins/auth.plugin';
import rateLimitPlugin from './plugins/rate-limit.plugin';

import { authRoutes } from './routes/auth.routes';
import { videoRoutes } from './routes/videos.routes';
import { projectRoutes } from './routes/projects.routes';
import { productRoutes } from './routes/products.routes';
import { adminRoutes } from './routes/admin.routes';
import { publishRoutes } from './routes/publish.routes';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      ...(config.NODE_ENV !== 'production' && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }),
      redact: ['req.headers.authorization'],
    },
    trustProxy: true, // behind nginx
    ajv: {
      customOptions: { coerceTypes: 'array', removeAdditional: true },
    },
  });

  // ── Plugins ──────────────────────────────────────────────────────────────
  await app.register(fastifyCors, {
    origin: config.NODE_ENV === 'production' ? false : true,
    credentials: true,
  });

  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_ACCESS_TTL },
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  });

  await app.register(rateLimitPlugin);
  await app.register(authPlugin);

  // Storage singleton через декоратор приложения
  const storage = new MinioStorageClient({
    endPoint: config.MINIO_ENDPOINT,
    port: config.MINIO_PORT,
    useSSL: config.MINIO_USE_SSL,
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
    bucket: config.MINIO_BUCKET,
  });
  app.decorate('storage', storage);

  // Ensure MinIO bucket exists on startup
  await storage.ensureBucket();

  // ── Глобальный обработчик ошибок ─────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    // Zod validation errors
    if (err.name === 'ZodError') {
      return reply.code(400).send({
        error: 'ValidationError',
        message: 'Ошибка валидации данных',
        details: (err as any).errors,
      });
    }

    // Prisma not found
    if ((err as any).code === 'P2025') {
      return reply.code(404).send({ error: 'NotFound', message: 'Запись не найдена' });
    }

    // Prisma unique constraint
    if ((err as any).code === 'P2002') {
      return reply.code(409).send({ error: 'Conflict', message: 'Запись уже существует' });
    }

    req.log.error({ err, url: req.url, method: req.method }, 'Unhandled error');

    const code = err.statusCode ?? 500;
    return reply.code(code).send({
      error: code === 500 ? 'InternalServerError' : err.name,
      message: code === 500 ? 'Внутренняя ошибка сервера' : err.message,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'NotFound', message: `Маршрут ${req.method} ${req.url} не найден` });
  });

  // ── Routes ───────────────────────────────────────────────────────────────
  app.register(authRoutes,    { prefix: '/api/v1/auth' });
  app.register(videoRoutes,   { prefix: '/api/v1/videos' });
  app.register(projectRoutes, { prefix: '/api/v1/projects' });
  app.register(productRoutes, { prefix: '/api/v1/products' });
  app.register(adminRoutes,   { prefix: '/api/v1/admin' });
  app.register(publishRoutes, { prefix: '/api/v1' });

  // Health check
  app.get('/health', { logLevel: 'warn' }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Получен сигнал завершения');
    await app.close();
    await db.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return app;
}

// Type declaration for storage decorator
declare module 'fastify' {
  interface FastifyInstance {
    storage: import('@kmmzavod/storage').IStorageClient;
  }
}
