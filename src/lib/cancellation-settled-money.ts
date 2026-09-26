/**
 * WHAT DID THE CANCELLATION ALREADY SETTLE? — one home for the question (#3639,
 * `INV-PAY-106`, `INV-SSOT-001`).
 *
 * Two processes look at a cancelled booking's money long after the cancel has
 * decided it, and both used to re-decide it without asking:
 *
 * - the Stripe webhook, when a "payment succeeded" notice arrives for a booking
 *   that is already cancelled (`handleCancelledBookingPaymentSucceeded`). It
 *   refunded the whole capture — including money a 0%-tier cancellation had
 *   kept — whenever the notice was merely late;
 * - the booking-versus-Xero repair tool's cancelled-open-invoice arm, which
 *   counted only Stripe captures as "paid" and missed a credit note already on
 *   the payment, so it cleared invoices bank transfers had paid. Its half is
 *   `hasCapturedRepairPayment` and `paymentNoteAnswersInvoice` in the repair
 *   modules, because it asks about Xero objects this leaf cannot see.
 *
 * The repair tool's late-capture arm was the one place that already asked
 * (#1491). Its test moved here from `xero-booking-repair-classify.ts` and the
 * webhook now reads it too: a second copy in the webhook would give the tree two
 * definitions of "the cancellation decided this money", which is the drift the
 * issue was filed to prevent.
 *
 * WHY HERE. Beside `booking-payment-state.ts` and `payment-transaction-status.ts`,
 * and like them a pure leaf: no Prisma client, no logger, no `server-only`. The
 * repair tool is an operator CLI (`cli-server-only-reach-census.test.ts`), and the
 * webhook is a route handler, so the one rule has to be importable from both
 * without either dragging the other's graph behind it. Each caller loads the
 * evidence its own way (the repair tool in bulk for a sweep, the webhook for one
 * booking); the DECISION over that evidence is only here.
 */
import {
  CreditType,
  type BookingEventType,
  type PaymentStatus,
} from "@prisma/client";
import { isManualSettlementMarkerEvent } from "@/lib/manual-settlement-reversal-event";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";

/**
 * The `PaymentTransaction.reason` the webhook's late-capture handler stamps on a
 * capture it records itself. It is how that handler recognises its OWN earlier
 * write when a crash or a Stripe retry replays the event, so it must be written
 * and read from this one constant — a spelling that drifted would make a
 * crashed genuine late capture look like money the cancellation kept, and it
 * would never be refunded.
 */
export const CANCELLED_BOOKING_LATE_CAPTURE_REASON =
  "cancelled_booking_late_capture";

/** The `MemberCredit` fields the cancellation-credit test reads. */
export type CancellationCreditRow = {
  type: CreditType;
  description: string;
  amountCents: number;
};

/**
 * The artefacts a cancellation leaves when it decides what happens to money
 * that was captured. Each caller loads them its own way; this is only the shape.
 */
export type CancellationRefundDecisionEvidence = {
  bookingId: string;
  /** The booking's `CANCELLED` events: whether each carries a snapshot, and whose. */
  cancelledEvents: ReadonlyArray<{ type: BookingEventType; snapshot: unknown }>;
  /** `MemberCredit` rows whose `sourceBookingId` is this booking. */
  creditsFromCancellation: ReadonlyArray<CancellationCreditRow>;
  /**
   * The booking-cancel card-refund recovery operation(s), keyed
   * `booking_cancel_refund_recovery_<bookingId>`
   * (`buildBookingCancellationRefundIdempotencyKey`). Only `status` is read.
   */
  cancellationRefundRecoveryOperations: ReadonlyArray<{ status: string }>;
};

/**
 * The cancellation credit a paid-path credit cancel wrote for THIS booking.
 *
 * Matched on the type AND the exact description `createCancellationCredit`
 * writes (`member-credit.ts`), because `CANCELLATION_REFUND` with this
 * `sourceBookingId` is also written by `restoreCreditFromBooking` (applied
 * credit handed back, which happens on unpaid cancels too) and by the inbound
 * late-cash credit — neither of which is a decision about captured money.
 */
export function getCancellationCreditCents(
  bookingId: string,
  credits: ReadonlyArray<CancellationCreditRow>
): number {
  const description = `Cancellation refund for booking ${bookingId.slice(0, 8)}`;
  return credits
    .filter(
      (credit) =>
        credit.type === CreditType.CANCELLATION_REFUND &&
        credit.description === description
    )
    .reduce((sum, credit) => sum + credit.amountCents, 0);
}

