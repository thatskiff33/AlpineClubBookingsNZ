import { BookingEventType, Prisma } from "@prisma/client";

import { outstandingAdditionalAskCents } from "@/lib/additional-payment-ask";
import { logAudit } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import { sendAdminSupersededPaymentRefundAlert } from "@/lib/email/admin-alerts-finance";
import { sendSupersededPaymentRefundedEmail } from "@/lib/email/booking";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND,
  SUPERSEDED_ADDITIONAL_REFUND_EVENT_REASON,
  type SupersededAdditionalRefundEventSnapshot,
} from "@/lib/superseded-additional-refund-event";

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
 * IT NEVER THROWS INTO THE RECOVERY WORKER. By the time it runs the refund has
 * already been made at Stripe and the operation is about to close; letting a
 * mail provider or a narrative write fail the operation would replay the whole
 * refund path for a bookkeeping row. Every step is individually caught, and a
 * failure of the records themselves is escalated as its own `critical` audit
 * row, the same arrangement `recordAutomaticLateCaptureRefund` uses and for the
 * same reasons.
 *
 * THE AMOUNT OWING IS READ, NOT DERIVED HERE. It comes from
 * `outstandingAdditionalAskCents` over the reconciled `Payment` row, so the
 * member's mail, the admin's alert and the booking page cannot quote three
 * different numbers at each other (`INV-SSOT-001`). The caller reconciles the
 * payment aggregates BEFORE calling this, which is what makes the figure the
 * post-refund one.
 */
export async function reportSupersededPaymentRefund(params: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  refundedAmountCents: number;
}): Promise<void> {
  const { bookingId, paymentId, paymentIntentId, refundedAmountCents } = params;

  let context: {
    memberName: string;
    memberEmail: string;
    memberId: string;
    checkIn: Date;
    checkOut: Date;
    lodgeId: string | null;
    amountOwingCents: number;
  } | null = null;

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        checkIn: true,
        checkOut: true,
        lodgeId: true,
        member: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        payment: {
          select: {
            additionalAmountCents: true,
            additionalPaymentStatus: true,
          },
        },
      },
    });
    if (booking?.member) {
      context = {
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        memberEmail: booking.member.email,
        memberId: booking.member.id,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        lodgeId: booking.lodgeId ?? null,
        amountOwingCents: outstandingAdditionalAskCents(booking.payment),
      };
    }
  } catch (err) {
    logger.error(
      { err, bookingId, paymentId, paymentIntentId },
      "Could not load the booking context for a superseded-payment refund; the audit row still records the refund",
    );
  }

  // Written FIRST and unconditionally. It is the only record that does not
  // depend on the read above having succeeded, so it is the one that must not be
  // downstream of anything (`INV-OPS-012`: rows already written never move).
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

  await sendSupersededPaymentRefundedEmail({
    bookingId,
    recipientMemberId: context.memberId,
    email: context.memberEmail,
    firstName: context.memberName.split(" ")[0] ?? context.memberName,
    checkIn: context.checkIn,
    checkOut: context.checkOut,
    refundedAmountCents,
    amountOwingCents: context.amountOwingCents,
    lodgeId: context.lodgeId,
  }).catch((err) =>
    logger.error(
      { err, bookingId, paymentIntentId },
      "Failed to email the member about a superseded-payment refund",
    ),
  );

  await sendAdminSupersededPaymentRefundAlert({
    memberName: context.memberName,
    checkIn: context.checkIn,
    checkOut: context.checkOut,
    refundedAmountCents,
    amountOwingCents: context.amountOwingCents,
    paymentIntentId,
    bookingId,
  }).catch((err) =>
    logger.error(
      { err, bookingId, paymentIntentId },
      "Failed to alert admins about a superseded-payment refund",
    ),
  );
}
