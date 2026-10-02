import "server-only";

import { BookingStatus, type Prisma } from "@prisma/client";

import type { BookingPriceRebase } from "@/lib/booking-review-price-rebase";
import { calculateAppliedCreditRestore, daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import type { ClubFormat } from "@/lib/club-format";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import { REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { createBookingModificationCredit, giveBackAppliedCredit } from "@/lib/member-credit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";

/**
 * What the account-credit route moved: applied credit given back, and credit
 * minted beside it. Their sum is what the member was credited, and only the
 * minted part takes the review's Xero credit note (owner decision 1, #3791).
 */
export type EditReviewAccountCreditOutcome = { givenBackCents: number; mintedCents: number };

/**
 * #3032/#3791: the account-credit route's write, inside the caller's
 * transaction, after its status claim (which makes it run once) and after the
 * closure's re-price, whose figures it reads.
 *
 * WITH a captured payment: one `BOOKING_MODIFICATION_REFUND` credit on the
 * edit's anchor, allocated against that payment - unchanged.
 *
 * WITHOUT one the booking was paid by account credit, so the share is that
 * credit coming back, through `giveBackAppliedCredit` - the clamp's own
 * mechanism, Xero deallocation included. Minting it instead left the applied
 * figure whole and a later cancellation paid the share a second time. What of
 * the share is applied credit is `creditSliceOfReviewShare`; only the rest is
 * minted, exactly as before.
 *
 * A booking CANCELLED before the review completes has had its applied credit
 * restored by tier already, so the slice is netted against that restore and
 * only what is still owed is given back (owner decision 2).
 */
export async function writeEditReviewAccountCredit({
  route,
  memberId,
  bookingId,
  amountCents,
  rebase,
  clubZone,
  format,
  store,
}: {
  route: Extract<EditReviewSettlementRoute, { kind: "account-credit" }>;
  memberId: string;
  bookingId: string;
  amountCents: number;
  /** What this closure's re-price did, or null where it declined. */
  rebase: BookingPriceRebase | null;
  /** The club's zone, resolved before the transaction (`INV-LOCK-004`). */
  clubZone: ClubTimeZone;
  format: ClubFormat;
  store: Prisma.TransactionClient;
}): Promise<EditReviewAccountCreditOutcome> {
  // The canonical account-credit writer, re-entered unchanged. Its exactly-once
  // key is the `BookingModification` id (D-3032-1), and it writes the refund
  // allocation itself when handed a payment id.
  const mint = (cents: number, paymentId?: string) =>
    createBookingModificationCredit(memberId, cents, bookingId, route.bookingModificationId, undefined, store, paymentId);
  if (route.allocateAgainstPaymentId !== null) {
    await mint(amountCents, route.allocateAgainstPaymentId);
    return { givenBackCents: 0, mintedCents: amountCents };
  }

  let creditSliceCents = 0;
  const { givenBackCents, payment } = await giveBackAppliedCredit(
    {
      memberId,
      bookingId,
      format,
      description: `Applied credit returned after booking ${bookingId.slice(0, 8)} financial review`,
      // Asked under the member's credit-ledger lock (and the completion's
      // lock(1), which every cancel takes too), so the booking's status, its
      // restore and the mirror read here cannot move before the write.
      giveBackCentsOf: async (appliedCreditCents, lockedPayment) => {
        const booking = await store.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { status: true, finalPriceCents: true, checkIn: true, lodgeId: true },
        });
        const cancelled = booking.status === BookingStatus.CANCELLED;
        creditSliceCents = creditSliceOfReviewShare({
          shareCents: amountCents,
          appliedCreditCents,
          previousFinalPriceCents: rebase?.previousFinalPriceCents ?? booking.finalPriceCents,
          repricedAwayCents: rebase ? rebase.previousFinalPriceCents - rebase.newFinalPriceCents : 0,
          cancelled,
        });
        if (!cancelled) return creditSliceCents;
        return creditSliceStillOwedAfterCancellation({
          bookingId,
          booking,
          creditSliceCents,
          // The figure the cancellation tiered: the mirror, as `booking-cancel.ts` does.
          appliedAtCancelCents: lockedPayment?.creditAppliedCents ?? appliedCreditCents,
          clubZone,
          store,
        });
      },
    },
    store,
  );
  // The mirror a later cancellation tiers off comes down with the rows.
  if (givenBackCents > 0 && payment) {
    await store.payment.update({
      where: { id: payment.id },
      data: { creditAppliedCents: Math.max(0, payment.creditAppliedCents - givenBackCents) },
    });
  }
  const mintedCents = amountCents - creditSliceCents;
  if (mintedCents > 0) await mint(mintedCents);
  return { givenBackCents, mintedCents };
}

