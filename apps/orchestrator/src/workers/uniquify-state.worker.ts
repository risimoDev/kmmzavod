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
import { distance, isWeak, uniquenessScore, type Dist, type Signature } from '../lib/uniqueness';

/**
 * After a job finishes: for every completed copy find its nearest sibling
 * (visual + aligned audio distance), compute a 0..100 score, and flag weak
 * copies (≈ re-encode of the source, or ≈ duplicate of another copy). Weak
 * copies are skipped by the autopilot when publishing.
 */
export async function scoreUniquifyJob(db: PrismaClient, uniquifyJobId: string): Promise<{ weak: number; avg: number | null }> {
  const rows = await db.uniqueVariant.findMany({
    where: { uniquifyJobId, status: 'completed' },
    select: { id: true, transforms: true },
  });
  const sigs = rows.map((r) => ((r.transforms ?? {}) as { signature?: Signature }).signature ?? null);
  let weak = 0;
  const scores: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const t = (rows[i].transforms ?? {}) as Record<string, any>;
    const vsSource: Dist | null = t.uniqueness?.vs_source ?? null;
    let nearest: Dist | null = null;
    let nearestId: string | null = null;
    if (sigs[i]) {
      for (let j = 0; j < rows.length; j++) {
        if (i === j || !sigs[j]) continue;
        const d = distance(sigs[i]!, sigs[j]!);
        const key = (x: Dist | null) => (x ? (x.visual ?? 1) + (x.audio ?? 1) : Infinity);
        if (!nearest || key(d) < key(nearest)) { nearest = d; nearestId = rows[j].id; }
      }
    }
    // Score vs the source when known (preserve mode), else vs the nearest sibling (remix).
    const score = uniquenessScore(vsSource ?? nearest);
    const reason = isWeak(vsSource, nearest);
    if (reason) weak++;
    if (score !== null) scores.push(score);
    await db.uniqueVariant.update({
      where: { id: rows[i].id },
      data: {
        transforms: {
          ...t,
          uniqueness: { ...(t.uniqueness ?? {}), nearest_sibling: nearest, nearest_id: nearestId, score, ok: !reason, reason },
        } as object,
      },
    });
  }
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return { weak, avg };
}

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
      const finishedNow = await db.$transaction(async (tx) => {
        const [completedCount, failedCount] = await Promise.all([
          tx.uniqueVariant.count({ where: { uniquifyJobId, status: 'completed' } }),
          tx.uniqueVariant.count({ where: { uniquifyJobId, status: 'failed' } }),
        ]);

        const uniquifyJob = await tx.uniquifyJob.findUniqueOrThrow({
          where: { id: uniquifyJobId },
          select: {
            tenantId: true,
            variantCount: true,
            status: true,
            config: true,
            sourceVideo: { select: { title: true, projectId: true } },
          },
        });

        const totalDone = completedCount + failedCount;
        const finished =
          totalDone >= uniquifyJob.variantCount &&
          uniquifyJob.status !== 'completed' &&
          uniquifyJob.status !== 'failed' &&
          uniquifyJob.status !== 'cancelled';

        const data: Record<string, unknown> = { completedCount, failedCount };
        if (finished) {
          const allFailed = completedCount === 0;
          data.status = allFailed ? 'failed' : 'completed';
          data.completedAt = new Date();
          data.error = allFailed ? `All ${failedCount} variants failed` : null;
        }

        await tx.uniquifyJob.update({ where: { id: uniquifyJobId }, data });

        if (finished) {
          const allFailed = completedCount === 0;
          logger.info(
            { uniquifyJobId, completed: completedCount, failed: failedCount, finalStatus: data.status },
            'Uniquify-state: job finished',
          );

          // Autopilot jobs report through the autopilot journal instead.
          const fromAutopilot = Boolean((uniquifyJob.config as Record<string, unknown> | null)?.autopilotBatchId);
          if (!fromAutopilot) await tx.notification.create({
            data: {
              tenantId: uniquifyJob.tenantId,
              type: allFailed ? 'job_failed' : 'system',
              title: allFailed ? 'Ошибка уникализации видео' : 'Уникализация успешно завершена!',
              body: allFailed
                ? `Задача "${uniquifyJob.sourceVideo?.title || 'Без названия'}": все ${failedCount} вариантов не удалось сгенерировать.`
                : `Задача "${uniquifyJob.sourceVideo?.title || 'Без названия'}": готово ${completedCount} уникальных роликов (ошибок: ${failedCount}).`,
              actionUrl: uniquifyJob.sourceVideo?.projectId
                ? `/projects?selected=${uniquifyJob.sourceVideo.projectId}`
                : `/uniquify/jobs/${uniquifyJobId}`,
            },
          }).catch(() => {});
        }
        return finished && data.status === 'completed';
      });

      if (finishedNow) {
        try {
          const { weak, avg } = await scoreUniquifyJob(db, uniquifyJobId);
          logger.info({ uniquifyJobId, weak, avgScore: avg }, 'Uniquify-state: uniqueness scored');
        } catch (err: any) {
          logger.warn({ uniquifyJobId, err: err?.message }, 'Uniquify-state: uniqueness scoring failed');
        }
      }
    },
    {
      connection,
      concurrency: QUEUES['uniquify-state'].concurrency,
    },
  );
}
