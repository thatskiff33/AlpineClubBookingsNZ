import "server-only";

import { BookingStatus, ManualRefundTaskKind, type Prisma } from "@prisma/client";
import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import {
  recordShortEditReviewChargeInvoice,
  restateEditReviewChargeSupplementaryInvoice,
} from "@/lib/edit-financial-review-charge-request";
import type { EditReviewSettlementRoute } from "@/lib/edit-financial-review-settlement";
import logger from "@/lib/logger";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import type { RefundMethod } from "@/lib/xero-refund-method";
import type { ClubFormat } from "@/lib/club-format";

/**
 * HOW THE MONEY WENT BACK, as the Xero document will say it (`INV-PAY-101`,
 * #3529). The route IS the settlement decision, so this is a reading of it and
 * not a second decision: the card route refunded a card, the account-credit
 * route kept the money as credit, and the hand-settled route is money the club
 * sent back itself - by internet banking, which is the only way a club sends
 * money it holds. Before #3529 the leg collapsed every non-credit route to
 * `"card"`, which put the card wording on a bank-transfer hand-back.
 *
 * A charge has no refund and reaches no credit note; it reads as card so the
 * type stays total, and the classifier never consults it on that branch.
 */
export function refundMethodForEditReviewRoute(
  route: Pick<EditReviewSettlementRoute, "kind"> | null,
): RefundMethod {
  switch (route?.kind) {
    case "account-credit":
      return "account-credit";
    case "local-allocation":
      return "internet-banking";
    default:
      return "card";
  }
}

/**
 * #3880: THE INVOICE A REFUND ON A CANCELLED BOOKING IS NOTED AGAINST, or null.
 * A `CANCELLED_BOOKING_HAND_BACK` (#3529), and an edit financial review with its
 * `BookingModification` anchor on a booking already CANCELLED. Both read the
 * booking's primary invoice, since `hasIssuedXeroInvoice` is false for every
 * cancelled booking; no invoice (a cash-settled booking) is no note, as a note
 * against no invoice is a permanently failing outbox row. Every other kind is
 * null and keeps its leg.
 */
export function cancelledBookingRefundInvoiceId(task: {
  kind: ManualRefundTaskKind | null;
  reviewContext: unknown;
  booking: { status: BookingStatus; payment: { xeroInvoiceId: string | null } | null };
}): string | null {
  const anchoredReviewOfCancelled =
    task.kind === ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW &&
    task.booking.status === BookingStatus.CANCELLED &&
    Boolean(parseEditFinancialReviewContext(task.reviewContext)?.bookingModificationId);
  return task.kind === ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK || anchoredReviewOfCancelled
    ? (task.booking.payment?.xeroInvoiceId ?? null)
    : null;
}

/**
 * #3880: A REVIEW'S CARD REFUND OR BANK-TRANSFER HAND-BACK ON A CANCELLED
 * BOOKING takes the document the paid cancellation's own card refund takes
 * (`INV-SSOT`): a refund credit note on the payment through
 * `enqueueXeroRefundCreditNoteOperation`, unallocated and settled by its own
 * refund payment from the card clearing or bank-transfer refund account
 * (`INV-PAY-101`), so the invoice stays exactly as the cancellation left it.
 * Sized to what this review actually sent back - the netted capture part
 * (#3835), never the typed share - and its outbox row keyed on the task, so
 * sibling reviews are a row each and a replay is the same one. The
 * applied-credit part given back beside it takes no document: like the
 * cancellation's own restore it is a noteless credit row, minted a note when
 * spent (#2717).
 *
 * WHEN it is queued follows when the money is on the payment's refund ledger,
 * which is what the enqueue sizes against. The bank-transfer hand-back is
 * written inside the completion transaction (`applyLocalRefundAllocation`), so
 * its row is queued there too, on that client
 * (`queueCancelledBookingHandBackNoteInTransaction`): it commits or rolls back
 * with the completion, and no crash or swallowed error after the commit can
 * leave the hand-back with no document. The card refund moves only after the
 * commit, and the enqueue caps a note at the cash Stripe has refunded, so its
 * row is still queued after that call; a lost one there is the payment's
 * uncovered cash, which the Stripe self-heal raises.
 */
type CancelledReviewRefundRoute = Extract<EditReviewSettlementRoute, { kind: "stripe-refund" | "local-allocation" }>;

function cancelledReviewRefundNoteRoute(
  route: EditReviewSettlementRoute | null,
  cancelledInvoiceId: string | null,
): CancelledReviewRefundRoute | null {
  return cancelledInvoiceId !== null &&
    (route?.kind === "stripe-refund" || route?.kind === "local-allocation") &&
    route.bookingModificationId !== null
    ? route
    : null;
}

