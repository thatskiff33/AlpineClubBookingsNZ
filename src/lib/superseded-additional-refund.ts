import { BookingEventType, Prisma, type PaymentRecoveryOperation } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { bookingOutstandingCents } from "@/lib/additional-payment-ask";
import { findHeldOnceEverAlertKeys, giveBackOwnOnceEverClaim } from "@/lib/admin-alert-once";
import { sendAdminAlertOnceEverWithTakeover } from "@/lib/admin-alert-once-takeover";
import { ALERT_ONCE_EVER_WINDOW_MS, claimAlertCooldown } from "@/lib/alert-cooldown";
import { logAudit } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import { sendAdminSupersededPaymentRefundAlert } from "@/lib/email/admin-alerts-finance";
import { sendSupersededPaymentRefundedEmail } from "@/lib/email/booking";
import logger from "@/lib/logger";
import { carriesCardRefundOperationMetadata } from "@/lib/open-card-refund-owed";
import { PAYMENT_RECOVERY_STALE_PROCESSING_MS } from "@/lib/payment-recovery-constants";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { stripeReferenceId } from "@/lib/stripe-references";
import {
  SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND,
  SUPERSEDED_ADDITIONAL_REFUND_EVENT_REASON,
  type SupersededAdditionalRefundEventSnapshot,
} from "@/lib/superseded-additional-refund-event";
import type { ClubFormat } from "@/lib/club-format";

/**
 * THE ONE EPILOGUE of a `REFUND_SUPERSEDED_PAYMENT` recovery operation (#3340).
 *
 * WHAT WENT WRONG WITHOUT IT. A booking edit mints a replacement charge and
 * retires the one before it. When a member confirms the retired charge inside
 * that window, the capture is refunded - and until #3340 the club recorded
 * NOTHING about any of it: no `AuditLog` row, no `BookingEvent`, no member mail
 * and no admin alert. Stripe's own receipt was the entire notice, so the member
 * in the live case saw a $65 charge and a $65 refund with no explanation from
 * anybody, wrote in to ask, and that query is the only reason the money leak
 * underneath was ever found.
 *
 * FOUR RECORDS, AND WHY EACH IS A SEPARATE ONE.
 *  - **`AuditLog`** (`category: "payment"`) - the permanent, operator-searchable
 *    record that money left the club. It outlives the alert mail and is what a
 *    person reconciling months later reads.
 *  - **`BookingEvent`** - the booking's own narrative. Carries the #3340
 *    discriminator so the cancellation narrative can never pick it up as a
 *    settlement clause (see `superseded-additional-refund-event.ts`).
 *  - **The member mail** - the explanation nobody was sending. It names what came
 *    back and what is still owing.
 *  - **The admin alert** - money moved with no person deciding it should.
 *
 * ONCE PER ROW, WHICHEVER ATTEMPT SENDS IT (#4690). Each record has a key named
 * for the recovery row (`supersededRefundReportKeys`), so the attempt that made
 * the refund, a replay of it, and the next claim that finds the refund already
 * made (`reportUnannouncedSupersededPaymentRefund`) can all call this and only
 * the first sends. It runs BEFORE the row's close: until #4690 it ran only after
 * a close the attempt won, and an attempt the reaper had handed back (#4675)
 * made the refund, lost its close, and nobody announced it.
 *
 * WHAT IT THROWS. Only `SupersededRefundReportNotSettledError` - a read it
 * depends on that failed included, with the failure as its `cause` - when the
 * notice may not have gone out: the row then stays open and the retry sends what is
 * missing - the refund itself is never repeated, because the ledger already
 * reads nothing outstanding. A mail provider failure is not one: the member's
 * email is recorded for the retry worker, and an admin copy that failed is
 * replayed by the email retry cron. A booking with no owner to address gets the
 * audit row and its own `critical` escalation row, as before. It returns
 * `in-flight` when another attempt is still sending the admin alert: the row
 * then waits rather than failing (`SupersededRefundReportOutcome`).
 *
 * THE AMOUNT OWING IS THE BOOKING'S WHOLE OUTSTANDING, not just its ask. It
 * comes from `bookingOutstandingCents`, which is `INV-PAY-047` rearranged, so
 * the member's mail, the admin's alert and the census cannot quote different
 * numbers at each other (`INV-SSOT-001`). The caller reconciles the payment
 * aggregates BEFORE calling this, which is what makes the figure the post-refund
 * one.
 *
 * The ask alone is NOT enough, and the shape that proves it is the one this
 * epilogue was nearly shipped with (#3340 fix round). `REFUND_SUPERSEDED_PAYMENT`
 * is not additional-only: `processCancelPaymentIntentOperation` also processes
 * the rows `queueSupersededPrimaryIntentCancellations` writes for the #1041 /
 * #1161 stale-tab protection. So a PAYMENT_PENDING booking edited from $130 to
 * $195, whose stale tab confirms the $130 PRIMARY and has it refunded, carries
 * NO ask at all - and the member would have been emailed "Nothing further is
 * owing on this booking" while the entire $195 was owed. On the ordinary
 * ADDITIONAL shape the two figures are arithmetically the same, which is what
 * keeps that case's number unchanged.
 */
