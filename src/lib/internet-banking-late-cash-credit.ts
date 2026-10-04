import type { CreditType, PrismaClient } from "@prisma/client";

const CANCELLATION_REFUND = "CANCELLATION_REFUND" satisfies CreditType;

/**
 * THE MEMBER CREDIT THE INTERNET BANKING PIPELINE MINTS FROM CASH THAT ARRIVED
 * TOO LATE FOR ITS BOOKING (#1357, #1505; the readers' one home since #3827).
 *
 * When a bank transfer reaches Xero for a booking that is already cancelled
 * (`invoice-paid-effects.ts`, the cancelled arm) or that failed capacity (the
 * late-capacity arm), the cash is recorded on the payment and handed straight
 * back to the member as account credit. Neither arm moves the payment's
 * `refundedAmountCents`: the money was never "refunded", it was credited. So
 * the payment still READS as if all of it could be refunded, and anything that
 * sizes a refund from it has to subtract this credit itself.
 *
 * The pipeline marks its rows by type and a fixed description prefix - never
 * by amount - and every reader keys on exactly that, so it never counts an
 * ordinary cancellation's credit. Plain module (no `server-only`, type-only
 * Prisma import): the server aggregate and a screen's predicate share one spelling.
 */
export const INTERNET_BANKING_LATE_CASH_CREDIT_DESCRIPTION_PREFIX =
  "Internet Banking payment credit for ";

/** The rows themselves, as a `MemberCredit` where clause. */
export const INTERNET_BANKING_LATE_CASH_CREDIT_WHERE = {
  type: CANCELLATION_REFUND,
  description: { startsWith: INTERNET_BANKING_LATE_CASH_CREDIT_DESCRIPTION_PREFIX },
} as const;

/**
 * Is this credit row one the pipeline minted from late cash? For a screen that
 * already loaded the booking's cancellation credits (`creditsFromCancellation`)
 * with their description. The type is checked when the read carries it.
 */
export function isInternetBankingLateCashCredit(credit: {
  description: string | null;
  type?: CreditType | string | null;
}): boolean {
  if (credit.type !== undefined && credit.type !== CANCELLATION_REFUND) return false;
  return credit.description?.startsWith(INTERNET_BANKING_LATE_CASH_CREDIT_DESCRIPTION_PREFIX) ?? false;
}

/** The cents those rows hold, from a loaded list (`isInternetBankingLateCashCredit`). */
export function sumInternetBankingLateCashCreditCents(
  credits: readonly { amountCents: number; description: string | null; type?: CreditType | string | null }[] | null | undefined,
): number {
  return (credits ?? []).reduce(
    (sum, credit) => (isInternetBankingLateCashCredit(credit) ? sum + Math.max(0, credit.amountCents) : sum),
    0,
  );
}

/**
 * Sum the credit THIS pipeline has already minted for a set of bookings
 * (#1505). The per-invoice aggregate cap reads it INSIDE the reconcile
 * transaction (after the shared advisory lock), so it sees every credit an
 * earlier payment in the same invoice's loop committed; a refund appeal's cap
 * reads it for one booking (#3827). Keyed on the pipeline's own description
 * prefix and type - never on amount - exactly as the per-booking dedup keys.
 */
export async function sumInternetBankingMintedCentsForBookings(
  db: Pick<PrismaClient, "memberCredit">,
  bookingIds: string[],
): Promise<number> {
  if (bookingIds.length === 0) {
    return 0;
  }
  const aggregate = await db.memberCredit.aggregate({
    where: { sourceBookingId: { in: bookingIds }, ...INTERNET_BANKING_LATE_CASH_CREDIT_WHERE },
    _sum: { amountCents: true },
  });
  return aggregate._sum.amountCents ?? 0;
}
