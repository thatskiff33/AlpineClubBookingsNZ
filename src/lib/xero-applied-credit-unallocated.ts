import { CreditType, type Prisma } from "@prisma/client";

import type { prisma } from "@/lib/prisma";

/**
 * THE ONE FIGURE for the applied account credit a booking's invoice still has
 * to have allocated against it: its `BOOKING_APPLIED` ledger rows no credit
 * note has been stamped on yet. The allocation engine
 * (`allocateAppliedCreditForBooking`) allocates exactly this, and the primary
 * invoice's Stripe cash is capped by it so that allocation always fits
 * (`cardSettleAppliedCreditCents`, #3955 round 5, finding 2). Reading the
 * payment's `creditAppliedCents` mirror instead would let the two part.
 */
export async function unallocatedAppliedCents(
  bookingId: string,
  db: Prisma.TransactionClient | typeof prisma,
): Promise<number> {
  const agg = await db.memberCredit.aggregate({
    where: {
      appliedToBookingId: bookingId,
      type: CreditType.BOOKING_APPLIED,
      xeroCreditNoteId: null,
    },
    _sum: { amountCents: true },
  });
  return Math.max(0, -(agg._sum.amountCents ?? 0));
}
