/**
 * WHAT DID THE CANCELLATION ALREADY SETTLE? — one home for the question (#3639,
 * `INV-PAY-018`, `INV-SSOT-001`).
 *
 * Two processes look at a cancelled booking's money long after the cancel has
 * decided it, and both used to re-decide it without asking:
 *
 * - the Stripe webhook, when a "payment succeeded" notice arrives for a booking
 *   that is already cancelled (`handleCancelledBookingPaymentSucceeded`). It
 *   refunded the whole capture — including money a 0%-tier cancellation had
 *   kept — whenever the notice was merely late;
 * - the booking-versus-Xero repair tool's late-capture arm, which has asked the
 *   question since #1491 and was the only place that did.
 *
 * #1491's test moved here from `xero-booking-repair-classify.ts` so both read
 * the same answer. A second copy in the webhook would give the tree two
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
import { CreditType, type PaymentStatus } from "@prisma/client";
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
  /** The booking's `CANCELLED` events. Only whether each carries a snapshot is read. */
  cancelledEvents: ReadonlyArray<{ snapshot: unknown }>;
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
 *   carry no snapshot;
 * - a cancellation credit (the credit path);
 * - a LIVE booking-cancel refund recovery operation (the card path, frozen
 *   inside the claim transaction). A terminally `FAILED` one is a decision whose
 *   money never moved, so it does NOT count: the recovery exhaustion alert and
 *   the repair tool's finding both stay loud.
 *
 * KNOWN LIMITS, both stated rather than hidden:
 *
 * - The snapshot is written AFTER the cancel's claim commits, best-effort
 *   (`recordCancellationEvent` in `booking-cancel.ts`). A 0%-tier cancel has no
 *   other artefact, so for the few milliseconds between that commit and the
 *   event write — or for good if the write fails — the decision reads as
 *   unrecorded, and a caller falls back to what it did before #3639.
 * - The answer is per BOOKING, not per capture. On its own it cannot tell a
 *   genuine late capture from a retention on a booking that also had a paid-path
 *   cancel; `hasCancellationSettledCapture` adds the per-capture half for a
 *   caller that holds the capture row.
 */
export function isCancellationRefundDecisionRecorded(
  evidence: CancellationRefundDecisionEvidence
): boolean {
  return (
    evidence.cancelledEvents.some((event) => event.snapshot !== null) ||
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
 * #3639: is this capture money the cancellation already settled — so a later
 * process must leave it alone — rather than a genuine late capture?
 *
 * BOTH halves are needed, and each closes a hole the other leaves:
 *
 * 1. **The capture was recorded, and not by the late-capture handler itself.**
 *    A row in a captured status written by anybody else (the booking's own
 *    settlement, a saved-card charge) is money the club held; a row the handler
 *    stamped `CANCELLED_BOOKING_LATE_CAPTURE_REASON` is its own earlier write, so
 *    a crash-and-retry of a genuine late capture is still refunded. Skipping on
 *    "already SUCCEEDED" alone would never refund that retry, because the handler
 *    writes SUCCEEDED before it refunds.
 * 2. **The cancellation recorded a decision about captured money**
 *    (`isCancellationRefundDecisionRecorded`). Half 1 alone is not enough: a
 *    saved-card charge that captures AFTER an unpaid cancel records its own row
 *    SUCCEEDED (`settleSavedCardChargeAttempt`) before the booking's settlement
 *    refuses the cancelled booking — a genuine late capture with a captured row
 *    and no late-capture reason. Its cancel took the unpaid branch, so no
 *    decision exists, and it is still refunded.
 *
 * `reason` is REQUIRED so a caller that forgot to load it cannot be told
 * "not the handler's own write" by default.
 */
export function hasCancellationSettledCapture(
  capture: { status: PaymentStatus; reason: string | null },
  evidence: CancellationRefundDecisionEvidence
): boolean {
  return (
    isCapturedTransactionStatus(capture.status) &&
    capture.reason !== CANCELLED_BOOKING_LATE_CAPTURE_REASON &&
    isCancellationRefundDecisionRecorded(evidence)
  );
}
