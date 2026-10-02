import "server-only";

import {
  BookingEventType,
  BookingStatus,
  CreditType,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  type Prisma,
} from "@prisma/client";

import { recordBookingEvent } from "@/lib/booking-events";
import type { BookingPriceRebase } from "@/lib/booking-review-price-rebase";
import { calculateAppliedCreditRestore, daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import type { ClubFormat } from "@/lib/club-format";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import {
  REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE,
} from "@/lib/edit-financial-review-refund-refusals";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { dispatchEditReviewAccountCreditXero } from "@/lib/edit-financial-review-xero-leg";
import { createBookingModificationCredit, giveBackAppliedCredit } from "@/lib/member-credit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";

/**
 * What the account-credit route moved: applied credit given back, and credit
 * minted beside it. Their sum is what the member was credited. `cancelled`
 * says the booking was already cancelled, which decides how Xero hears of it
 * (`dispatchEditReviewAccountCreditXero`).
 */
export type EditReviewAccountCreditOutcome = {
  givenBackCents: number;
  mintedCents: number;
  cancelled: boolean;
};

/**
 * The description every review give-back row carries, and the one way a later
 * review on the same booking finds the give-backs already made (#3791). Built
 * here only, so the writer and its readers cannot drift apart (`INV-SSOT`).
 */
export function reviewShareGiveBackDescription(bookingId: string): string {
  return `Applied credit returned after booking ${bookingId.slice(0, 8)} financial review`;
}

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
 * mechanism. What of the share is applied credit is `creditSliceOfReviewShare`,
 * held on an unpaid booking to what the booking's review re-prices have
 * removed; only the rest is minted, exactly as before.
 *
 * A booking CANCELLED before the review completes has had its applied credit
 * restored by tier already, so the slice is netted against that restore, from
 * figures frozen at the cancellation and across every review settled since
 * (owner decision 2).
 */
export async function writeEditReviewAccountCredit({
  route,
  taskId,
  memberId,
  bookingId,
  amountCents,
  rebase,
  clubZone,
  format,
  store,
}: {
  route: Extract<EditReviewSettlementRoute, { kind: "account-credit" }>;
  /** This review task, already claimed COMPLETED in `store`. */
  taskId: string;
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
    return { givenBackCents: 0, mintedCents: amountCents, cancelled: false };
  }

  let creditSliceCents = 0;
  let cancelled = false;
  const { givenBackCents, payment } = await giveBackAppliedCredit(
    {
      memberId,
      bookingId,
      format,
      description: reviewShareGiveBackDescription(bookingId),
      // Asked under the member's credit-ledger lock and the completion's
      // lock(1). Every writer of what is read here holds one of the two: the
      // cancel and the other reviews hold lock(1), the restore and every credit
      // row a ledger-key holder - so nothing read here can move before the write.
      giveBackCentsOf: async (appliedCreditCents) => {
        const booking = await store.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { status: true, finalPriceCents: true, checkIn: true, lodgeId: true },
        });
        cancelled = booking.status === BookingStatus.CANCELLED;
        if (cancelled) {
          const netted = await creditSliceStillOwedAfterCancellation({
            bookingId,
            taskId,
            booking,
            shareCents: amountCents,
            appliedNowCents: appliedCreditCents,
            clubZone,
            store,
          });
          creditSliceCents = netted.sliceCents;
          return netted.owedCents;
        }
        const previousFinalPriceCents = rebase?.previousFinalPriceCents ?? booking.finalPriceCents;
        const unpaid = appliedCreditCents < previousFinalPriceCents;
        creditSliceCents = creditSliceOfReviewShare({
          shareCents: amountCents,
          appliedCreditCents,
          repricedAwayHeadroomCents: unpaid
            ? await reviewRepriceHeadroomCents({ bookingId, rebase, store })
            : null,
        });
        return creditSliceCents;
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
  return { givenBackCents, mintedCents, cancelled };
}

/**
 * How much of a review share on a booking with no captured payment is the
 * member's applied credit coming back: never more than is applied, and on an
 * UNPAID booking - credit short of the price - never more than the headroom
 * the booking's review re-prices left (`reviewRepriceHeadroomCents`), so a
 * review cannot raise what the member owes (orchestrator decision on #3791).
 * `null` headroom means the booking is fully paid and is not held to it.
 */
export function creditSliceOfReviewShare({
  shareCents,
  appliedCreditCents,
  repricedAwayHeadroomCents,
}: {
  shareCents: number;
  appliedCreditCents: number;
  repricedAwayHeadroomCents: number | null;
}): number {
  const slice = Math.max(0, Math.min(shareCents, appliedCreditCents));
  return repricedAwayHeadroomCents === null ? slice : Math.min(slice, Math.max(0, repricedAwayHeadroomCents));
}

/**
 * The unpaid limit ACROSS THE BOOKING (#3791 M3): what every review re-price on
 * it has taken off the price - the `PRICE_REBASE` rows earlier closures wrote,
 * plus this closure's own, not yet written - less the applied credit reviews
 * have already given back. Two reviews of one edit share one price drop, so
 * the second cannot mint what the first's re-price already gave the member.
 */
async function reviewRepriceHeadroomCents({
  bookingId,
  rebase,
  store,
}: {
  bookingId: string;
  rebase: BookingPriceRebase | null;
  store: Prisma.TransactionClient;
}): Promise<number> {
  const [rebaseRows, givenBack] = await Promise.all([
    store.bookingModification.findMany({
      where: { bookingId, modificationType: "PRICE_REBASE" },
      select: { newData: true },
    }),
    store.memberCredit.aggregate({
      where: reviewGiveBackRowsWhere(bookingId),
      _sum: { amountCents: true },
    }),
  ]);
  const earlierDropCents = rebaseRows.reduce((sum, row) => {
    const data = jsonRecord(row.newData);
    const movement = data && typeof data.financialReviewTaskId === "string" ? data.rebasedPriceMovementCents : null;
    return typeof movement === "number" && Number.isInteger(movement) ? sum - movement : sum;
  }, 0);
  const thisDropCents = rebase ? rebase.previousFinalPriceCents - rebase.newFinalPriceCents : 0;
  return earlierDropCents + thisDropCents - (givenBack._sum.amountCents ?? 0);
}

/** The give-back rows reviews have written on this booking. */
function reviewGiveBackRowsWhere(bookingId: string): Prisma.MemberCreditWhereInput {
  return {
    appliedToBookingId: bookingId,
    type: CreditType.BOOKING_APPLIED,
    amountCents: { gt: 0 },
    description: reviewShareGiveBackDescription(bookingId),
  };
}

/**
 * Owner decision 2 (#3791): the credit slice of a share on a cancelled booking,
 * netted against what the cancellation restored - CUMULATIVELY, so a second
 * review of the same booking neither re-tiers a figure the first lowered nor
 * forgets what the first gave back.
 *
 * Had every slice settled since the cancellation come back first, the member
 * would hold `C + restore(A - C)`, where `C` is those slices with this one and
 * `A` the applied credit the cancellation tiered. They hold the restore `R` and
 * the give-backs `P` already made - `A` less the applied credit now, since the
 * restore leaves the applied rows alone; the difference is owed now. `A` is frozen at
 * the cancellation - its CANCELLED event's ledger figure, else the applied net
 * as the restore row was written - and `restore` is the cancellation's own
 * tier, `calculateAppliedCreditRestore`, on the restore's day, with no card
 * base because this route has nothing captured. That tier must reproduce `R`
 * from `A` before it is trusted with the share; where it does not, or no
 * frozen figure exists, the completion is refused with the task OPEN.
 *
 * Nothing restored means the tier kept everything, and of less too: the slice
 * is owed whole. A restore of everything already returned it: nothing is owed.
 */
async function creditSliceStillOwedAfterCancellation({
  bookingId,
  taskId,
  booking,
  shareCents,
  appliedNowCents,
  clubZone,
  store,
}: {
  bookingId: string;
  taskId: string;
  booking: { checkIn: Date; lodgeId: string };
  shareCents: number;
  appliedNowCents: number;
  clubZone: ClubTimeZone;
  store: Prisma.TransactionClient;
}): Promise<{ sliceCents: number; owedCents: number }> {
  const restore = await store.memberCredit.findUnique({
    where: { restoredFromBookingId: bookingId },
    select: { amountCents: true, createdAt: true },
  });
  const restoredCents = restore?.amountCents ?? 0;
  if (restore === null || restoredCents <= 0) {
    const sliceCents = Math.max(0, Math.min(shareCents, appliedNowCents));
    return { sliceCents, owedCents: sliceCents };
  }

  const appliedAtCancelCents = await frozenAppliedAtCancellationCents({ bookingId, restoredAt: restore.createdAt, store });
  if (appliedAtCancelCents === null || appliedAtCancelCents <= 0) {
    throw new ManualBookingPaymentError(REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, 409);
  }
  const earlierSharesCents = await sharesSettledSinceCents({ bookingId, taskId, since: restore.createdAt, store });
  const earlierSliceCents = Math.min(appliedAtCancelCents, earlierSharesCents);
  const sliceCents = Math.max(0, Math.min(shareCents, appliedAtCancelCents - earlierSliceCents));
  if (restoredCents >= appliedAtCancelCents) return { sliceCents, owedCents: 0 };

  const days = daysUntilDate(booking.checkIn, clubCalendarDateOf(restore.createdAt, clubZone));
  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, store);
  const restoreOf = (appliedCents: number) =>
    calculateAppliedCreditRestore(appliedCents, 0, days, policy).creditRestoredCents;
  if (restoreOf(appliedAtCancelCents) !== restoredCents) {
    throw new ManualBookingPaymentError(REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, 409);
  }
  const slicesCents = earlierSliceCents + sliceCents;
  // What reviews have given back since the cancellation: the restore leaves the
  // applied rows alone, so it is exactly how far they have fallen from `A`.
  const givenBackSinceCents = Math.max(0, appliedAtCancelCents - appliedNowCents);
  const owedCents = slicesCents + restoreOf(appliedAtCancelCents - slicesCents) - restoredCents - givenBackSinceCents;
  return { sliceCents, owedCents: Math.max(0, owedCents) };
}

/**
 * The applied credit the cancellation tiered, as frozen then: the CANCELLED
 * event's `snapshot.ledger.appliedCreditCents` (#3611) where it has one, else
 * the booking's applied rows as they stood when the restore row was written.
 */
async function frozenAppliedAtCancellationCents({
  bookingId,
  restoredAt,
  store,
}: {
  bookingId: string;
  restoredAt: Date;
  store: Prisma.TransactionClient;
}): Promise<number | null> {
  const cancelled = await store.bookingEvent.findFirst({
    where: { bookingId, type: BookingEventType.CANCELLED },
    orderBy: { occurredAt: "desc" },
    select: { snapshot: true },
  });
  const frozen = jsonRecord(jsonRecord(cancelled?.snapshot)?.ledger)?.appliedCreditCents;
  if (typeof frozen === "number" && Number.isInteger(frozen)) return frozen;
  const asRestored = await store.memberCredit.aggregate({
    where: { appliedToBookingId: bookingId, type: CreditType.BOOKING_APPLIED, createdAt: { lte: restoredAt } },
    _sum: { amountCents: true },
  });
  return asRestored._sum.amountCents === null ? null : Math.max(0, -asRestored._sum.amountCents);
}

/**
 * The shares other reviews of this booking have settled back to the member
 * since the restore - the slices `C` already counts. A completion with no
 * payment behind it is this route by construction (`chooseEditReviewSettlementRoute`).
 */
async function sharesSettledSinceCents({
  bookingId,
  taskId,
  since,
  store,
}: {
  bookingId: string;
  taskId: string;
  since: Date;
  store: Prisma.TransactionClient;
}): Promise<number> {
  const earlier = await store.manualRefundTask.aggregate({
    where: {
      bookingId,
      id: { not: taskId },
      kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
      status: ManualRefundTaskStatus.COMPLETED,
      settlementDirection: ManualRefundTaskDirection.REFUND_TO_MEMBER,
      paymentId: null,
      completedAt: { gte: since },
    },
    _sum: { amountCents: true },
  });
  return earlier._sum.amountCents ?? 0;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * #3791: everything an account-credit completion does AFTER its commit. The
 * member-facing `CREDITED` event for what was actually credited - `INV-PAY-051`
 * writes it where the money moved, and none where a share netted against a
 * cancellation's restore left nothing to credit - and the Xero leg
 * (`dispatchEditReviewAccountCreditXero`).
 */
export async function finishEditReviewAccountCredit({
  bookingId,
  taskId,
  actingMemberId,
  bookingModificationId,
  outcome,
  hasIssuedXeroInvoice,
  bookingXeroInvoiceId,
  bookingPaymentStatus,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  bookingModificationId: string;
  outcome: EditReviewAccountCreditOutcome;
  hasIssuedXeroInvoice: boolean;
  bookingXeroInvoiceId: string | null;
  bookingPaymentStatus: string | null;
}): Promise<void> {
  const creditedCents = outcome.givenBackCents + outcome.mintedCents;
  if (creditedCents > 0) {
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.CREDITED,
      actorMemberId: actingMemberId,
      amountCents: creditedCents,
      reason: "edit_financial_review_credited",
    });
  }
  await dispatchEditReviewAccountCreditXero({
    bookingId,
    taskId,
    actingMemberId,
    bookingModificationId,
    givenBackCents: outcome.givenBackCents,
    mintedCents: outcome.mintedCents,
    cancelled: outcome.cancelled,
    hasIssuedXeroInvoice,
    bookingXeroInvoiceId,
    bookingPaymentStatus,
  });
}
