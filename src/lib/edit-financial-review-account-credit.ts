import "server-only";

import {
  BookingEventType,
  BookingStatus,
  CreditType,
  type Prisma,
} from "@prisma/client";

import { recordBookingEvent } from "@/lib/booking-events";
import { bookingAmountOwedCents, recordedChangeFeeCents } from "@/lib/booking-payment-state";
import type { BookingPriceRebase } from "@/lib/booking-review-price-rebase";
import { daysUntilDate, loadCancellationPolicy } from "@/lib/cancellation";
import type { ClubFormat } from "@/lib/club-format";
import {
  cancellationReturnOf,
  cancellationTierOf,
  capAppliedCreditForReTier,
  capturedShareOwedAfterCancellation,
  frozenAppliedCreditBaseCents,
  frozenCents,
  jsonRecord,
  reviewsSettledAfterCancelWhere,
  shareOwedAfterCancellationCents,
} from "@/lib/edit-financial-review-cancel-netting";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import {
  REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE,
  REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE,
} from "@/lib/edit-financial-review-refund-refusals";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import { dispatchEditReviewAccountCreditXero } from "@/lib/edit-financial-review-xero-leg";
import { createBookingModificationCredit, giveBackAppliedCredit } from "@/lib/member-credit";
import { cancellationCreditRestoreWhere } from "@/lib/member-credit-booking-rows";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";

/**
 * What the account-credit route moved: applied credit given back, and credit
 * minted beside it. Their sum is what the member was credited. `cancelled`
 * says the booking was already cancelled, which decides how Xero hears of it
 * (`dispatchEditReviewAccountCreditXero`). `invoiceReductionCents` is what the
 * booking's issued invoice must come down by (`reviewInvoiceReductionCents`),
 * or null on a captured payment's share: that is minted against the payment,
 * as before #3791, and the invoice is judged by the document rule it always was.
 */
export type EditReviewAccountCreditOutcome = {
  givenBackCents: number;
  mintedCents: number;
  cancelled: boolean;
  invoiceReductionCents: number | null;
  /**
   * On a booking its credit covered, the give-back beyond what the re-price
   * removed: an agreed reduction of the price the ledger records as such
   * (`agreedGiveBackKey`). Null where the share is not one.
   */
  agreedGiveBackCents: number | null;
};

/** The give-back row's human description; nothing reads it back (#3791). */
export function reviewShareGiveBackDescription(bookingId: string): string {
  return `Applied credit returned after booking ${bookingId.slice(0, 8)} financial review`;
}

/**
 * WHAT THE INVOICE MUST COME DOWN BY, so that Xero owes what the app does
 * (#3791, the clamp counterpart's invoice-allocated note). The app owes
 * what `bookingAmountOwedCents` says on an unpaid booking — its price plus the
 * change fee recorded on its payment, less applied credit (`INV-PAY-119`) —
 * and nothing on one its credit covered, where a give-back is an agreed
 * reduction of the price. Before the review Xero owed what the app did; the
 * give-back's deallocation adds `G` to what Xero says is due; the note takes
 * off the rest of the difference: `owedBefore + G - owedAfter`. On an unpaid
 * booking that is the re-price's drop - the whole reduction, not the share -
 * and on a covered one the share. The fee is part of both owed figures: where
 * either is held at zero, a bare price would mis-state the difference
 * (#3955 round 4, finding 4).
 */
