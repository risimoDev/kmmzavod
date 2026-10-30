/**
 * Video/job lifecycle helpers shared by POST /videos, preset preview and cancel paths.
 *
 * Credit model (unchanged): creating a job soft-reserves `estimatedCredits`
 * (Tenant.credits -= N, CreditTransaction type='reserve'). Workers charge actual costs on
 * top; the reserve is released exactly once per job by a CreditTransaction type='refund'
 * (settle on success, refund on failure — apps/orchestrator/src/lib/credits.ts — or
 * releaseJobReserve() below on cancel / enqueue failure).
 */
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { pipelineQueue } from './queues';
import { logger } from '../logger';
import type { PipelineJobPayload } from '@kmmzavod/queue';

/**
 * Non-terminal Job statuses (see enum JobStatus). The orchestrator moves a job through
 * pending → running → scenes_ready → processing → composing → completed | failed.
 */
export const ACTIVE_JOB_STATUSES = ['pending', 'running', 'scenes_ready', 'processing', 'composing'] as const;

const DEFAULT_AVG_CREDITS = 15;  // fallback if admin setting is not set
const DEFAULT_SCENES_COUNT = 5;  // typical scene count

export async function estimateVideoCredits(): Promise<number> {
  let avgCreditsPerScene = DEFAULT_AVG_CREDITS;
  try {
    const setting = await db.adminSetting.findUnique({
      where: { key: 'avg_credits_per_scene' },
      select: { value: true },
    });
    if (setting?.value != null) {
      const parsed = Number(typeof setting.value === 'object' ? (setting.value as any).value : setting.value);
      if (parsed > 0) avgCreditsPerScene = parsed;
    }
  } catch { /* use default */ }
  return DEFAULT_SCENES_COUNT * avgCreditsPerScene;
}

export interface CreateVideoJobParams {
  tenantId: string;
  userId: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  productId?: string | null;
  presetId?: string | null;
  /** Final prompt for the script stage (already enriched with product data if needed). */
  scriptPrompt: string;
  avatarId: string;
  voiceId: string;
  /** Becomes Job.payload.settings (orchestrator reads durationSec, audio_track, editStyle, …). */
  settings: Record<string, unknown>;
  /** Video.metadata */
  videoMetadata: Record<string, unknown>;
  /** Reserve description — also used as `Reserve for video "<title>"`. */
  reserveDescription?: string;
}

export type CreateVideoJobResult =
  | { ok: true; video: { id: string; title: string; status: string; createdAt: Date }; job: { id: string } }
  | { ok: false; reason: 'insufficient_credits'; available: number; required: number }
  | { ok: false; reason: 'queue_unavailable' };

class InsufficientCreditsError extends Error {
  constructor(readonly available: number, readonly required: number) {
    super('InsufficientCredits');
  }
}

/**
 * Reserve credits + create Video and Job + enqueue the pipeline.
 *
 * The balance check and decrement are ONE atomic statement
 * (`updateMany where credits >= N`), so concurrent creates cannot overspend and no
 * Serializable isolation (→ P2034 → 500) is needed. Accounting is identical to the old
 * flow: Tenant.credits -= estimate, plus a 'reserve' CreditTransaction for -estimate.
 * On enqueue failure records are marked failed and the reserve is released.
 */
