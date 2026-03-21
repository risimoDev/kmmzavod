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