export async function reportSupersededPaymentRefund(params: {
  /** The `REFUND_SUPERSEDED_PAYMENT` row whose refund this announces: the report's once-only key (#4690). */
  operationId: string;
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  refundedAmountCents: number;
  /** The club's format (#3565), resolved before any transaction by the caller. */
  format: ClubFormat;
}): Promise<SupersededRefundReportOutcome> {
  const keys = supersededRefundReportKeys(params.operationId);
  if (await readOrNotSettled(params.operationId, "whether it was sent could not be read", () => supersededRefundReportSettled(params.operationId))) {
    return "reported";
  }
  const context = await loadReportContext(params);
  if (context) await recordMemberNotice(params, context);
  await writeRecordsOnce(params, context, keys);
  if (!context) {
    // Nothing can be addressed; the critical row above is the escalation.
    await markReported(keys, params);
    return "reported";
  }
  return sendAdminAlertOnce(params, context, keys);
}

/**
 * What a report came to (#4690): `reported` - sent now, or already - or
 * `in-flight`, when another attempt holds the admin alert's claim and is still
 * sending it. That is a wait, not a failure: the recovery worker puts the row
 * back with its attempt handed back (`waitPaymentRecoveryOperation`), and a
 * later run finds the report settled and closes it.
 */
export type SupersededRefundReportOutcome = "reported" | "in-flight";

/** The recovery row's `lastError` while it waits on another attempt's alert (#4690). */
export const SUPERSEDED_REFUND_REPORT_IN_FLIGHT_MESSAGE =
  "The superseded-payment refund was made, and another attempt is sending its notice; this row waits for it, then closes (#4690).";

/**
 * #4690: the refund's notice is not settled - the member's email was not
 * recorded, or the admin alert neither sent nor known to be sent. Thrown to
 * the recovery worker BEFORE the row's close, so the row stays open and a
 * retry sends what is missing; everything already sent stays sent once. Its
 * text is the row's `lastError`, and the officers' alert quotes it when no
 * retry is left, so it says what to do then.
 */
export class SupersededRefundReportNotSettledError extends Error {
  constructor(readonly operationId: string, reason: string, options?: { cause?: unknown }) {
    super(`The superseded-payment refund was made, but its notice is not settled: ${reason}. A retry sends the notice once; if this was the last attempt, the member and the admins may not have been told - check the booking and tell the member (#4690).`, options);
    this.name = "SupersededRefundReportNotSettledError";
  }
}

/**
 * A read the report's outcome depends on, which throws only as not settled
 * (#4700 review): the officers' alert quotes the error on a final attempt, and
 * a raw database or Stripe error would not say the refund was made.
 */
async function readOrNotSettled<T>(operationId: string, reason: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new SupersededRefundReportNotSettledError(operationId, reason, { cause: err });
  }
}

/**
 * #4690: the report's once-only keys, all named for the recovery row. The
 * member's email has its own (its `EmailLog` row, `idempotencyKey` the row id).
 * - `records`: claimed before the audit row and booking event are written, so
 *   they are written once (a crash between the two loses them, never doubles them);
 * - `alert`: the admin alert's once-ever claim (`sendAdminAlertOnceEverWithTakeover`);
 * - `reported`: written once the alert went out, or reached nobody: the report
 *   is settled, and a later attempt reads it and sends nothing.
 */
