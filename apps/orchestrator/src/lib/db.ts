import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

export const db = new PrismaClient({
  log: [{ emit: 'event', level: 'error' }],
});

db.$on('error', (e) => {
  logger.error({ message: e.message }, 'Prisma error');
});
