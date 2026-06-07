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

      // Update the parent job counters atomically
      if (status === 'completed') {
        await db.uniquifyJob.update({
          where: { id: uniquifyJobId },
          data: { completedCount: { increment: 1 } },
        });
      } else {
        await db.uniquifyJob.update({
          where: { id: uniquifyJobId },
          data: { failedCount: { increment: 1 } },
        });
      }

      // Check if all variants are done
      const uniquifyJob = await db.uniquifyJob.findUniqueOrThrow({
        where: { id: uniquifyJobId },
      });

      const totalDone = uniquifyJob.completedCount + uniquifyJob.failedCount;

      if (totalDone >= uniquifyJob.variantCount) {
        // All variants processed — update job status
        const allFailed = uniquifyJob.completedCount === 0;
        const finalStatus = allFailed ? 'failed' : 'completed';
        const finalError = allFailed
          ? `All ${uniquifyJob.failedCount} variants failed`
          : undefined;

        await db.uniquifyJob.update({
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
    },
    {
      connection,
      concurrency: QUEUES['uniquify-state'].concurrency,
    },
  );
}