/**
 * How much of a review share on a booking with no captured payment is the
 * member's applied credit coming back: never more than is applied. On an UNPAID
 * booking - credit short of the price it was applied against - never more than
 * the closure's re-price took off the price either, so a review that does not
 * re-price cannot raise what the member owes (orchestrator decision on #3791).
 * A cancelled booking owes nothing, so that limit does not apply to it.
 */
export function creditSliceOfReviewShare({
  shareCents,
  appliedCreditCents,
  previousFinalPriceCents,
  repricedAwayCents,
  cancelled,
}: {
  shareCents: number;
  appliedCreditCents: number;
  previousFinalPriceCents: number;
  repricedAwayCents: number;
  cancelled: boolean;
}): number {
  const slice = Math.max(0, Math.min(shareCents, appliedCreditCents));
  const unpaid = !cancelled && appliedCreditCents < previousFinalPriceCents;
  return unpaid ? Math.min(slice, Math.max(0, repricedAwayCents)) : slice;
}

/**
 * Owner decision 2 (#3791): the credit slice of a share, netted against what the
 * cancellation already restored. Had the share come back first, the member
 * would hold `slice + restore(applied - slice)`; they hold `restored`; the
 * difference is still owed. `restore` is the cancellation's own tier,
 * `calculateAppliedCreditRestore`, on the day it ran and the policy in force -
 * with no card base, because this route has nothing captured.
 *
 * Nothing restored means the tier kept everything, and it keeps everything of
 * less too, so the whole slice is owed. A restore in full already returned the
 * slice inside it, so nothing is. Otherwise the tier must reproduce the restore
 * actually made before it is trusted with the share; where it does not, the
 * completion is refused with the task still OPEN.
 */
async function creditSliceStillOwedAfterCancellation({
  bookingId,
  booking,
  creditSliceCents,
  appliedAtCancelCents,
  clubZone,
  store,
}: {
  bookingId: string;
  booking: { checkIn: Date; lodgeId: string };
  creditSliceCents: number;
  appliedAtCancelCents: number;
  clubZone: ClubTimeZone;
  store: Prisma.TransactionClient;
}): Promise<number> {
  if (creditSliceCents <= 0) return 0;
  const restore = await store.memberCredit.findUnique({
    where: { restoredFromBookingId: bookingId },
    select: { amountCents: true, createdAt: true },
  });
  const restoredCents = restore?.amountCents ?? 0;
  if (restore === null || restoredCents <= 0) return creditSliceCents;
  if (restoredCents >= appliedAtCancelCents) return 0;

  const days = daysUntilDate(booking.checkIn, clubCalendarDateOf(restore.createdAt, clubZone));
  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, store);
  const restoreOf = (appliedCents: number) =>
    calculateAppliedCreditRestore(appliedCents, 0, days, policy).creditRestoredCents;
  if (restoreOf(appliedAtCancelCents) !== restoredCents) {
    throw new ManualBookingPaymentError(REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, 409);
  }
  return Math.max(0, creditSliceCents + restoreOf(appliedAtCancelCents - creditSliceCents) - restoredCents);
}
