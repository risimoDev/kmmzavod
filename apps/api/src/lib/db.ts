import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

export const db = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

if (process.env.NODE_ENV !== 'production') {
  // Логируем медленные запросы (>200ms) в dev
  db.$on('query', (e) => {
    if (e.duration > 200) {
      logger.warn({ query: e.query, duration: e.duration }, 'Slow query');
    }
  });
}

db.$on('error', (e) => {
  logger.error({ message: e.message }, 'Prisma error');
});
