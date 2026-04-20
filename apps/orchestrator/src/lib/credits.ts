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
  if (params.reservedCredits <= 0) {
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: params.tenantId },
      select: { credits: true },
    });
    return t.credits;
  }

  return db.$transaction(async (tx) => {
    // Release the full reserve — workers already charged actual costs
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
        description:  `Settle: releasing ${params.reservedCredits} reserve (actual charged by workers: ${params.actualCredits})`,
        jobId:        params.jobId,
      },
    });
    return updated.credits;
  });
}

/**
 * Refund reserved credits when a job fails.
 *
 * Workers already charged actual costs via chargeCredits(), so the full
 * reserve must be returned. The net deduction equals only what workers
 * actually charged (tracked in Job.creditsUsed for audit).
 */
export async function refundReserve(
  db: PrismaClient,
  params: { tenantId: string; jobId: string; reservedCredits: number },
): Promise<number> {
  if (params.reservedCredits <= 0) {
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: params.tenantId },
      select: { credits: true },
    });
    return t.credits;
  }

  return db.$transaction(async (tx) => {
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
        description:  `Refund: pipeline failed, releasing ${params.reservedCredits} reserve`,
        jobId:        params.jobId,
      },
    });
    return updated.credits;
  });
}