export function supersededRefundReportKeys(operationId: string) {
  const base = `superseded-payment-refund-report:${operationId}`;
  return { records: `${base}:records`, alert: `${base}:alert`, reported: `${base}:reported` };
}

type ReportKeys = ReturnType<typeof supersededRefundReportKeys>;
type ReportParams = Parameters<typeof reportSupersededPaymentRefund>[0];
type ReportContext = {
  memberName: string;
  memberEmail: string;
  /** The booking OWNER, or null when it is owned by an Organisation (#3369). */
  memberId: string | null;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string | null;
  amountOwingCents: number;
};

/** Whether this row's refund was announced (#4690): its `reported` marker is held. A read, never a claim. */
export async function supersededRefundReportSettled(operationId: string): Promise<boolean> {
  const { reported } = supersededRefundReportKeys(operationId);
  return (await findHeldOnceEverAlertKeys([reported], new Date())).has(reported);
}

/**
 * #4690: THE NEXT CLAIM'S HALF. A row whose refund is already made reads
 * nothing outstanding and closes without refunding; when the refund was this
 * row's own and nobody announced it - its attempt was reaped (#4675) or
 * crashed between the refund and the notice - it is announced here, once.
 *
 * "Its own" is proved, never inferred from the outstanding figure, which
 * another door's refund of the same charge (a cancellation's, a dashboard
 * refund) also brings to zero. Stripe's refunds on the row's intent are read,
 * outside any transaction, and only one carrying exactly the metadata this
 * row's runner sends (`carriesCardRefundOperationMetadata`), made and recorded
 * in the ledger, counts. None: nothing is sent and the row closes silently, as
 * before. One the ledger does not hold as made: nothing is sent, and it is
 * logged - a false "we refunded you" is worse than none.
 */
export async function reportUnannouncedSupersededPaymentRefund(
  operation: Pick<PaymentRecoveryOperation, "id" | "type" | "idempotencyKey" | "stripeKeyPrefix" | "bookingId" | "paymentId" | "paymentIntentId">,
  format: ClubFormat,
): Promise<SupersededRefundReportOutcome | "none"> {
  if (await readOrNotSettled(operation.id, "whether it was sent could not be read", () => supersededRefundReportSettled(operation.id))) {
    return "reported";
  }
  const logContext = { operationId: operation.id, bookingId: operation.bookingId, paymentIntentId: operation.paymentIntentId };
  const refunds = await readOrNotSettled(operation.id, "Stripe's refunds on the payment could not be read", () =>
    listRefundsForPaymentIntent(operation.paymentIntentId, { timeoutMs: 10_000, singlePage: true }));
  const own = refunds.filter((refund) =>
    (!refund.payment_intent || stripeReferenceId(refund.payment_intent) === operation.paymentIntentId) &&
    carriesCardRefundOperationMetadata(operation, refund.metadata) &&
    isRecordedRefundStatus(refund.status ?? "unknown"),
  );
  if (own.length === 0) {
    logger.info(logContext, "Superseded-payment refund row found nothing outstanding and no refund of its own; closed without a notice");
    return "none";
  }
  const recorded = (await readOrNotSettled(operation.id, "the recorded refunds could not be read", () => prisma.paymentRefund.findMany({
    where: { paymentId: operation.paymentId, stripeRefundId: { in: own.map((refund) => refund.id) } },
    select: { stripeRefundId: true, amountCents: true, status: true },
  }))).filter((row) => isRecordedRefundStatus(row.status));
  if (recorded.length !== own.length) {
    logger.warn(
      { ...logContext, ownRefundIds: own.map((refund) => refund.id), recordedRefundIds: recorded.map((row) => row.stripeRefundId) },
      "Superseded-payment refund row's own Stripe refund is not recorded as made; no notice was sent",
    );
    return "none";
  }
  return reportSupersededPaymentRefund({
    format,
    operationId: operation.id,
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentIntentId: operation.paymentIntentId,
    refundedAmountCents: recorded.reduce((sum, row) => sum + row.amountCents, 0),
  });
}

