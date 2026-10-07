/**
 * Autopilot journal + failure accounting shared by the produce worker and the
 * scheduler loop. Every meaningful event (batch created, stage advanced, posts
 * scheduled, error) becomes an AutopilotRun row — the user's window into what
 * the unattended factory is doing.
 */
import type { PrismaClient } from '@kmmzavod/db';
import { logger } from '../logger';

/** After this many consecutive failed batches the autopilot stops itself. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export async function journal(
  db: PrismaClient,
  ap: { id: string; tenantId: string },
  kind: 'produce' | 'advance' | 'distribute' | 'error' | 'info',
  message: string,
  extra: { summary?: Record<string, unknown>; error?: string } = {},
): Promise<void> {
  await db.autopilotRun.create({
    data: {
      autopilotId: ap.id,
      tenantId: ap.tenantId,
      kind,
      message: message.slice(0, 500),
      summary: (extra.summary ?? {}) as object,
      error: extra.error?.slice(0, 2000) ?? null,
    },
  }).catch((err) => logger.warn({ err: err.message, autopilotId: ap.id }, 'Autopilot: journal write failed'));
}

/**
 * Mark a batch failed and bump the autopilot's failure streak. On the
 * MAX_CONSECUTIVE_FAILURES-th failure the autopilot flips to `error` and the
 * user is notified — better to stop than to burn LLM/TTS/CPU on a broken setup.
 */
export async function failBatch(
  db: PrismaClient,
  batchId: string,
  reason: string,
): Promise<void> {
  const batch = await db.autopilotBatch.update({
    where: { id: batchId },
    data: { status: 'failed', error: reason.slice(0, 2000), completedAt: new Date() },
    include: { autopilot: { select: { id: true, tenantId: true, name: true, consecutiveFailures: true, status: true } } },
  });
  const ap = batch.autopilot;
  const failures = ap.consecutiveFailures + 1;
  const stop = failures >= MAX_CONSECUTIVE_FAILURES && ap.status === 'active';

  await db.autopilot.update({
    where: { id: ap.id },
    data: {
      consecutiveFailures: failures,
      lastError: reason.slice(0, 1000),
      ...(stop ? { status: 'error' } : {}),
    },
  });
  await journal(db, ap, 'error', `Монтаж #${batchId.slice(0, 8)} не удался`, { error: reason });

  if (stop) {
    await journal(db, ap, 'error', `Автопилот остановлен: ${failures} ошибки подряд`);
    await db.notification.create({
      data: {
        tenantId: ap.tenantId,
        type: 'job_failed',
        title: 'Автопилот остановлен',
        body: `«${ap.name}»: ${failures} неудачных монтажа подряд. Последняя ошибка: ${reason.slice(0, 300)}`,
        actionUrl: `/autopilot/${ap.id}`,
      },
    }).catch(() => {});
  }
}
