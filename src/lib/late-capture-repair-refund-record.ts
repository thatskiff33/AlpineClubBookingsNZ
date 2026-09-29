import { PaymentTransactionKind } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import {
  recordAutomaticLateCaptureRefund,
  type CancelledBookingLateCapture,
} from "@/lib/cancelled-booking-late-capture";
import { noteLateCaptureRefunds } from "@/lib/late-capture-refund-credit-note";
import { readLateCaptureXeroReceipt } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** What Xero is told about each late capture the repair tool refunded. */
export interface RepairedLateCaptureXeroOutcome {
  /** The capture's own Xero receipt exists: its refund note was queued. */
  noted: string[];
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
 *     (`recordAutomaticLateCaptureRefund`, the #2760/#2773 row). That row is
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
 * logs. Provider calls stay in the outbox worker.
 */
export async function recordAndNoteRepairedLateCaptureRefunds(params: {
  bookingId: string;
  paymentId: string;
  refunds: ReadonlyArray<{ paymentIntentId: string; amountCents: number }>;
}): Promise<RepairedLateCaptureXeroOutcome> {
  const { bookingId, paymentId } = params;
  const refundedByIntent = new Map<string, number>();
  for (const refund of params.refunds) {
    if (!refund.paymentIntentId || refund.amountCents <= 0) continue;
    refundedByIntent.set(
      refund.paymentIntentId,
      (refundedByIntent.get(refund.paymentIntentId) ?? 0) + refund.amountCents,
    );
  }
  const outcome: RepairedLateCaptureXeroOutcome = { noted: [], byHand: [], notInXero: [] };
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
    await recordAutomaticLateCaptureRefund(capture);
  }

  for (const paymentIntentId of refundedByIntent.keys()) {
    const receipt = await readLateCaptureXeroReceipt(paymentIntentId);
    if (receipt.kind === "recorded") {
      await noteLateCaptureRefunds({ paymentId, paymentIntentId });
      outcome.noted.push(paymentIntentId);
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
