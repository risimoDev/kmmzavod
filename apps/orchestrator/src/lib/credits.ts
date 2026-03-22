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
 * Settles a previously reserved credit amount against actually spent credits.
 *
 * - If actual < reserved → refund the difference.
 * - If actual > reserved → charge the extra (best-effort, balance may go negative).
 * - If actual === reserved → no-op.
 */
export async function settleCredits(
  db: PrismaClient,
  params: SettleParams,
): Promise<number> {
  const diff = params.reservedCredits - params.actualCredits;
  if (diff === 0) {
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: params.tenantId },
      select: { credits: true },
    });
    return t.credits;
  }

  return db.$transaction(async (tx) => {
    if (diff > 0) {
      // Refund overpayment
      const updated = await tx.tenant.update({
        where: { id: params.tenantId },
        data:  { credits: { increment: diff } },
        select: { credits: true },
      });
      await tx.creditTransaction.create({
        data: {
          tenantId:     params.tenantId,
          type:         'refund',
          amount:       diff,
          balanceAfter: updated.credits,
          description:  `Settle: refund ${diff} unused credits`,
          jobId:        params.jobId,
        },
      });
      return updated.credits;
    } else {
      // Charge the extra
      const extra = -diff;
      const updated = await tx.tenant.update({
        where: { id: params.tenantId },
        data:  { credits: { decrement: extra } },
        select: { credits: true },
      });
      await tx.creditTransaction.create({
        data: {
          tenantId:     params.tenantId,
          type:         'charge',
          amount:       -extra,
          balanceAfter: Math.max(0, updated.credits),
          description:  `Settle: additional ${extra} credits charged`,
          jobId:        params.jobId,
        },
      });
      return updated.credits;
    }
  });
}

/**
 * Full refund of reserved credits when a job fails before spending anything.
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
        description:  `Refund: pipeline failed, returning ${params.reservedCredits} reserved credits`,
        jobId:        params.jobId,
      },
    });
    return updated.credits;
  });
}