export function reviewInvoiceReductionCents({
  unpaid,
  previousFinalPriceCents,
  finalPriceCents,
  recordedChangeFeeCents,
  appliedBeforeCents,
  givenBackCents,
}: {
  /** `bookingIsUnpaid`: credit short of the price for a reason other than a review's give-back. */
  unpaid: boolean;
  previousFinalPriceCents: number;
  finalPriceCents: number;
  /** The change fee the booking's payment records (`recordedChangeFeeCents`). */
  recordedChangeFeeCents: number;
  appliedBeforeCents: number;
  givenBackCents: number;
}): number {
  const owed = (priceCents: number, appliedCreditCents: number) =>
    unpaid
      ? Math.max(
          0,
          bookingAmountOwedCents({ finalPriceCents: priceCents, changeFeeCents: recordedChangeFeeCents, appliedCreditCents }),
        )
      : 0;
  const owedBeforeCents = owed(previousFinalPriceCents, appliedBeforeCents);
  const owedAfterCents = owed(finalPriceCents, appliedBeforeCents - givenBackCents);
  return Math.max(0, owedBeforeCents + givenBackCents - owedAfterCents);
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
    // #3835: on a cancelled booking, only what the cancellation's refund left
    // owed. `cancelled` stays false: Xero hears of this route as it always did.
    const booking = await store.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { status: true, checkIn: true, lodgeId: true },
    });
    // The capture's part is minted against the payment; the credit's part is
    // the member's applied credit given back, never charged to the capture.
    const owed = booking.status === BookingStatus.CANCELLED
      ? await capturedShareOwedAfterCancellation({ bookingId, taskId, booking, shareCents: amountCents, clubZone, store })
      : { captureCents: amountCents, creditCents: 0 };
    // The give-back first: its member credit-ledger lock precedes the Payment
    // row the mint's allocation locks (INV-LOCK-002).
    const givenBackCents = await giveBackCancelledShareCredit({ memberId, bookingId, cents: owed.creditCents, format, store });
    if (owed.captureCents > 0) await mint(owed.captureCents, route.allocateAgainstPaymentId);
    return { givenBackCents, mintedCents: owed.captureCents, cancelled: false, invoiceReductionCents: null, agreedGiveBackCents: null };
  }

  let creditSliceCents = 0;
  let cancelled = false;
  let invoice = {
    unpaid: false,
    previousFinalPriceCents: 0,
    finalPriceCents: 0,
    recordedChangeFeeCents: 0,
    appliedBeforeCents: 0,
  };
  const { givenBackCents, payment } = await giveBackAppliedCredit(
    {
      memberId,
      bookingId,
      format,
      description: reviewShareGiveBackDescription(bookingId),
      sourceBookingId: bookingId,
      // Asked under the member's credit-ledger lock and the completion's
      // lock(1). Every writer of what is read here holds one of the two: the
      // cancel and the other reviews hold lock(1), the restore and every credit
      // row a ledger-key holder - so nothing read here can move before the write.
      giveBackCentsOf: async (appliedCreditCents) => {
        const booking = await store.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: {
            status: true,
            finalPriceCents: true,
            checkIn: true,
            lodgeId: true,
            payment: { select: { changeFeeCents: true } },
          },
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
        // UNPAID: the credit falls short of the price for a reason other than a
        // review's give-back - an agreed share on a covered booking lowers the
        // applied figure without leaving anything owed (#3791, second round).
        const reviewGiveBacksCents = await reviewGiveBacksMadeCents(bookingId, store);
        const unpaid = appliedCreditCents + reviewGiveBacksCents < previousFinalPriceCents;
        invoice = {
          unpaid,
          previousFinalPriceCents,
          finalPriceCents: booking.finalPriceCents,
          recordedChangeFeeCents: recordedChangeFeeCents(booking.payment),
          appliedBeforeCents: appliedCreditCents,
        };
        creditSliceCents = creditSliceOfReviewShare({
          shareCents: amountCents,
          appliedCreditCents,
          repricedAwayHeadroomCents: unpaid
            ? await reviewRepriceHeadroomCents({ bookingId, rebase, reviewGiveBacksCents, store })
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
  // A cancelled booking's invoice stands as the cancellation left it.
  const invoiceReductionCents = cancelled ? 0 : reviewInvoiceReductionCents({ ...invoice, givenBackCents });
  const repricedAwayCents = rebase ? rebase.previousFinalPriceCents - rebase.newFinalPriceCents : 0;
  return {
    givenBackCents,
    mintedCents,
    cancelled,
    invoiceReductionCents,
    agreedGiveBackCents:
      !cancelled && !invoice.unpaid && givenBackCents > 0 ? Math.max(0, invoiceReductionCents - repricedAwayCents) : null,
  };
}

/**
 * #3835: the applied-credit part of a captured payment's share on a cancelled
 * booking, given back through `giveBackAppliedCredit` - the clamp's and #3791's
 * one mechanism, under the member's credit-ledger lock after the completion's
 * `lock(1)` - so it is never asked of the capture. Returns what was given back.
 */
export async function giveBackCancelledShareCredit({
  memberId,
  bookingId,
  cents,
  format,
  store,
}: {
  memberId: string;
  bookingId: string;
  cents: number;
  format: ClubFormat;
  store: Prisma.TransactionClient;
}): Promise<number> {
  if (cents <= 0) return 0;
  const { givenBackCents, payment } = await giveBackAppliedCredit(
    { memberId, bookingId, format, description: reviewShareGiveBackDescription(bookingId), sourceBookingId: bookingId, giveBackCentsOf: () => cents },
    store,
  );
  // The netting gave back no more than the rows hold; short of it, the figures
  // moved under it, so the completion is refused with the task OPEN.
  if (givenBackCents !== cents) throw new ManualBookingPaymentError(REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE, 409);
  if (payment) {
    await store.payment.update({
      where: { id: payment.id },
      data: { creditAppliedCents: Math.max(0, payment.creditAppliedCents - givenBackCents) },
    });
  }
  return givenBackCents;
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
  reviewGiveBacksCents,
  store,
}: {
  bookingId: string;
  rebase: BookingPriceRebase | null;
  reviewGiveBacksCents: number;
  store: Prisma.TransactionClient;
}): Promise<number> {
  const rebaseRows = await store.bookingModification.findMany({
    where: { bookingId, modificationType: "PRICE_REBASE" },
    select: { newData: true },
  });
  const earlierDropCents = rebaseRows.reduce((sum, row) => {
    const data = jsonRecord(row.newData);
    const movement = data && typeof data.financialReviewTaskId === "string" ? data.rebasedPriceMovementCents : null;
    return typeof movement === "number" && Number.isInteger(movement) ? sum - movement : sum;
  }, 0);
  const thisDropCents = rebase ? rebase.previousFinalPriceCents - rebase.newFinalPriceCents : 0;
  return earlierDropCents + thisDropCents - reviewGiveBacksCents;
}

/** What reviews of this booking have given back so far (`reviewGiveBackRowsWhere`). */
async function reviewGiveBacksMadeCents(bookingId: string, store: Prisma.TransactionClient): Promise<number> {
  const givenBack = await store.memberCredit.aggregate({ where: reviewGiveBackRowsWhere(bookingId), _sum: { amountCents: true } });
  return givenBack._sum.amountCents ?? 0;
}

/**
 * The give-back rows reviews have written on this booking, found by STRUCTURE
 * (#3791): a `BOOKING_APPLIED` row naming the booking as its source as well as
 * where it applies. No other writer of an applied row sets `sourceBookingId`,
 * and a Xero repair that stamps a note or rewrites the description of a linked
 * row leaves it alone.
 */
function reviewGiveBackRowsWhere(bookingId: string): Prisma.MemberCreditWhereInput {
  return {
    appliedToBookingId: bookingId,
    sourceBookingId: bookingId,
    type: CreditType.BOOKING_APPLIED,
    amountCents: { gt: 0 },
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
  // The one restore test (`isCancellationCreditRestoreRow`), as a query: a
  // restore written before 8 Jul 2026 (#1636) carries no marker and must still
  // be netted, or its slice would be handed back a second time. Before the
  // marker's unique key a cancellation could restore twice; which of two rows
  // the tier wrote cannot be told, so two refuse with the task left OPEN.
  const restores = await store.memberCredit.findMany({
    where: cancellationCreditRestoreWhere(bookingId),
    select: { amountCents: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (restores.length > 1) {
    throw new ManualBookingPaymentError(REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, 409);
  }
  const restore = restores[0] ?? null;
  const restoredCents = restore?.amountCents ?? 0;
  if (restore === null || restoredCents <= 0) {
    const sliceCents = Math.max(0, Math.min(shareCents, appliedNowCents));
    return { sliceCents, owedCents: sliceCents };
  }

  const frozen = await frozenAppliedAtCancellationCents({ bookingId, restoredAt: restore.createdAt, store });
  if (frozen === null || frozen.rowsCents <= 0) {
    throw new ManualBookingPaymentError(REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, 409);
  }
  // `A` is the applied rows; the cancel tiered `tieredCents` of them, the rest
  // above #3809's cap left untiered (`INV-PAY-115`), so a share takes that first.
  const earlierSharesCents = await sharesSettledSinceCents({ bookingId, taskId, snapshot: frozen.snapshot, since: restore.createdAt, store });
  const earlierSliceCents = Math.min(frozen.rowsCents, earlierSharesCents);
  const sliceCents = Math.max(0, Math.min(shareCents, frozen.rowsCents - earlierSliceCents));

  // A restore of everything tiered returns all of less too: no policy needed.
  let returnOf = (_baseCents: number, appliedCents: number) => appliedCents;
  if (restoredCents < frozen.tieredCents) {
    const days = daysUntilDate(booking.checkIn, clubCalendarDateOf(restore.createdAt, clubZone));
    const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, store);
    const refusal = () => new ManualBookingPaymentError(REVIEW_CANCELLATION_RESTORE_UNREPRODUCIBLE_MESSAGE, 409);
    const capAppliedCredit = await capAppliedCreditForReTier({ bookingId, snapshot: frozen.snapshot, refusal }, store);
    if (cancellationTierOf(days, policy, "card", capAppliedCredit)(0, frozen.tieredCents).creditCents !== restoredCents) throw refusal();
    returnOf = cancellationReturnOf(days, policy, "card", capAppliedCredit);
  }
  // What reviews have given back since the cancellation: the restore leaves the
  // applied rows alone, so it is exactly how far they have fallen from `A`.
  const owedCents = shareOwedAfterCancellationCents({
    sharesCents: earlierSliceCents + sliceCents,
    cardBaseCents: 0,
    untieredCreditCents: Math.max(0, frozen.rowsCents - frozen.tieredCents),
    appliedCents: frozen.tieredCents,
    returnedByCancellationCents: restoredCents,
    returnedSinceCents: Math.max(0, frozen.rowsCents - appliedNowCents),
    returnOf,
  });
  return { sliceCents, owedCents };
}

/**
 * The applied credit the cancellation tiered, as frozen then: the CANCELLED
 * event's `snapshot.ledger.appliedCreditCents` (#3611) where it has one, else
 * the booking's applied rows as they stood when the restore row was written.
 * With it, the cap the cancellation's tier was applied under (#3809), or no
 * cap where the event froze none: such a cancellation tiered all of it.
 */
async function frozenAppliedAtCancellationCents({
  bookingId,
  restoredAt,
  store,
}: {
  bookingId: string;
  restoredAt: Date;
  store: Prisma.TransactionClient;
}): Promise<{ rowsCents: number; tieredCents: number; snapshot: Record<string, unknown> | null } | null> {
  const cancelled = await store.bookingEvent.findFirst({
    where: { bookingId, type: BookingEventType.CANCELLED },
    orderBy: { occurredAt: "desc" },
    select: { snapshot: true },
  });
  const snapshot = jsonRecord(cancelled?.snapshot);
  const rowsCents = frozenCents(jsonRecord(snapshot?.ledger), "appliedCreditCents");
  if (rowsCents !== null) return { rowsCents, tieredCents: frozenAppliedCreditBaseCents(snapshot) ?? rowsCents, snapshot };
  const asRestored = await store.memberCredit.aggregate({
    where: { appliedToBookingId: bookingId, type: CreditType.BOOKING_APPLIED, createdAt: { lte: restoredAt } },
    _sum: { amountCents: true },
  });
  if (asRestored._sum.amountCents === null) return null;
  const asRestoredCents = Math.max(0, -asRestored._sum.amountCents);
  return { rowsCents: asRestoredCents, tieredCents: asRestoredCents, snapshot };
}

/**
 * The shares other reviews of this booking have settled back to the member
 * since the cancellation - the slices `C` already counts - by the one rule the
 * captured routes use (`reviewsSettledAfterCancelWhere`), from the restore's
 * time where the event froze no ids. A completion with no payment behind it is
 * this route by construction (`chooseEditReviewSettlementRoute`).
 */
async function sharesSettledSinceCents({
  bookingId,
  taskId,
  snapshot,
  since,
  store,
}: {
  bookingId: string;
  taskId: string;
  snapshot: Record<string, unknown> | null;
  since: Date;
  store: Prisma.TransactionClient;
}): Promise<number> {
  const earlier = await store.manualRefundTask.aggregate({
    where: { ...reviewsSettledAfterCancelWhere({ bookingId, taskId, snapshot, since }), paymentId: null },
    _sum: { amountCents: true },
  });
  return earlier._sum.amountCents ?? 0;
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
    invoiceReductionCents: outcome.invoiceReductionCents,
    mintedCents: outcome.mintedCents,
    cancelled: outcome.cancelled,
    hasIssuedXeroInvoice,
    bookingXeroInvoiceId,
    bookingPaymentStatus,
  });
}
