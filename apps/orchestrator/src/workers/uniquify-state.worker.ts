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
      const { uniquifyJobId, variantId, status } = job.data;

      logger.info(
        { uniquifyJobId, variantId, status },
        'Uniquify-state: processing variant result',
      );

      // Recompute counters from the actual variant rows on every event. This is
      // fully idempotent — duplicate/retried events just re-derive the same
      // numbers — unlike a blind increment (which double-counts on retry) or the
      // old status-equality guard (which ALWAYS tripped, because the render
      // worker sets variant.status='completed' BEFORE emitting this event, so the
      // job counters never advanced and the job hung on `generating`).
      await db.$transaction(async (tx) => {
        const [completedCount, failedCount] = await Promise.all([
          tx.uniqueVariant.count({ where: { uniquifyJobId, status: 'completed' } }),
          tx.uniqueVariant.count({ where: { uniquifyJobId, status: 'failed' } }),
        ]);

        const uniquifyJob = await tx.uniquifyJob.findUniqueOrThrow({
          where: { id: uniquifyJobId },
          select: { variantCount: true, status: true },
        });

        const totalDone = completedCount + failedCount;
        const finished =
          totalDone >= uniquifyJob.variantCount &&
          uniquifyJob.status !== 'completed' &&
          uniquifyJob.status !== 'failed';

        const data: Record<string, unknown> = { completedCount, failedCount };
        if (finished) {
          const allFailed = completedCount === 0;
          data.status = allFailed ? 'failed' : 'completed';
          data.completedAt = new Date();
          data.error = allFailed ? `All ${failedCount} variants failed` : null;
        }

        await tx.uniquifyJob.update({ where: { id: uniquifyJobId }, data });

        if (finished) {
          logger.info(
            { uniquifyJobId, completed: completedCount, failed: failedCount, finalStatus: data.status },
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
