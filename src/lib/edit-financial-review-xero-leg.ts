import "server-only";

import {
  recordShortEditReviewChargeInvoice,
  restateEditReviewChargeSupplementaryInvoice,
} from "@/lib/edit-financial-review-charge-request";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import logger from "@/lib/logger";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";

/**
 * #3170 (epic #2797): THE XERO LEG OF A COMPLETED EDIT FINANCIAL REVIEW, and
 * everything that follows from the ask it produces.
 *
 * Lifted out of `edit-financial-review-settlement.ts` in the #3170 fix round.
 * The seam is worth having on its own merits and not only for the file-size
 * ratchet: this is where the officer's DIRECTION becomes a signed number, where
 * "restate the invoice this edit already has" is chosen over "queue a second
 * one", and where a share the accounting ask could not take becomes a durable
 * record. Those three are one decision about one edit's one invoice, and the
 * settlement module around them is about money MOVING - a refund issued, a
 * credit written, an intent raised. Keeping them together is what stops the
 * next reader treating the dispatch as fire-and-forget plumbing, which is
 * exactly what let its answer be discarded.
 */

/**
 * WILL THIS CLOSURE SEND XERO A DOCUMENT? The one home for that question
 * (`INV-SSOT-001`), owned by the module that acts on the answer.
 *
 * Two callers need it and they need it for opposite reasons. This module gates
 * its own dispatch on it. #3219's re-price asks it the other way round - a
 * closure that issues NO document is exactly the one that leaves the club's
 * invoice saying one figure while the booking now says another, so the answer
 * decides whether the booking's history warns a treasurer and whether the audit
 * entry is `critical`.
 *
 * It is deliberately NOT `route !== null`. `local-allocation` carries a NULLABLE
 * anchor, and a zero amount dispatches nothing either - so the looser test
 * returns true for a closure that sends Xero nothing at all, which is the unsafe
 * direction: the warning the re-price exists to raise would stay silent while
 * this module logged that the invoice must be corrected by hand.
 */
export function editReviewXeroDocumentAsk({
  route,
  xeroAmountCents,
}: {
  route: Pick<EditReviewSettlementRoute, "bookingModificationId"> | null;
  /**
   * The amount the dispatch would bill - this task's share on a refund, the
   * edit's combined total on a charge. A caller inside the completion
   * transaction does not yet know a charge's combined total, and passing the
   * share instead is safe in the one direction that matters: the total includes
   * the share, so a non-zero share can never make a zero dispatch look real.
   */
  xeroAmountCents: number | null;
}): { bookingModificationId: string; amountCents: number } | null {
  const bookingModificationId = route?.bookingModificationId ?? null;
  if (!bookingModificationId || !xeroAmountCents) return null;
  return { bookingModificationId, amountCents: xeroAmountCents };
}

/** The same answer as a yes/no, derived from it rather than restated. */
export function editReviewSettlementIssuesXeroDocument(
  input: Parameters<typeof editReviewXeroDocumentAsk>[0],
): boolean {
  return editReviewXeroDocumentAsk(input) !== null;
}