/** The booking and its owner; null when there is none to address. A read that throws leaves the report unsettled. */
async function loadReportContext(params: ReportParams): Promise<ReportContext | null> {
  const { bookingId, operationId, paymentIntentId } = params;
  let booking;
  try {
    booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        checkIn: true,
        checkOut: true,
        lodgeId: true,
        finalPriceCents: true,
        member: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        // #3369: the owner may be an Organisation; bookingOwner() reads both.
        organisation: { select: { name: true, email: true } },
        // Every term of `INV-PAY-047`, because the figure below is the whole
        // outstanding and not just the ask - see the note above the function.
        payment: {
          select: {
            changeFeeCents: true,
            amountCents: true,
            refundedAmountCents: true,
            creditAppliedCents: true,
            additionalAmountCents: true,
            additionalPaymentStatus: true,
          },
        },
      },
    });
  } catch (err) {
    logger.error({ err, bookingId, operationId, paymentIntentId }, "Could not load the booking context for a superseded-payment refund's notice");
    throw new SupersededRefundReportNotSettledError(operationId, "the booking could not be read");
  }
  if (!booking || !bookingOwner(booking).member) return null;
  const owner = bookingOwner(booking).member;
  return {
    memberName: `${owner.firstName} ${owner.lastName}`,
    memberEmail: owner.email,
    memberId: owner.id ?? null,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    lodgeId: booking.lodgeId ?? null,
    amountOwingCents: booking.payment
      ? bookingOutstandingCents({ finalPriceCents: booking.finalPriceCents, ...booking.payment })
      : booking.finalPriceCents,
  };
}

/**
 * The member's email, recorded durably under the row's id for the email retry
 * worker to send (`deferDelivery`): a second call finds the row and sends
 * nothing, and a crash after the record still delivers it. A record that threw
 * may not exist, so the report is not settled.
 */
async function recordMemberNotice(params: ReportParams, context: ReportContext): Promise<void> {
  const { bookingId, operationId, paymentIntentId, refundedAmountCents, format } = params;
  try {
    await sendSupersededPaymentRefundedEmail({
      bookingId,
      recipientMemberId: bookingOwner(context).memberId,
      email: context.memberEmail,
      firstName: context.memberName.split(" ")[0] ?? context.memberName,
      checkIn: context.checkIn,
      checkOut: context.checkOut,
      refundedAmountCents,
      amountOwingCents: context.amountOwingCents,
      lodgeId: context.lodgeId,
      idempotencyKey: operationId,
    }, format);
  } catch (err) {
    logger.error({ err, bookingId, operationId, paymentIntentId }, "Failed to record the member's email about a superseded-payment refund");
    throw new SupersededRefundReportNotSettledError(operationId, "the member's email was not recorded");
  }
}

