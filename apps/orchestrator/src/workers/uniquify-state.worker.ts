/**
 * Uniquify-state worker.
 *
 * Tracks completion/failure of individual variants. When all variants are done,
 * marks the parent UniquifyJob as completed.
 */

import { Worker, type ConnectionOptions } from 'bullmq';
import { QUEUES, type UniquifyStateJobPayload } from '@kmmzavod/queue';
import type { PrismaClient } from '@kmmzavod/db';
import { logger } from '../logger';

interface Deps {
  db: PrismaClient;
  connection: ConnectionOptions;
}

export function createUniquifyStateWorker(deps: Deps): Worker {
  const { db, connection } = deps;

  return new Worker<UniquifyStateJobPayload>(
    QUEUES['uniquify-state'].name,
    async (job) => {
      const { uniquifyJobId, variantId, tenantId, status, error } = job.data;

      logger.info(
        { uniquifyJobId, variantId, status },
        'Uniquify-state: processing variant result',
      );

      // Guard against duplicate events from BullMQ retries.
      const variant = await db.uniqueVariant.findUnique({
        where: { id: variantId },
        select: { status: true },
      });
      if (variant?.status === status) {
        logger.info({ variantId, status }, 'Uniquify-state: duplicate event, skipping');
        return;
      }

      // Atomic increment + completion check inside a transaction
      await db.$transaction(async (tx) => {
        if (status === 'completed') {
          await tx.uniquifyJob.update({
            where: { id: uniquifyJobId },
            data: { completedCount: { increment: 1 } },
          });
        } else {
          await tx.uniquifyJob.update({
            where: { id: uniquifyJobId },
            data: { failedCount: { increment: 1 } },
          });
        }

        const uniquifyJob = await tx.uniquifyJob.findUniqueOrThrow({
          where: { id: uniquifyJobId },
        });

        const totalDone = uniquifyJob.completedCount + uniquifyJob.failedCount;

        if (totalDone >= uniquifyJob.variantCount) {
          const allFailed = uniquifyJob.completedCount === 0;
          const finalStatus = allFailed ? 'failed' : 'completed';
          const finalError = allFailed
            ? `All ${uniquifyJob.failedCount} variants failed`
            : null;

          await tx.uniquifyJob.update({
            where: { id: uniquifyJobId },
            data: {
              status: finalStatus as any,
              completedAt: new Date(),
              error: finalError,
            },
          });

          logger.info(
            {
              uniquifyJobId,
              completed: uniquifyJob.completedCount,
              failed: uniquifyJob.failedCount,
              finalStatus,
            },
            'Uniquify-state: job finished',
          );
        }
      });
    },
    {
      connection,
      concurrency: QUEUES['uniquify-state'].concurrency,
    },
  );
}