export async function createVideoJob(p: CreateVideoJobParams): Promise<CreateVideoJobResult> {
  const estimatedCredits = await estimateVideoCredits();

  let created: { video: any; job: any };
  try {
    created = await db.$transaction(async (tx) => {
      const reserved = await tx.tenant.updateMany({
        where: { id: p.tenantId, credits: { gte: estimatedCredits } },
        data: { credits: { decrement: estimatedCredits } },
      });
      if (reserved.count === 0) {
        const t = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId }, select: { credits: true } });
        throw new InsufficientCreditsError(t.credits, estimatedCredits);
      }

      const video = await tx.video.create({
        data: {
          tenantId: p.tenantId,
          projectId: p.projectId ?? null,
          productId: p.productId ?? null,
          presetId: p.presetId ?? null,
          createdBy: p.userId,
          title: p.title,
          description: p.description ?? null,
          status: 'pending',
          metadata: p.videoMetadata as Prisma.InputJsonValue,
        },
      });

      const job = await tx.job.create({
        data: {
          tenantId: p.tenantId,
          videoId: video.id,
          projectId: p.projectId ?? null,
          createdBy: p.userId,
          status: 'pending',
          payload: {
            script_prompt: p.scriptPrompt,
            avatar_id: p.avatarId,
            voice_id: p.voiceId,
            settings: p.settings,
            estimatedCredits,
          } as Prisma.InputJsonValue,
        },
      });

      const after = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId }, select: { credits: true } });
      await tx.creditTransaction.create({
        data: {
          tenantId: p.tenantId,
          type: 'reserve',
          amount: -estimatedCredits,
          balanceAfter: Math.max(0, after.credits),
          description: p.reserveDescription ?? `Reserve for video "${p.title}"`,
          jobId: job.id,
        },
      });

      return { video, job };
    });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return { ok: false, reason: 'insufficient_credits', available: err.available, required: err.required };
    }
    throw err;
  }

  const { video, job } = created;

  // jobId = Job.id so cancel can find (and remove) the queued pipeline job.
  const payload: PipelineJobPayload = { jobId: job.id, tenantId: p.tenantId };
  try {
    await pipelineQueue.add(`pipeline:${job.id}`, payload, { jobId: job.id });
  } catch (queueErr: any) {
    // Queue add failed — mark records failed (no zombie jobs) and give the reserve back.
    try {
      await db.$transaction([
        db.job.update({ where: { id: job.id }, data: { status: 'failed', error: 'Queue unavailable' } }),
        db.video.update({ where: { id: video.id }, data: { status: 'failed' } }),
      ]);
    } catch { /* best-effort cleanup */ }
    try {
      await releaseJobReserve(p.tenantId, job.id, estimatedCredits, 'Refund: pipeline could not be enqueued');
    } catch (relErr: any) {
      logger.error({ jobId: job.id, err: relErr.message }, 'Failed to release reserve after enqueue failure');
    }
    logger.error({ jobId: job.id, err: queueErr.message }, 'Failed to enqueue pipeline job — records marked failed');
    return { ok: false, reason: 'queue_unavailable' };
  }

  return { ok: true, video, job };
}

/**
 * Releases a job's soft reserve at most once (mirrors orchestrator `releaseReserveOnce`):
 * job row locked FOR UPDATE, skipped if a 'refund' CreditTransaction for the job already
 * exists (settle / failure handlers write the same marker, so no path can refund twice).
 */
export async function releaseJobReserve(
  tenantId: string,
  jobId: string,
  reservedCredits: number,
  description: string,
): Promise<void> {
  if (!(reservedCredits > 0)) return;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
    const already = await tx.creditTransaction.findFirst({
      where: { jobId, type: 'refund' },
      select: { id: true },
    });
    if (already) return;
    const updated = await tx.tenant.update({
      where: { id: tenantId },
      data: { credits: { increment: reservedCredits } },
      select: { credits: true },
    });
    await tx.creditTransaction.create({
      data: {
        tenantId,
        type: 'refund',
        amount: reservedCredits,
        balanceAfter: updated.credits,
        description,
        jobId,
      },
    });
  });
}

export function reservedCreditsOf(payload: unknown): number {
  const v = (payload as Record<string, unknown> | null)?.estimatedCredits;
  return typeof v === 'number' ? v : 0;
}

/**
 * Cancel a job's queued pipeline task (enqueued with jobId = Job.id). Waiting/delayed jobs
 * are removed; an active one is discarded (no retries) — the coordinator also refuses to
 * start a cancelled job. Best-effort: legacy jobs enqueued without a jobId aren't found.
 */
export async function removeQueuedPipelineJob(jobId: string): Promise<void> {
  try {
    const bullJob = await pipelineQueue.getJob(jobId);
    if (!bullJob) return;
    const state = await bullJob.getState();
    if (state === 'active') bullJob.discard();
    else if (state !== 'completed' && state !== 'failed') await bullJob.remove();
  } catch (err: any) {
    logger.warn({ jobId, err: err.message }, 'Failed to remove queued pipeline job');
  }
}

/**
 * Mark a job (and its video) cancelled, remove the queued task and release the reserve.
 * Returns false when the job was not in an active status (nothing changed, no refund) so a
 * repeated cancel can never refund twice.
 */
export async function cancelJobAndRelease(
  job: { id: string; tenantId: string; videoId: string | null; payload: unknown },
  description: string,
): Promise<boolean> {
  const claimed = await db.job.updateMany({
    where: { id: job.id, status: { in: [...ACTIVE_JOB_STATUSES] } },
    data: { status: 'cancelled' },
  });
  if (claimed.count === 0) return false;
  if (job.videoId) {
    await db.video.update({ where: { id: job.videoId }, data: { status: 'cancelled' } });
  }
  await removeQueuedPipelineJob(job.id);
  try {
    await releaseJobReserve(job.tenantId, job.id, reservedCreditsOf(job.payload), description);
  } catch (err: any) {
    logger.error({ jobId: job.id, err: err.message }, 'Failed to release reserve on cancel');
  }
  return true;
}