/**
 * #1491 (owner decision): did the cancellation RECORD a decision about the
 * booking's captured money? A cancel that did so deliberately kept whatever it
 * did not hand back, as the cancellation-policy penalty.
 *
 * The decision artefacts, any of:
 *
 * - a `CANCELLED` event carrying the policy snapshot — written by every
 *   paid-path cancel, including a 0%-tier retention; unpaid-branch cancels
 *   carry no snapshot. The #2262 admin settlement markers are `CANCELLED`
 *   events WITH a snapshot that cancel nothing and decide no refund
 *   (`isManualSettlementMarkerEvent`), so they never count: read by the
 *   webhook, one would withhold a genuine late capture's refund;
 * - a cancellation credit (the credit path);
 * - a LIVE booking-cancel refund recovery operation (the card path, frozen
 *   inside the claim transaction). A terminally `FAILED` one is a decision whose
 *   money never moved, so it does NOT count: the recovery exhaustion alert and
 *   the repair tool's finding both stay loud.
 *
 * THE SNAPSHOT COMMITS WITH THE CANCEL. It is written inside the paid path's
 * claim transaction (`writePaidCancellationEvent` in `booking-cancel.ts`), so a
 * booking seen `CANCELLED` already carries it; before #3639 it was written after
 * commit, best-effort, and a 0%-tier cancel — whose only artefact it is — read
 * as undecided in that gap.
 *
 * KNOWN LIMIT: the answer is per BOOKING, not per capture. On its own it cannot
 * tell a genuine late capture from a retention on a booking that also had a
 * paid-path cancel; `classifyCaptureOnCancelledBooking` adds the per-capture
 * half for a caller that holds the capture row.
 */
export function isCancellationRefundDecisionRecorded(
  evidence: CancellationRefundDecisionEvidence
): boolean {
  return (
    evidence.cancelledEvents.some(
      (event) =>
        event.snapshot !== null && !isManualSettlementMarkerEvent(event)
    ) ||
    getCancellationCreditCents(
      evidence.bookingId,
      evidence.creditsFromCancellation
    ) > 0 ||
    evidence.cancellationRefundRecoveryOperations.some(
      (operation) => operation.status !== "FAILED"
    )
  );
}

/**
 * What a "payment succeeded" notice for a CANCELLED booking is, and so what the
 * webhook does with it (#3639):
 *
 * - `late_capture` — money that landed after the cancellation. Refunded in full,
 *   as #1350 always has.
 * - `settled_by_cancellation` — money captured BEFORE the cancel, whose cancel
 *   recorded what to do with it. Acknowledged; nothing moves.
 * - `already_refunded` — the capture has already been handed back (fully or in
 *   part), typically a replay of a notice this handler already refunded.
 *   Acknowledged; nothing moves, and the row is never rewritten to SUCCEEDED.
 */
export type CancelledBookingCaptureVerdict =
  | "late_capture"
  | "settled_by_cancellation"
  | "already_refunded";

/** The facts about ONE capture row the verdict reads. */
export type CapturedRowOnCancelledBooking = {
  status: PaymentStatus;
  /**
   * Durable evidence that this capture landed AFTER the cancellation: the row
   * carries `CANCELLED_BOOKING_LATE_CAPTURE_REASON` (the primary handler's own
   * earlier write), or the cancel's claim recorded the intent as outstanding by
   * enqueuing its `CANCEL_PAYMENT_INTENT` recovery operation (an additional
   * payment's intent; that handler's own write stamps no reason, and the row's
   * reason names the booking change, so it is not overwritten). REQUIRED, so a
   * caller that forgot to load it cannot be told "captured before" by default.
   */
  capturedAfterCancellation: boolean;
};

/** Whether a row's reason marks the primary late-capture handler's own write. */
export function isLateCaptureHandlerWrite(reason: string | null): boolean {
  return reason === CANCELLED_BOOKING_LATE_CAPTURE_REASON;
}

/**
 * THE rule (#3639, `INV-PAY-106`): what a success notice on a cancelled booking
 * is. Settled money needs BOTH halves, and each closes a hole the other leaves:
 *
 * 1. **The capture is not known to have landed after the cancel.** Skipping on
 *    "already SUCCEEDED" alone would never refund a crash-and-retry of a genuine
 *    late capture, because the handler writes SUCCEEDED before it refunds; the
 *    `capturedAfterCancellation` evidence is what tells its own write apart.
 * 2. **The cancellation recorded a decision about captured money**
 *    (`isCancellationRefundDecisionRecorded`). Half 1 alone is not enough: a
 *    saved-card charge that captures AFTER an unpaid cancel records its own row
 *    SUCCEEDED (`settleSavedCardChargeAttempt`) before the booking's settlement
 *    refuses the cancelled booking — a genuine late capture with a captured row
 *    and no late marker. Its cancel took the unpaid branch, so no decision
 *    exists, and it is still refunded.
 *
 * Anything else already past SUCCEEDED is `already_refunded`: refunding the
 * notice's full amount again could only fail at Stripe (it will not refund past
 * the charge) and loop the webhook, after rewriting the row to SUCCEEDED.
 */
export function classifyCaptureOnCancelledBooking(
  capture: CapturedRowOnCancelledBooking,
  evidence: CancellationRefundDecisionEvidence
): CancelledBookingCaptureVerdict {
  if (!isCapturedTransactionStatus(capture.status)) return "late_capture";
  if (
    !capture.capturedAfterCancellation &&
    isCancellationRefundDecisionRecorded(evidence)
  ) {
    return "settled_by_cancellation";
  }
  return capture.status === "SUCCEEDED" ? "late_capture" : "already_refunded";
}
