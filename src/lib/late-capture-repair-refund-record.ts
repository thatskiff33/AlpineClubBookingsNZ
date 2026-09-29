import { PaymentTransactionKind } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import {
  announceAutomaticLateCaptureRefund,
  recordAutomaticLateCaptureRefund,
  type CancelledBookingLateCapture,
} from "@/lib/cancelled-booking-late-capture";
import type { ClubFormat } from "@/lib/club-format";
import { noteLateCaptureRefunds } from "@/lib/late-capture-refund-credit-note";
import { readLateCaptureXeroReceipt } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** What was recorded, and what Xero is told, for each late capture the repair tool refunded. */
export interface RepairedLateCaptureXeroOutcome {
  /**
   * The webhook's record could not be written (its `critical` audit row names
   * it): the intent is not a known late capture, so it is not noted (#3635 N4).
   */
  recordFailed: string[];
  /**
   * The record's double-payment signal (`handCompletedAfterRefund`): an
   * operator hand-completed the capture's refund task while this refund ran.
   * Escalated exactly as the webhook does.
   */
  doubleRefundSuspected: string[];
  /** The capture's own Xero receipt exists and its refund note was QUEUED now. */
  noted: string[];
  /** A receipt exists, but every refunded cent is already noted: nothing queued. */
  alreadyNoted: string[];
  /** A receipt exists, but the note could not be queued (logged): raise it by hand. */
  noteFailed: string[];
  /** An officer recorded the receipt by hand: its refund is recorded by hand too. */
  byHand: string[];
  /** Xero never received the capture: no note, since none may name it. */
  notInXero: string[];
}

/**
 * #3635 (composed review C2, `INV-PAY-110`): the repair tool's late-capture
 * refund is recorded and noted in Xero exactly as the webhook's automatic
 * refund is.
 *
 *  1. FIRST, per refunded intent, the webhook's own record
 *     (`recordAutomaticLateCaptureRefund`, the automatic-refund record row). That row is
 *     what makes the intent a KNOWN late capture (`findLateCapturePaymentIntents`),
 *     so the note-eligible cash (`resolveRefundNoteEligibleCash`) leaves its
 *     refund out and no payment-wide note or nightly self-heal can name the
 *     booking's cleared invoice for it.
 *  2. THEN each capture is noted through `noteLateCaptureRefunds`, per capture
 *     and only against a receipt the app recorded in Xero. A capture the cancel
 *     cleared and Xero never received gets no note: one would be settled by a
 *     Stripe-account refund of money that never came into the Stripe account.
 *
 * Never throws for a record or note failure (the money has already gone back):
 * the record writer audits its own failure at `critical`, and the note writer
 * logs. Provider calls stay in the outbox worker. The outcome says, per
 * intent, what really happened (#3635 N4), so the operator's result message
 * claims no record and no note that was not written, and a suspected double
 * payment reaches the same critical audit row and conflict alert the webhook
 * raises (`announceAutomaticLateCaptureRefund`).
 */
export async function recordAndNoteRepairedLateCaptureRefunds(params: {
  bookingId: string;
  paymentId: string;
  refunds: ReadonlyArray<{ paymentIntentId: string; amountCents: number }>;
  format: ClubFormat;
}): Promise<RepairedLateCaptureXeroOutcome> {
  const { bookingId, paymentId, format } = params;
  const refundedByIntent = new Map<string, number>();
  for (const refund of params.refunds) {
    if (!refund.paymentIntentId || refund.amountCents <= 0) continue;
    refundedByIntent.set(
      refund.paymentIntentId,
      (refundedByIntent.get(refund.paymentIntentId) ?? 0) + refund.amountCents,
    );
  }
  const outcome: RepairedLateCaptureXeroOutcome = {
    recordFailed: [],
    doubleRefundSuspected: [],
    noted: [],
    alreadyNoted: [],
    noteFailed: [],
    byHand: [],
    notInXero: [],
  };
  const recordedIntents: string[] = [];
  if (refundedByIntent.size === 0) return outcome;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: true, organisation: { select: { name: true, email: true } } },
  });
  for (const [paymentIntentId, amountCents] of refundedByIntent) {
    const transaction = await prisma.paymentTransaction.findFirst({
      where: { paymentId, stripePaymentIntentId: paymentIntentId },
      select: { kind: true },
    });
    const capture: CancelledBookingLateCapture = {
      bookingId,
      paymentId,
      paymentIntentId,
      amountCents,
      memberName: readMemberName(booking),
      checkIn: booking?.checkIn ?? new Date(0),
      checkOut: booking?.checkOut ?? new Date(0),
      openingDeletedAt: booking?.deletedAt ?? null,
      captureKind:
        transaction?.kind === PaymentTransactionKind.ADDITIONAL ? "modification" : "primary",
    };
    const record = await recordAutomaticLateCaptureRefund(capture);
    if (!record.recorded) {
      outcome.recordFailed.push(paymentIntentId);
      continue;
    }
    recordedIntents.push(paymentIntentId);
    if (record.handCompletedAfterRefund) {
      outcome.doubleRefundSuspected.push(paymentIntentId);
      // Only the conflict arm is reached (the flag is set), so no ordinary
      // "refunded automatically" email goes to an operator who ran the repair.
      await announceAutomaticLateCaptureRefund(capture, record, format).catch((err) =>
        logger.error(
          { err, bookingId, paymentId, paymentIntentId },
          "Failed to escalate a suspected double refund found by the late-capture repair",
        ),
      );
    }
  }

  for (const paymentIntentId of recordedIntents) {
    const receipt = await readLateCaptureXeroReceipt(paymentIntentId);
    if (receipt.kind === "recorded") {
      const note = await noteLateCaptureRefunds({ paymentId, paymentIntentId });
      if (note === "queued") outcome.noted.push(paymentIntentId);
      else if (note === "nothing-owed") outcome.alreadyNoted.push(paymentIntentId);
      else outcome.noteFailed.push(paymentIntentId);
    } else if (receipt.kind === "resolved-by-hand") {
      outcome.byHand.push(paymentIntentId);
    } else {
      outcome.notInXero.push(paymentIntentId);
    }
  }
  return outcome;
}

function readMemberName(
  booking: {
    memberId: string | null;
    member: { firstName: string; lastName: string } | null;
    organisation: { name: string; email: string | null } | null;
  } | null,
): string {
  if (!booking) return "unknown member";
  try {
    const owner = bookingOwner(booking);
    return `${owner.member.firstName} ${owner.member.lastName}`.trim();
  } catch (err) {
    logger.warn({ err }, "Repaired late-capture refund has no readable booking owner");
    return "unknown member";
  }
}