export async function dispatchEditReviewXeroSettlement({
  bookingId,
  taskId,
  actingMemberId,
  route,
  amountCents,
  chargeTotalCents,
  hasIssuedXeroInvoice,
  bookingPaymentStatus,
  additionalPaymentIntentId,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  route: EditReviewSettlementRoute | null;
  /** This task's own share, which is what a REFUND bills. */
  amountCents: number | null;
  /**
   * The edit's combined total, which is what a CHARGE bills. Null on every route
   * that is not a charge, so the two can never be confused for one another.
   */
  chargeTotalCents: number | null;
  hasIssuedXeroInvoice: boolean;
  bookingPaymentStatus: string | null;
  additionalPaymentIntentId: string | null;
}): Promise<void> {
  /**
   * Every edit-time settlement in this repository computes an
   * `xeroRefundAmountCents` and dispatches it; a completion that moved money on
   * all three routes and dispatched nothing would leave a booking with an issued
   * invoice showing a total the club no longer holds - and unlike a local ledger
   * slip, nothing later reconciles it. Routed through the SAME choke point the
   * three booking-edit services use, so the credit-note shape, the outbox
   * idempotency (an active `MODIFICATION_CREDIT_NOTE` link on the anchor, plus a
   * correlation key) and the connected-instance kick are the existing ones rather
   * than a second dispatch.
   *
   * The anchor is null for a DISMISSED task (no route) and for every pre-#3032
   * task kind: those are raised for cancelled cash-settled bookings whose Xero
   * side the cancellation path already handled, so a credit note here would be a
   * second, contradictory correction of the same money.
   *
   * Best-effort and after the commit, matching every other caller: a Xero outage
   * must not undo a completion whose money has already moved.
   */
  const isCharge = route?.kind === "additional-charge";
  // Captured outside the dispatch closure: `isCharge` is a boolean and does not
  // narrow `route` inside a `.then`.
  const chargeMemberId =
    route?.kind === "additional-charge" ? (route.member?.id ?? null) : null;

  // The gate and #3219's divergence flag are ONE derivation, called here rather
  // than restated, so a change to what dispatches can never leave the treasurer
  // warning behind.
  //
  // #3170: a refund bills this task's own share; a CHARGE bills the edit's
  // combined total, because there is one supplementary invoice per edit and it
  // has to match the one request the member is asked to pay. Sending the share is
  // how the Xero leg lost the second $30 - a second invoice for an anchor that
  // already has an active one is refused quietly, not raised.
  const ask = editReviewXeroDocumentAsk({
    route,
    xeroAmountCents: isCharge ? chargeTotalCents : amountCents,
  });

  if (ask === null) {
    if (route && hasIssuedXeroInvoice) {
      // An edit-review completion that moved money on a booking with an issued
      // invoice but carries no anchor to correct it against. The card,
      // account-credit and (since #3170) additional-charge routes all refuse
      // before the claim when the anchor is missing, so only the hand-settled
      // route can reach here - and its money HAS moved, so refusing now is not
      // available. Say so loudly instead of leaving the divergence silent: an
      // operator has to correct that invoice by hand.
      logger.warn(
        { bookingId, taskId },
        "Edit financial review settled by hand with no BookingModification anchor - the Xero invoice must be corrected manually",
      );
    }
    return;
  }

  // Restate the invoice this edit ALREADY has queued rather than queueing a
  // second. Nothing to restate is the FIRST share's answer, and the enqueue below
  // is its path.
  if (
    isCharge &&
    (await restateEditReviewChargeSupplementaryInvoice({
      bookingId,
      taskId,
      bookingModificationId: ask.bookingModificationId,
      totalCents: ask.amountCents,
    }))
  ) {
    return;
  }

  // FIRE-AND-FORGET, BUT NOT FIRE-AND-FORGET-THE-ANSWER (#3170 fix round, F2).
  // The dispatch stays off the critical path - a Xero outage must not undo a
  // completion whose money question is settled - but its RESULT is now read
  // rather than discarded, because it carries the one fact nobody can recover
  // afterwards: whether the invoice really bills the combined total.
  // `recordShortEditReviewChargeInvoice` owns what to do about it.
  void queueXeroBookingEditSettlement({
    bookingId,
    bookingModificationId: ask.bookingModificationId,
    createdByMemberId: actingMemberId,
    hasIssuedXeroInvoice,
    originalPaymentStatus: bookingPaymentStatus,
    // #3170: the SIGN is the direction, and it is the only place the direction
    // becomes a number. A refund reaches the credit-note branch; a charge
    // reaches the supplementary-invoice branch, which is the same branch an
    // ordinary price increase takes. `amountCents` itself is a positive
    // magnitude on both.
    priceDiffCents: isCharge ? ask.amountCents : -ask.amountCents,
    changeFeeCents: 0,
    // The structural edit that raised this review queued its own narration
    // update when it committed. This is the money leg alone; claiming the dates
    // or the party changed here would queue a second, redundant invoice update.
    datesChanged: false,
    guestIdentityChanged: false,
    // `"credit"` picks the UNAPPLIED modification credit note and anything else
    // picks the ordinary one, so this reads as a two-way discriminator rather
    // than a claim about the instrument: an internet-banking hand-back is not a
    // card refund, but the club DID return the money, so it takes the same
    // ordinary credit note a card refund does.
    settlementMethod: route?.kind === "account-credit" ? "credit" : "card",
    // Read only on the reduction branch (`settlementAmountCents ?? Math.abs`),
    // so a charge passes null and lets the positive delta speak for itself
    // rather than handing the credit-note arm an amount it must not use.
    settlementAmountCents: isCharge ? null : ask.amountCents,
    // #3170: the supplementary invoice waits for the additional payment when
    // there is one to wait for, which is the ordinary price-increase
    // arrangement. On the `invoice` route no intent exists and the
    // supplementary invoice IS the ask, so it is raised unpaid.
    requiresAdditionalStripePayment: isCharge && route.collectVia === "stripe",
    additionalPaymentIntentId,
  })
    .then(async (queued) => {
      if (!isCharge) return;
      await recordShortEditReviewChargeInvoice({
        outcome: queued.supplementaryInvoice,
        bookingId,
        bookingModificationId: ask.bookingModificationId,
        // #3193: THIS TASK, and THIS TASK'S OWN SHARE, are what a second ask is
        // anchored to and what it bills. The combined total above is what the
        // change's own invoice bills; handing that figure to the second ask
        // would invoice the member a second time for money already asked for.
        // The two travel together and are read together at the far end.
        reviewTaskId: taskId,
        shareCents: amountCents,
        memberId: chargeMemberId,
        totalCents: ask.amountCents,
        createdByMemberId: actingMemberId,
      });
    })
    .catch((err) =>
      logger.error(
        { err, bookingId, taskId },
        "Failed to queue Xero settlement for a completed edit financial review",
      ),
    );
}