function enqueueCancelledReviewRefundNote(
  route: CancelledReviewRefundRoute,
  taskId: string,
  actingMemberId: string,
  store?: Prisma.TransactionClient,
) {
  return enqueueXeroRefundCreditNoteOperation(route.paymentId, route.refundCents, {
    createdByMemberId: actingMemberId,
    refundMethod: refundMethodForEditReviewRoute(route) === "internet-banking" ? "internet-banking" : "card",
    reviewTaskId: taskId,
    ...(store ? { store } : {}),
  });
}

/**
 * #3880: a bank-transfer hand-back's note on a cancelled booking, queued on the
 * completion's own transaction after its allocation: a review's hand-back
 * (noted per refund, keyed on the task) and a `CANCELLED_BOOKING_HAND_BACK`
 * (`INV-PAY-101`, #3529: the payment's one refund note). An outbox row insert
 * and no provider call; a throw rolls the completion back.
 */
export async function queueCancelledBookingHandBackNoteInTransaction({
  task,
  route,
  actingMemberId,
  store,
}: {
  task: Parameters<typeof cancelledBookingRefundInvoiceId>[0] & { id: string };
  route: EditReviewSettlementRoute | null;
  actingMemberId: string;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const invoiceId = cancelledBookingRefundInvoiceId(task);
  const noted = cancelledReviewRefundNoteRoute(route, invoiceId);
  if (noted) {
    if (noted.kind !== "local-allocation" || noted.refundCents <= 0) return;
    await enqueueCancelledReviewRefundNote(noted, task.id, actingMemberId, store);
    return;
  }
  if (
    task.kind === ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK &&
    invoiceId !== null &&
    route?.kind === "local-allocation" &&
    route.refundCents > 0
  ) {
    await enqueueXeroRefundCreditNoteOperation(route.paymentId, route.refundCents, {
      createdByMemberId: actingMemberId,
      refundMethod: "internet-banking",
      store,
    });
  }
}

async function queueCancelledBookingReviewRefundNote({
  bookingId,
  taskId,
  actingMemberId,
  route,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  route: CancelledReviewRefundRoute;
}): Promise<void> {
  if (route.refundCents <= 0) return;
  try {
    if (route.kind === "stripe-refund") {
      const queued = await enqueueCancelledReviewRefundNote(route, taskId, actingMemberId);
      if (!queued.queueOperationId) return;
    }
    // A hand-back's row committed with the completion: only the kick is left.
    await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
  } catch (err) {
    logger.error(
      { err, bookingId, taskId, refundCents: route.refundCents },
      "Failed to queue the Xero refund note for a completed review's refund on a cancelled booking",
    );
  }
}

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
  cancellationHandBackInvoiceId,
  additionalPaymentIntentId,
  format,
}: {
  bookingId: string;
  taskId: string;
  /**
   * The booking's primary Xero invoice id when the task closed is a
   * `CANCELLED_BOOKING_HAND_BACK` or an anchored review of a cancelled booking
   * (`cancelledBookingRefundInvoiceId`, #3880), else null. The hand-back leg reads THIS
   * rather than `hasIssuedXeroInvoice`, which is false for a CANCELLED booking
   * by construction and would gate the note shut for the only kind of booking
   * that raises one. Null for a cash-settled booking (#2262) too, which is the
   * gate doing its job.
   */
  cancellationHandBackInvoiceId: string | null;
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
  /** The club's format (#3565), resolved by the caller before any transaction. */
  format: ClubFormat;
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
  // #3880: a review's refund on a CANCELLED booking. Its invoice is closed, so
  // the edit's own leg below would raise nothing (`hasIssuedXeroInvoice` is
  // false); the refund takes the cancellation's refund note instead.
  const cancelledReviewRefund = cancelledReviewRefundNoteRoute(route, cancellationHandBackInvoiceId);
  if (cancelledReviewRefund) {
    await queueCancelledBookingReviewRefundNote({ bookingId, taskId, actingMemberId, route: cancelledReviewRefund });
    return;
  }

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
    if (
      route?.kind === "local-allocation" &&
      cancellationHandBackInvoiceId !== null &&
      amountCents !== null &&
      amountCents > 0
    ) {
      // THE BANK-TRANSFER REFUND NOTE (`INV-PAY-101`, #3529). This task is
      // raised twice over: for a booking the club settled in cash (B5, #2262),
      // which has NO Xero invoice by construction - manual mark-paid is refused
      // wherever one exists and the invoice builder abandons rather than mint
      // over it - and for an internet-banking payment that reached Xero for a
      // booking already cancelled and owned by an organisation (#3369), whose
      // invoice Xero shows PAID. Only the second has anything to credit, and
      // until now it got nothing: this leg found no anchor and logged that the
      // invoice must be corrected by hand. The money HAS gone back - the ledger
      // allocation was written in the completion transaction - so that paid
      // invoice takes the same refund note a card refund gets, worded as a bank
      // transfer and settled only from the club's bank-transfer refund account.
      // The invoice-id gate is what keeps the cash case out, for the same
      // reason the hold-expiry note has one (`INV-PAY-017`): a note against no
      // invoice is a permanently failing outbox row. Keyed on the payment and
      // the amount by the enqueue, which is one note per hand-back because a
      // cancelled booking raises one task per payment.
      // #3880 F4: the row itself was queued inside the completion transaction
      // (`queueCancelledBookingHandBackNoteInTransaction`), so it commits or
      // rolls back with the money; only the best-effort kick is left here.
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
        logger.error(
          { err, bookingId, taskId },
          "Failed to kick the Xero outbox after a completed cancellation hand-back",
        ),
      );
      return;
    }
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
    // #3170: the SIGN is the direction - the same rule `editReviewSettlementSign`
    // applies to a settled share's line on the document (#3530), read here from
    // the route because a charge route is reachable only from CHARGE_TO_MEMBER.
    // A refund reaches the credit-note branch; a charge reaches the
    // supplementary-invoice branch, which is the same branch an ordinary price
    // increase takes. `amountCents` itself is a positive magnitude on both.
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
    // ...and this is the claim about the instrument, for the note's wording
    // (`INV-PAY-101`): the hand-settled route reads as a bank transfer.
    refundMethod: refundMethodForEditReviewRoute(route),
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
        format,
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