/** The audit row and the booking event, once: written only by the call that claims `records`. */
async function writeRecordsOnce(params: ReportParams, context: ReportContext | null, keys: ReportKeys): Promise<void> {
  const { bookingId, operationId, paymentId, paymentIntentId, refundedAmountCents } = params;
  const claimedAt = new Date();
  let claimed: boolean;
  try {
    claimed = await claimAlertCooldown({ key: keys.records, windowMs: ALERT_ONCE_EVER_WINDOW_MS, now: claimedAt });
  } catch (err) {
    logger.error({ err, operationId, bookingId }, "Failed to claim a superseded-payment refund's records; none were written");
    // #4679: the write may have landed; a claim held under this exact stamp is this call's own.
    await giveBackOwnOnceEverClaim({
      key: keys.records,
      label: "superseded-payment refund records",
      context: { operationId, bookingId },
      claim: { claimedAt, claimUncertain: true },
    });
    throw new SupersededRefundReportNotSettledError(operationId, "its records' claim failed");
  }
  if (!claimed) return;

  // The permanent record that money left the club, and the one record that
  // needs no booking context (`INV-OPS-012`: rows already written never move).
  logAudit({
    action: "booking.payment.superseded_payment_refunded",
    category: "payment",
    severity: "important",
    outcome: "success",
    entityType: "Booking",
    entityId: bookingId,
    targetId: bookingId,
    details: JSON.stringify({
      paymentId,
      paymentIntentId,
      refundedAmountCents,
      amountOwingAfterRefundCents: context?.amountOwingCents ?? null,
      // Spelled out rather than inferred from the action name: a reader must
      // never have to work out which way the money went.
      refundSent: true,
    }),
  });

  if (!context) {
    logAudit({
      action: "booking.payment.superseded_refund_notice_failed",
      category: "payment",
      severity: "critical",
      outcome: "failure",
      entityType: "Booking",
      entityId: bookingId,
      targetId: bookingId,
      details: JSON.stringify({
        paymentIntentId,
        refundedAmountCents,
        reason: "booking or member could not be read",
      }),
    });
    return;
  }

  const snapshot: SupersededAdditionalRefundEventSnapshot = {
    kind: SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND,
    supersededPaymentIntentId: paymentIntentId,
    refundedAmountCents,
    amountOwingAfterRefundCents: context.amountOwingCents,
  };
  // `recordBookingEvent` swallows its own failures by design; the base client is
  // deliberate - a failed INSERT inside a transaction would abort the caller's.
  await recordBookingEvent({
    bookingId,
    type: BookingEventType.REFUNDED,
    // System-initiated: no member and no admin drove this refund.
    actorMemberId: null,
    amountCents: refundedAmountCents,
    reason: SUPERSEDED_ADDITIONAL_REFUND_EVENT_REASON,
    snapshot: snapshot as unknown as Prisma.InputJsonValue,
  });
}

/**
 * The admin alert, once ever per row, by the shared sequence
 * (`sendAdminAlertOnceEverWithTakeover`, `INV-INT-032`'s rule): a call that
 * took the claim and sent it, or found nobody to receive it, writes `reported`.
 * Its own failed send, or a claim write that threw, is given back and the
 * report is not settled. A claim held elsewhere with no `reported` is a sibling
 * attempt's while younger than the stale reaper's threshold - `in-flight`, so
 * the row waits - and a dead attempt's after it: given back and sent here
 * (and waited on, if a sibling re-claims it first).
 */
async function sendAdminAlertOnce(params: ReportParams, context: ReportContext, keys: ReportKeys): Promise<SupersededRefundReportOutcome> {
  const { bookingId, operationId, paymentIntentId, refundedAmountCents, format } = params;
  const logContext = { operationId, bookingId, paymentIntentId };
  let sendReturned = false;
  const outcome = await readOrNotSettled(operationId, "the admin alert's state could not be read", () => sendAdminAlertOnceEverWithTakeover({
    key: keys.alert,
    label: "superseded-payment refund alert",
    context: logContext,
    send: async () => {
      const result = await sendAdminSupersededPaymentRefundAlert({
        memberName: context.memberName,
        checkIn: context.checkIn,
        checkOut: context.checkOut,
        refundedAmountCents,
        amountOwingCents: context.amountOwingCents,
        paymentIntentId,
        bookingId,
      }, format);
      sendReturned = true;
      await markReported(keys, logContext);
      return result;
    },
    isSent: () => supersededRefundReportSettled(operationId),
    inFlightMs: PAYMENT_RECOVERY_STALE_PROCESSING_MS,
  }));
  // A sibling that re-claimed after a takeover is still sending, too: wait for it.
  if (outcome === "in-flight" || outcome === "taken-over") return "in-flight";
  // Not kept but sent: nobody could receive it, and `reported` settles that.
  if (outcome === "settled" || sendReturned) return "reported";
  throw new SupersededRefundReportNotSettledError(operationId, "the admin alert was not sent");
}

/** The settled marker. Never throws: the alert is out, so a failed write is logged for an operator. */
async function markReported(keys: ReportKeys, logContext: Record<string, unknown>): Promise<void> {
  await claimAlertCooldown({ key: keys.reported, windowMs: ALERT_ONCE_EVER_WINDOW_MS }).catch((err) =>
    logger.error({ ...logContext, err }, "A superseded-payment refund's notice went out, but its sent marker was not written"),
  );
}
