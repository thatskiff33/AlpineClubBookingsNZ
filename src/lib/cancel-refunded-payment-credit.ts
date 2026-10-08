import type { Prisma } from "@prisma/client";

import { bookingReducedThroughCreditGiveBack } from "@/lib/booking-credit-give-back-marker";
import { cancelAppliedCreditBaseCents, cancelTieredAppliedCreditCents } from "@/lib/booking-payment-state";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import { calculateAppliedCreditRestore, daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import type { CalendarDate } from "@/lib/club-time";

/** The tiered restore of a captured-but-refunded booking's applied credit, and the figures its ledger and event freeze. */
export type RefundedPaymentCreditRestore = {
  appliedCreditBaseCents: number;
  creditToRestoreCents: number;
};

/**
 * #3809 (review F2): A CAPTURED PAYMENT THE CANCEL CANNOT REFUND STILL HAS ITS
 * CREDIT TIERED. When a reduction refunded the whole card (or the mirror was
 * flattened), the payment is not one the paid path can claim, so the cancel
 * takes the branch built for bookings that never paid - which restored all the
 * credit still applied, untiered. A booking paid by card and credit could then
 * get back more than an all-card one: $100 card and $100 credit on $200, $150
 * removed at 100% ($100 to the card, $50 of credit back), then a cancel at 0%
 * restored the last $50 - $200 against $150.
 *
 * Where money WAS captured (`paymentHasCaptureEvidence`, the caller's test) the
 * credit is tiered as the paid path tiers it: the card tier, no card slice,
 * on `cancelAppliedCreditBaseCents`, capped at what the booking is worth - but
 * ONLY where the booking was reduced through #3809's settlement (`INV-PAY-115`,
 * owner decision of 4 Oct 2026, "Cap new reductions only"). A booking reduced
 * before that release keeps main's full restore: tiering it could leave the
 * member short (its earlier reduction gave no credit back), and the decision
 * says such a booking is never short. A never-captured booking does not come
 * here and keeps its full restore too. Null in every case that keeps it.
 *
 * Inside the cancel's claim, under `lock(1)` and the member key; reads only.
 */
export async function refundedPaymentCreditRestore(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    booking,
    openNonCancellationHandBackCents,
    todayAtClub,
  }: {
    bookingId: string;
    booking: {
      checkIn: Date;
      lodgeId: string | null;
      finalPriceCents: number;
      payment: { amountCents: number; refundedAmountCents: number; changeFeeCents: number; creditAppliedCents: number };
    };
    /**
     * The payment's open edit / refund-request hand-backs (#3827, `INV-PAY-117`),
     * which the cap counts as paid no more than the paid path does.
     */
    openNonCancellationHandBackCents: number;
    /** The club's day, resolved before the transaction (`INV-LOCK-004`): the tier boundary. */
    todayAtClub: CalendarDate;
  },
): Promise<RefundedPaymentCreditRestore | null> {
  // #3836: a mirror the old inbound sync clipped to the card amount reads the ledger.
  const creditAppliedCents = cancelTieredAppliedCreditCents(booking.payment, await deriveBookingAppliedCreditCents(bookingId, tx));
  if (creditAppliedCents <= 0) return null;
  if (!(await bookingReducedThroughCreditGiveBack(bookingId, tx))) return null;
  const appliedCreditBaseCents = cancelAppliedCreditBaseCents({
    ...booking.payment,
    creditAppliedCents,
    openNonCancellationHandBackCents,
    finalPriceCents: booking.finalPriceCents,
    capAtWorth: true,
  });
  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, tx);
  const { creditRestoredCents } = calculateAppliedCreditRestore(
    appliedCreditBaseCents,
    0,
    daysUntilDate(booking.checkIn, todayAtClub),
    policy,
  );
  return { appliedCreditBaseCents, creditToRestoreCents: creditRestoredCents };
}