/**
 * #3791: THE XERO LEG OF AN ACCOUNT-CREDIT SHARE, held to three invariants for
 * a booking with an issued invoice (second review round, 3 October 2026): the
 * invoice less its allocated reduction notes is the booking's price as the app
 * now holds it; Xero's amount due is what the app says is owed; and the
 * member's Xero credit - counting credit rows with no note, which are minted
 * one when spent (#2717) - is the app's. Through the existing classifier and
 * builders, as the clamp's counterpart, an ordinary price reduction, does:
 *
 *  - the give-back's deallocation (`giveBackAppliedCredit`) returns what was
 *    given back to the member in Xero;
 *  - an invoice-ALLOCATED modification credit note takes off the whole
 *    reduction (`reviewInvoiceReductionCents`) - the re-price's drop on an
 *    unpaid booking, the agreed share on a covered one;
 *  - credit MINTED takes the unallocated account note, which the minted row is
 *    stamped with;
 *  - on a CANCELLED booking nothing reaches the invoice and nothing is
 *    deallocated; only the minted part takes its note. What was given back is
 *    a noteless credit row, minted a note when spent, exactly as the
 *    cancellation's own restore is - a note for it now would be credited twice.
 *
 * Every note is scoped to THIS review task (`reviewTaskId`), so a sibling
 * review's share on the same edit is a document of its own rather than a
 * duplicate folded into this one. Best-effort and after the commit, like every
 * other leg here.
 */
export async function dispatchEditReviewAccountCreditXero({
  bookingId,
  taskId,
  actingMemberId,
  bookingModificationId,
  invoiceReductionCents,
  mintedCents,
  cancelled,
  hasIssuedXeroInvoice,
  bookingXeroInvoiceId,
  bookingPaymentStatus,
}: {
  bookingId: string;
  taskId: string;
  actingMemberId: string;
  bookingModificationId: string;
  /** Null on a captured payment's share, which takes no invoice-allocated note. */
  invoiceReductionCents: number | null;
  mintedCents: number;
  cancelled: boolean;
  hasIssuedXeroInvoice: boolean;
  /** The booking's primary invoice, read in the completion transaction. */
  bookingXeroInvoiceId: string | null;
  bookingPaymentStatus: string | null;
}): Promise<void> {
  const notes: Array<{ cents: number; settlementMethod: "card" | "credit" }> = [
    // "card" is the classifier's two-way switch to the invoice-applied note;
    // the note's wording is the account credit the money went back as.
    { cents: cancelled ? 0 : (invoiceReductionCents ?? 0), settlementMethod: "card" },
    { cents: mintedCents, settlementMethod: "credit" },
  ];
  // A cancelled booking's invoice no longer counts as issued for an edit, but
  // it exists, and the minted credit's note is raised against its contact.
  const invoiceExists = cancelled ? bookingXeroInvoiceId !== null : hasIssuedXeroInvoice;
  // No invoice, no document: the classifier would say so too, and the member's
  // credit is whole in the app either way.
  if (!invoiceExists) return;
  for (const note of notes) {
    if (note.cents <= 0) continue;
    await queueXeroBookingEditSettlement({
      bookingId,
      bookingModificationId,
      reviewTaskId: taskId,
      createdByMemberId: actingMemberId,
      hasIssuedXeroInvoice: invoiceExists,
      originalPaymentStatus: bookingPaymentStatus,
      priceDiffCents: -note.cents,
      changeFeeCents: 0,
      datesChanged: false,
      guestIdentityChanged: false,
      settlementMethod: note.settlementMethod,
      refundMethod: "account-credit",
      settlementAmountCents: note.cents,
      requiresAdditionalStripePayment: false,
      additionalPaymentIntentId: null,
    }).catch((err) =>
      logger.error(
        { err, bookingId, taskId, cents: note.cents },
        "Failed to queue a Xero credit note for a completed edit financial review's account credit",
      ),
    );
  }
}
