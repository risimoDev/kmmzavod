/**
 * Atomic credit deduction.
 *
 * Decrements Tenant.credits and appends a CreditTransaction row in a single
 * Prisma interactive transaction, so the balance can never go out of sync.
 */
import type { PrismaClient } from '@kmmzavod/db';

interface ChargeParams {
  tenantId:    string;
  jobId:       string;
  credits:     number;   // positive integer — amount to deduct
  description: string;
}

/**
 * Deducts `credits` from the tenant's balance and records the transaction.
 * Returns the new balance.  The balance is floored at 0 in the transaction log
 * even if the account goes negative (handled at API layer with guards).
 */
export async function chargeCredits(
  db: PrismaClient,
  params: ChargeParams,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const updated = await tx.tenant.update({
      where: { id: params.tenantId },
      data:  { credits: { decrement: params.credits } },
      select: { credits: true },
    });

    await tx.creditTransaction.create({
      data: {
        tenantId:     params.tenantId,
        type:         'charge',
        amount:       -params.credits,
        balanceAfter: Math.max(0, updated.credits),
        description:  params.description,
        jobId:        params.jobId,
      },
    });

    return updated.credits;
  });
}

// ── Soft-reserve credit utilities ─────────────────────────────────────

interface SettleParams {
  tenantId: string;
  jobId:    string;
  reservedCredits: number; // positive — originally reserved
  actualCredits:   number; // positive — actually spent by workers
}

/**
 * Releases a job's soft reserve back to the tenant — at most once per job.
 *
 * Several paths can try to release the same reserve: settlement on success, the
 * pipeline-state worker when all scenes fail, and BullMQ `failed` handlers (one per
 * failed scene). Without a guard each of them would credit the tenant again.
 * The job row is locked (SELECT … FOR UPDATE) so concurrent releases serialize, and a
 * release is skipped when a `refund` transaction for this job already exists.
 */
async function releaseReserveOnce(
  db: PrismaClient,
  params: { tenantId: string; jobId: string; reservedCredits: number },
  description: string,
): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${params.jobId}::uuid FOR UPDATE`;

    const already = await tx.creditTransaction.findFirst({
      where: { jobId: params.jobId, type: 'refund' },
      select: { id: true },
    });
    if (already) {
      const t = await tx.tenant.findUniqueOrThrow({
        where: { id: params.tenantId },
        select: { credits: true },
      });
      return t.credits;
    }

    const updated = await tx.tenant.update({
      where: { id: params.tenantId },
      data:  { credits: { increment: params.reservedCredits } },
      select: { credits: true },
    });
    await tx.creditTransaction.create({
      data: {
        tenantId:     params.tenantId,
        type:         'refund',
        amount:       params.reservedCredits,
        balanceAfter: updated.credits,
        description,
        jobId:        params.jobId,
      },
    });
    return updated.credits;
  });
}

async function currentBalance(db: PrismaClient, tenantId: string): Promise<number> {
  const t = await db.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { credits: true },
  });
  return t.credits;
}

/**
 * Settles a previously reserved credit amount after workers have directly
 * charged their actual costs via chargeCredits().
 *
 * Credit flow:
 *   1. API reserves N credits (Tenant.credits -= N)
 *   2. Workers call chargeCredits() for actual cost (Tenant.credits -= actual)
 *   3. Settlement releases the FULL reserve (Tenant.credits += N)
 *
 * Net result: tenant only loses the actual amount charged by workers.
 * The `actualCredits` (Job.creditsUsed) is recorded for audit purposes only.
 */
export async function settleCredits(
  db: PrismaClient,
  params: SettleParams,
): Promise<number> {
  if (params.reservedCredits <= 0) return currentBalance(db, params.tenantId);
  return releaseReserveOnce(
    db,
    params,
    `Settle: releasing ${params.reservedCredits} reserve (actual charged by workers: ${params.actualCredits})`,
  );
}

/**
 * Refund reserved credits when a job fails.
 *
 * Workers already charged actual costs via chargeCredits(), so the full
 * reserve must be returned. The net deduction equals only what workers
 * actually charged (tracked in Job.creditsUsed for audit).
 * Safe to call repeatedly: only the first call per job releases the reserve.
 */
export async function refundReserve(
  db: PrismaClient,
  params: { tenantId: string; jobId: string; reservedCredits: number },
): Promise<number> {
  if (params.reservedCredits <= 0) return currentBalance(db, params.tenantId);
  return releaseReserveOnce(
    db,
    params,
    `Refund: pipeline failed, releasing ${params.reservedCredits} reserve`,
  );
}
