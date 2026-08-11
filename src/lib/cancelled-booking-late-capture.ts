import { ManualRefundTaskStatus } from "@prisma/client";
import { logAudit } from "@/lib/audit";
import {
  recordAutomaticCancelledBookingRefundTask,
  type CancelledBookingLateCaptureKind,
} from "@/lib/deleted-booking-modification-payment";
import {
  sendAdminLateCaptureAutoRefundAlert,
  sendAdminLateCaptureHandBackConflictAlert,
} from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The shared epilogue of BOTH late-capture handlers on a cancelled booking
 * (#2773 / #2774).
 *
 * WHO DECIDED THIS: THE ORCHESTRATOR. Every direction taken here is the
 * **Recommended** option from #2773 / #2774, chosen by the orchestrator under the
 * owner's standing instruction to work the backlog down. The owner has NOT ruled on
 * either issue, and it is reversible. `INV-ADDPAY-039`'s authority line states this
 * in full and is what to cite — do not upgrade any of it to an "owner decision"
 * without a comment on the issue thread to point at.
 *
 * WHY THIS MODULE EXISTS. Since #1350 the Stripe webhook has refunded a capture
 * that lands on an already-`CANCELLED` booking, and it does so from two sibling
 * handlers in `stripe-webhook-service.ts`:
 *
 * - `handleCancelledBookingAdditionalPaymentSucceeded` — a payment for a *change*
 *   to the booking. #2760 gave it a durable record and #2761 an accurate,
 *   unmuteable alert.
 * - `handleCancelledBookingPaymentSucceeded` — the booking's OWN payment. It
 *   refunded with the same reason and wrote the same audit entry, and had
 *   NEITHER: no `ManualRefundTask` row, and the generic muteable "Payment Failed"
 *   mail. #2773 closes that.
 *
 * The obvious way to close it — copy #2760's twenty lines into the second handler
 * — is the defect class this repository keeps re-finding: two implementations of
 * one rule, drifting apart at the next change. So the epilogue lives here once and
 * both handlers call it. **There is exactly one record writer, one `deletedAt`
 * re-read and one alert decision in the tree.**
 *
 * WHAT IS DELIBERATELY NOT HERE. The refund itself, its amount, its timing and the
 * #1350 decision to make it stay in the handlers and are untouched —
 * `INV-ADDPAY-037` records that the refund is not gated. The one exception, #2774's
 * hand-back fence, is not a gate on that policy: it withholds a second copy of a
 * refund the member has already had by hand. The
 * `booking.payment.refunded_after_cancellation` audit entry also stays in each
 * handler: it carries handler-specific detail, and moving it would renumber census
 * ordinals for no gain.
 *
 * WHY THE EPILOGUE IS TWO FUNCTIONS AND NOT ONE. The record write must be
 * AWAITED — an un-awaited database write in a route handler can be killed when the
 * response is returned — while the alert must NOT be, because webhooks stay
 * non-blocking and a mail provider must never hold Stripe's delivery open. One
 * function could not have both. So `recordAutomaticLateCaptureRefund` is awaited
 * and `announceAutomaticLateCaptureRefund` is fire-and-forget, in that order,
 * because WHICH alert goes out depends on what the record writer found.
 */

/**
 * Everything the record, the audit rows and the alert all need about one late
 * capture. One shape rather than four parameter lists, because every field is read
 * by more than one of them, and a row and a mail disagreeing about which capture
 * this was is precisely what #2761 was filed about.
 */
export type CancelledBookingLateCapture = {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  /** The captured amount in integer cents, straight from the payment intent. */
  amountCents: number;
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  /** `Booking.deletedAt` as the handler's opening read saw it. */
  openingDeletedAt: Date | null;
  captureKind: CancelledBookingLateCaptureKind;
};

/** What the record write found, and therefore which alert the event gets. */
export type LateCaptureRecordOutcome = {
  /** The population the row stored, re-read after the caller's Stripe round trip. */
  bookingDeleted: boolean;
  /**
   * `true` when an operator's hand-`COMPLETED` row was found AFTER the refund —
   * #2774's residual window, where their completion landed inside the caller's own
   * Stripe round trip and the member has therefore probably been paid twice.
   */
  handCompletedAfterRefund: boolean;
};

/**
 * The fenced path: no Stripe refund was made, and a person has to reconcile.
 *
 * TWO OBLIGATIONS, BOTH ABOUT NOT BEING MISREAD.
 *
 * 1. **The audit entry must not be
 *    `booking.payment.refunded_after_cancellation`.** That action is the club's
 *    permanent record of an automatic refund — the finance card and
 *    `docs/guides/payments.md` both name it as such — and no refund happened here.
 *    Writing it would put a money movement that did not occur into the permanent
 *    record. So this is its own action,
 *    `booking.payment.late_capture_refund_withheld`, `severity: "critical"` (a
 *    person must act) and `outcome: "blocked"` — the honest word: a guard refused
 *    an action, nothing failed.
 * 2. **The alert must say the money did NOT go out.** Sending the "Payment
 *    refunded automatically" mail here would be the #2761 defect at the opposite
 *    polarity — a subject asserting a refund that was withheld. It gets its own
 *    template and its own subject.
 *
 * NO `ManualRefundTask` IS WRITTEN. The operator's `COMPLETED` row already IS the
 * record of this capture, and a second row for one capture is the property every
 * lookup in `deleted-booking-modification-payment.ts` exists to protect.
 *
 * STILL EXACTLY ONE NOTIFICATION FOR THE EVENT (`INV-ADDPAY-037`). This alert
 * REPLACES the auto-refund alert on this path: the caller returns immediately
 * after it, so the two are mutually exclusive. As with its sibling, a Stripe
 * REDELIVERY of the same event can re-send it — accepted and documented in the
 * registry's frequency note for the same reason it is there: a duplicate says the
 * same true thing twice, whereas deduping would make a redelivery after a FAILED
 * send silent, on a money notification that must not be silenceable — the owner's
 * #2761 ruling (10 Aug 2026), which the orchestrator extended to this alert under
 * #2774 (`INV-ADDPAY-039`'s authority line).
 *
 * NO PARTIAL TOP-UP REFUND, DELIBERATELY. The hand-back's amount is carried into
 * both the audit row and the mail so a person can see whether it covered the whole
 * capture, but nothing here refunds a difference: computing a partial refund is a
 * new money decision and this work changes no refund's amount.
 *
 * AWAITED BY THE CALLER, unlike the ordinary alert. On this path the alert is the
 * only thing that tells anybody the refund did not happen, and there is no row and
 * no ordinary audit entry beside it — so it is not treated as a nicety that may be
 * dropped when the handler returns.
 */
export async function reportWithheldLateCaptureRefund(params: {
  capture: CancelledBookingLateCapture;
  handBack: {
    id: string;
    amountCents: number;
    completedAt: Date | null;
    completedByMemberId: string | null;
  };
}): Promise<void> {
  const { capture, handBack } = params;

  logAudit({
    action: "booking.payment.late_capture_refund_withheld",
    category: "payment",
    severity: "critical",
    outcome: "blocked",
    entityType: "Booking",
    entityId: capture.bookingId,
    targetId: capture.bookingId,
    details: JSON.stringify({
      paymentIntentId: capture.paymentIntentId,
      capturedAmountCents: capture.amountCents,
      captureKind: capture.captureKind,
      manualRefundTaskId: handBack.id,
      handBackAmountCents: handBack.amountCents,
      handBackCompletedAt: handBack.completedAt
        ? handBack.completedAt.toISOString()
        : null,
      handBackCompletedByMemberId: handBack.completedByMemberId,
      // Spelled out in the row itself: nobody reading this should have to infer
      // from an action name whether money left the club.
      refundSent: false,
    }),
  });

  logger.warn(
    {
      bookingId: capture.bookingId,
      paymentId: capture.paymentId,
      paymentIntentId: capture.paymentIntentId,
      capturedAmountCents: capture.amountCents,
      captureKind: capture.captureKind,
      manualRefundTaskId: handBack.id,
      handBackAmountCents: handBack.amountCents,
    },
    "Withheld the automatic late-capture refund: an operator had already handed this capture back by hand, so refunding would pay the member twice (#2774)",
  );

  await sendAdminLateCaptureHandBackConflictAlert({
    memberName: capture.memberName,
    checkIn: capture.checkIn,
    checkOut: capture.checkOut,
    amountCents: capture.amountCents,
    paymentIntentId: capture.paymentIntentId,
    bookingId: capture.bookingId,
    // The opening read, deliberately: no Stripe round trip happened on this path,
    // so there is no window for the population to have changed under us and
    // nothing to re-read.
    bookingDeleted: capture.openingDeletedAt !== null,
    captureKind: capture.captureKind,
    handBackAmountCents: handBack.amountCents,
    refundSent: false,
  });
}

/**
 * Which population this capture belongs to, read AFTER the caller's Stripe round
 * trip rather than trusted from the handler's opening read.
 *
 * WHY IT IS RE-READ (review of #2760). The booking row is loaded before the
 * refund, and an admin deleting the booking inside that window would otherwise
 * make the stored `reason` say "cancelled, still on file" and the mail say
 * "normally nothing to do" — for the one population whose follow-up the alert
 * exists to state, where remaking the booking means charging the member again.
 *
 * WHY IT IS SAFE TO READ AGAIN. Deletion is one-way (`INV-ADDPAY-030`) with a
 * single writer and no restore path, so the two reads can disagree in only one
 * direction: the earlier one can under-report a deletion, never over-report it.
 * That is why the re-read is skipped entirely when the opening read already saw a
 * deletion.
 *
 * WHY A FAILURE FALLS BACK RATHER THAN THROWING, unlike the #2774 fence. By the
 * time this runs the money is already back with the member. The population picks
 * one sentence and one paragraph of copy; losing the bookkeeping row over it — a
 * 500 replays the whole refund path — would trade a wrong adjective for a lost
 * record. The stale value can only ever be the *less* alarming of the two, so the
 * failure mode is an under-stated alert on an event that is still reported, and it
 * is logged at ERROR.
 */
async function resolveLateCaptureBookingDeleted(capture: {
  bookingId: string;
  paymentIntentId: string;
  openingDeletedAt: Date | null;
}): Promise<boolean> {
  if (capture.openingDeletedAt !== null) return true;
  try {
    const fresh = await prisma.booking.findUnique({
      where: { id: capture.bookingId },
      select: { deletedAt: true },
    });
    return Boolean(fresh?.deletedAt);
  } catch (err) {
    logger.error(
      {
        err,
        bookingId: capture.bookingId,
        paymentIntentId: capture.paymentIntentId,
      },
      "Could not re-read deletedAt after the automatic late-capture refund; recording the population from the opening read",
    );
    return false;
  }
}

/**
 * The durable record of one automatic late-capture refund. **Await this** — the
 * caller has already refunded at Stripe and this is the only row that says so on
 * an operator surface.
 *
 * IT MAY NEVER FAIL THE WEBHOOK, which is why the catch is here rather than left
 * to the call site. The money is already back with the member and a 500 would
 * replay the whole refund path for a bookkeeping row. But a swallowed failure is
 * unrecoverable — Stripe never redelivers a 200, and nothing else in the tree ever
 * writes that row — so the catch writes
 * `booking.payment.auto_refund_record_failed` at `severity: "critical"`. That audit
 * row is the ONLY surface a lost record appears on, and it is the surface the
 * finance card itself names as permanent. This is `INV-ADDPAY-037`'s second named
 * exception; removing it or downgrading it to a log line breaks the rule.
 *
 * THE OUTCOME IT RETURNS IS NOT DECORATION. `handCompletedAfterRefund` is #2774's
 * residual-window detector: the fence read this capture's hand-back task as
 * unresolved, and the writer has now found it `COMPLETED`, so the operator's
 * completion committed inside the caller's Stripe round trip and the member has
 * probably been paid twice. The ordinary `DISMISSED` hand-resolution is NOT
 * escalated — no allocation exists, nothing was paid twice, and the only
 * consequence is that the refund reaches no finance card — the carve-out #2774 D1
 * keeps (the orchestrator's call, not the owner's), reported at WARN by the record
 * writer and named in `INV-ADDPAY-037` and the card copy.
 *
 * A RECORD-WRITE FAILURE REPORTS NO CONFLICT, and that is honest rather than
 * convenient: the writer is the only thing that reads the row's status, so when it
 * throws nothing is known about a hand-back either way. The `critical` audit row
 * above says the record is lost, which is what an operator has to act on.
 */
export async function recordAutomaticLateCaptureRefund(
  capture: CancelledBookingLateCapture,
): Promise<LateCaptureRecordOutcome> {
  const bookingDeleted = await resolveLateCaptureBookingDeleted(capture);

  try {
    const outcome = await recordAutomaticCancelledBookingRefundTask({
      bookingId: capture.bookingId,
      paymentId: capture.paymentId,
      paymentIntentId: capture.paymentIntentId,
      amountCents: capture.amountCents,
      bookingDeleted,
      captureKind: capture.captureKind,
    });
    return {
      bookingDeleted,
      handCompletedAfterRefund:
        outcome.existingStatus === ManualRefundTaskStatus.COMPLETED,
    };
  } catch (taskErr) {
    logger.error(
      {
        err: taskErr,
        bookingId: capture.bookingId,
        paymentIntentId: capture.paymentIntentId,
        captureKind: capture.captureKind,
      },
      "Failed to record the automatically refunded late capture on a cancelled booking",
    );
    logAudit({
      action: "booking.payment.auto_refund_record_failed",
      category: "payment",
      severity: "critical",
      outcome: "failure",
      entityType: "Booking",
      entityId: capture.bookingId,
      targetId: capture.bookingId,
      details: JSON.stringify({
        paymentIntentId: capture.paymentIntentId,
        amountCents: capture.amountCents,
        bookingDeleted,
        captureKind: capture.captureKind,
        error: taskErr instanceof Error ? taskErr.message : String(taskErr),
      }),
    });
    return { bookingDeleted, handCompletedAfterRefund: false };
  }
}

/**
 * The ONE notification for a late capture the webhook refunded (`INV-ADDPAY-037`).
 * Fire-and-forget from the caller: webhooks stay non-blocking and the durable
 * records are the row and the audit entries.
 *
 * TWO MUTUALLY EXCLUSIVE OUTCOMES, chosen from what the record write found, never
 * both and never neither:
 *
 * - Ordinary — `admin-late-capture-auto-refund`: the money went back, and which
 *   population it was so an operator knows whether anything follows.
 * - **Double payment** (#2774's residual window) — the hand-back conflict alert
 *   with `refundSent: true`, beside a `critical`
 *   `booking.payment.late_capture_double_refund_suspected` audit row. Sending both
 *   mails would be two notifications for one event; sending only the cheerful one
 *   would be a lie by omission about money leaving the club twice.
 *
 * `handBackAmountCents: null` on the conflict arm, deliberately: the amount is
 * read from the row only on the fenced path, and re-reading it here would add a
 * query to the residual case for a figure a reader can get from the payment. The
 * booking id and the payment intent id are printed, which is how the row is found.
 */
export async function announceAutomaticLateCaptureRefund(
  capture: CancelledBookingLateCapture,
  outcome: LateCaptureRecordOutcome,
): Promise<void> {
  if (outcome.handCompletedAfterRefund) {
    logAudit({
      action: "booking.payment.late_capture_double_refund_suspected",
      category: "payment",
      severity: "critical",
      outcome: "failure",
      entityType: "Booking",
      entityId: capture.bookingId,
      targetId: capture.bookingId,
      details: JSON.stringify({
        paymentIntentId: capture.paymentIntentId,
        amountCents: capture.amountCents,
        bookingDeleted: outcome.bookingDeleted,
        captureKind: capture.captureKind,
        // Spelled out for the same reason its withheld sibling spells out
        // `false`: a reader must not have to infer which way the money went.
        refundSent: true,
      }),
    });
    logger.error(
      {
        bookingId: capture.bookingId,
        paymentId: capture.paymentId,
        paymentIntentId: capture.paymentIntentId,
        amountCents: capture.amountCents,
        captureKind: capture.captureKind,
      },
      "An operator hand-completed this refund task while Stripe was refunding the same capture; the member may have been paid twice (#2774)",
    );
    await sendAdminLateCaptureHandBackConflictAlert({
      memberName: capture.memberName,
      checkIn: capture.checkIn,
      checkOut: capture.checkOut,
      amountCents: capture.amountCents,
      paymentIntentId: capture.paymentIntentId,
      bookingId: capture.bookingId,
      bookingDeleted: outcome.bookingDeleted,
      captureKind: capture.captureKind,
      handBackAmountCents: null,
      refundSent: true,
    });
    return;
  }

  await sendAdminLateCaptureAutoRefundAlert({
    memberName: capture.memberName,
    checkIn: capture.checkIn,
    checkOut: capture.checkOut,
    amountCents: capture.amountCents,
    paymentIntentId: capture.paymentIntentId,
    bookingId: capture.bookingId,
    // The SAME resolved value the row stored, so the subject, the body's follow-up
    // sentence and the card's grouping cannot disagree about which population this
    // capture belonged to.
    bookingDeleted: outcome.bookingDeleted,
    captureKind: capture.captureKind,
  });
}
