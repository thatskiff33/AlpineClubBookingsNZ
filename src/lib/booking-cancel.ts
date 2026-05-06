import { prisma } from "./prisma";
import { cancelPaymentIntentIfCancellable, processRefund } from "./stripe";
import { isXeroConnected } from "./xero";
import {
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
} from "./cancellation";
import { sendBookingCancelledEmail } from "./email";
import { logAudit } from "./audit";
import { createCancellationCredit, restoreCreditFromBooking } from "./member-credit";
import { processWaitlistForDates } from "./waitlist";
import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import logger from "@/lib/logger";

export interface CancelBookingResult {
  success: boolean;
  refundAmountCents: number;
  refundPercentage: number;
  refundMethod: "card" | "credit";
  creditAmountCents?: number;
  creditRestoredCents?: number;
  stripeRefundId?: string;
  message: string;
}

/**
 * Shared cancellation service used by both cancel routes.
 * Handles: PENDING cancel, CONFIRMED without payment, CONFIRMED with refund
 * (Stripe + Xero credit note), promo cleanup, audit logging, email.
 */
export async function cancelBooking(
  bookingId: string,
  sessionUserId: string,
  sessionUserRole: string,
  ipAddress: string,
  refundMethod: "card" | "credit" = "card"
): Promise<
  | { status: 401; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 400; error: string }
  | { status: 200; data: CancelBookingResult }
> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true, member: true },
  });

  if (!booking) {
    return { status: 404, error: "Booking not found" };
  }

  if (booking.memberId !== sessionUserId && sessionUserRole !== "ADMIN") {
    return { status: 403, error: "Forbidden" };
  }

  if (!["PENDING", "CONFIRMED", "PAID", "WAITLISTED", "WAITLIST_OFFERED"].includes(booking.status)) {
    return {
      status: 400,
      error: "Only PENDING, CONFIRMED, PAID, WAITLISTED, or WAITLIST_OFFERED bookings can be cancelled",
    };
  }

  // Handle WAITLISTED / WAITLIST_OFFERED bookings (no payment taken)
  if (booking.status === "WAITLISTED" || booking.status === "WAITLIST_OFFERED") {
    const wasOffered = booking.status === "WAITLIST_OFFERED";

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: "CANCELLED",
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistPosition: null,
      },
    });
    await cleanupPromoRedemption(bookingId);

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details: `Waitlisted booking cancelled (was ${wasOffered ? "WAITLIST_OFFERED" : "WAITLISTED"})`,
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      0,
      "card"
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email for waitlisted booking"));

    // If the booking was WAITLIST_OFFERED, re-process waitlist for these dates
    if (wasOffered) {
      processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
        .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after offer cancellation"));
    }

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card" as const,
        message: "Waitlisted booking cancelled successfully",
      },
    };
  }

  // Handle PENDING bookings (no payment taken yet)
  if (booking.status === "PENDING") {
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });
    await cleanupPromoRedemption(bookingId);

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details: "Pending booking cancelled, no payment taken",
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      0
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after pending cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card",
        message: "Pending booking cancelled. No payment was taken.",
      },
    };
  }

  // Handle CONFIRMED/PAID bookings without successful payment
  if (!booking.payment || booking.payment.status !== "SUCCEEDED") {
    if (booking.payment) {
      await cancelOutstandingPaymentIntents({
        primaryPaymentIntentId: booking.payment.stripePaymentIntentId,
        additionalPaymentIntentId: booking.payment.additionalPaymentIntentId,
        cancelPrimary: true,
        cancelAdditional: hasOutstandingAdditionalPaymentIntent(booking.payment),
      });
    }

    const paymentUpdateData: {
      status: "FAILED";
      additionalPaymentStatus?: string;
    } = {
      status: "FAILED",
    };

    if (hasOutstandingAdditionalPaymentIntent(booking.payment)) {
      paymentUpdateData.additionalPaymentStatus = "FAILED";
    }

    if (booking.payment) {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: booking.payment.id },
          data: paymentUpdateData,
        }),
        prisma.booking.update({
          where: { id: bookingId },
          data: { status: "CANCELLED" },
        }),
      ]);
    } else {
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      });
    }
    await cleanupPromoRedemption(bookingId);

    const xeroClearingAmountCents = booking.payment?.xeroInvoiceId
      ? Math.max(
          booking.payment.amountCents - booking.payment.refundedAmountCents,
          booking.finalPriceCents + booking.payment.changeFeeCents
        )
      : 0;

    if (booking.payment?.id && xeroClearingAmountCents > 0) {
      try {
        const queuedCreditNote = await enqueueXeroModificationCreditNoteOperation(
          {
            bookingId,
            refundAmountCents: xeroClearingAmountCents,
          },
          {
            createdByMemberId: sessionUserId,
          }
        );

        if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
          void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
            logger.error(
              { err: xeroErr, bookingId, paymentId: booking.payment?.id },
              "Failed to kick Xero invoice-clearing credit note outbox worker"
            );
          });
        }
      } catch (xeroErr) {
        logger.error(
          {
            err: xeroErr,
            bookingId,
            paymentId: booking.payment.id,
            xeroClearingAmountCents,
          },
          "Failed to queue Xero invoice-clearing credit note for cancelled unpaid booking"
        );
      }
    }

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details:
        xeroClearingAmountCents > 0
          ? `Confirmed booking cancelled before payment capture; queued Xero credit note for ${xeroClearingAmountCents} cents to clear the outstanding invoice`
          : "Confirmed booking cancelled, no payment to refund",
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      0
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after confirmed cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card",
        message:
          xeroClearingAmountCents > 0
            ? "Booking cancelled. Any outstanding Xero invoice balance is being cleared."
            : "Booking cancelled. No refund applicable.",
      },
    };
  }

  // Restore any previously applied credit regardless of refund method
  let creditRestoredCents = 0;
  if (booking.payment.creditAppliedCents > 0) {
    creditRestoredCents = await restoreCreditFromBooking(
      booking.memberId,
      bookingId
    );
    logger.info(
      { bookingId, creditRestoredCents },
      "Restored previously applied credit on cancellation"
    );
  }

  // Calculate refund based on cancellation policy
  // Change fees (from prior booking modifications) are non-refundable per FEE-03
  const paidAmountCents =
    booking.payment.amountCents - booking.payment.refundedAmountCents;
  const refundableBaseCents = paidAmountCents - booking.payment.changeFeeCents;
  const days = daysUntilDate(booking.checkIn);
  const policy = await loadCancellationPolicy(booking.checkIn);
  const { refundAmountCents, refundPercentage } = calculateRefundAmount(
    refundableBaseCents,
    days,
    policy,
    refundMethod
  );
  const shouldFailAdditionalPayment = hasOutstandingAdditionalPaymentIntent(booking.payment);

  if (shouldFailAdditionalPayment) {
    await cancelOutstandingPaymentIntents({
      primaryPaymentIntentId: null,
      additionalPaymentIntentId: booking.payment.additionalPaymentIntentId,
      cancelPrimary: false,
      cancelAdditional: true,
    });
  }

  // Process refund based on method
  if (refundAmountCents > 0 && refundMethod === "credit") {
    // ── Credit path: skip Stripe, create MemberCredit record ──────────
    const paymentId = booking.payment.id;

    const newRefundedTotal =
      booking.payment.refundedAmountCents + refundAmountCents;
    const newStatus =
      newRefundedTotal >= booking.payment.amountCents
        ? "REFUNDED"
        : "PARTIALLY_REFUNDED";

    await prisma.$transaction([
      prisma.payment.update({
        where: { bookingId: booking.id },
        data: {
          refundedAmountCents: newRefundedTotal,
          status: newStatus,
          ...(shouldFailAdditionalPayment
            ? { additionalPaymentStatus: "FAILED" }
            : {}),
        },
      }),
      prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      }),
    ]);

    // Create the local credit ledger entry immediately, then queue the
    // Xero-side open credit note as background work.
    await createCancellationCredit(
      booking.memberId,
      refundAmountCents,
      bookingId
    );

    try {
      const queuedCreditNote = await enqueueXeroAccountCreditNoteOperation(
        paymentId,
        refundAmountCents,
        {
          createdByMemberId: sessionUserId,
        }
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, bookingId, paymentId },
            "Failed to kick Xero account-credit note outbox worker"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId, paymentId },
        "Failed to queue unapplied Xero credit note"
      );
    }

    await cleanupPromoRedemption(bookingId);

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details: booking.payment.changeFeeCents > 0
        ? `Credit ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${booking.payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents as account credit`
        : `Credit ${refundPercentage}% = ${refundAmountCents} cents as account credit`,
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      refundAmountCents,
      "credit"
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after credit cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        refundMethod: "credit",
        creditAmountCents: refundAmountCents,
        creditRestoredCents: creditRestoredCents || undefined,
        message: `Booking cancelled. ${refundPercentage}% credit of $${(refundAmountCents / 100).toFixed(2)} added to your account.`,
      },
    };
  }

  // ── Card path: Stripe refund (existing flow) ──────────────────────
  if (refundAmountCents > 0 && booking.payment.stripePaymentIntentId) {
    const paymentId = booking.payment.id;
    const refund = await processRefund({
      paymentIntentId: booking.payment.stripePaymentIntentId,
      amountCents: refundAmountCents,
      metadata: {
        bookingId: booking.id,
        reason: "cancellation",
        refundPercentage: refundPercentage.toString(),
      },
    });

    const newRefundedTotal =
      booking.payment.refundedAmountCents + refundAmountCents;
    const newStatus =
      newRefundedTotal >= booking.payment.amountCents
        ? "REFUNDED"
        : "PARTIALLY_REFUNDED";

    await prisma.$transaction([
      prisma.payment.update({
        where: { bookingId: booking.id },
        data: {
          refundedAmountCents: newRefundedTotal,
          status: newStatus,
          ...(shouldFailAdditionalPayment
            ? { additionalPaymentStatus: "FAILED" }
            : {}),
        },
      }),
      prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      }),
    ]);

    // Queue the Xero credit note durably (allocated against the original invoice).
    try {
      const queuedCreditNote = await enqueueXeroRefundCreditNoteOperation(
        paymentId,
        refundAmountCents,
        {
          createdByMemberId: sessionUserId,
        }
      );

      if (queuedCreditNote.queueOperationId && (await isXeroConnected())) {
        void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((xeroErr) => {
          logger.error(
            { err: xeroErr, bookingId, paymentId },
            "Failed to kick Xero refund credit note outbox worker"
          );
        });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId, paymentId },
        "Failed to queue Xero credit note"
      );
    }

    await cleanupPromoRedemption(bookingId);

    logAudit({
      action: "booking.cancel",
      memberId: sessionUserId,
      targetId: bookingId,
      details: booking.payment.changeFeeCents > 0
        ? `Refund ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${booking.payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents`
        : `Refund ${refundPercentage}% = ${refundAmountCents} cents`,
      ipAddress,
    });

    sendBookingCancelledEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      refundAmountCents,
      "card"
    ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

    // Trigger waitlist processing for freed dates
    processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
      .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after card refund cancellation"));

    return {
      status: 200,
      data: {
        success: true,
        refundAmountCents,
        refundPercentage,
        refundMethod: "card",
        creditRestoredCents: creditRestoredCents || undefined,
        stripeRefundId: refund.id,
        message: `Booking cancelled. ${refundPercentage}% refund of $${(refundAmountCents / 100).toFixed(2)} processed.`,
      },
    };
  }

  // No refund (0% policy or no payment intent)
  if (shouldFailAdditionalPayment) {
    await prisma.$transaction([
      prisma.payment.update({
        where: { bookingId: booking.id },
        data: { additionalPaymentStatus: "FAILED" },
      }),
      prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      }),
    ]);
  } else {
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });
  }
  await cleanupPromoRedemption(bookingId);

  logAudit({
    action: "booking.cancel",
    memberId: sessionUserId,
    targetId: bookingId,
    details: "No refund per cancellation policy",
    ipAddress,
  });

  sendBookingCancelledEmail(
    booking.member.email,
    booking.member.firstName,
    booking.checkIn,
    booking.checkOut,
    0,
    "card"
  ).catch((err) => logger.error({ err, bookingId }, "Failed to send cancellation email"));

  // Trigger waitlist processing for freed dates
  processWaitlistForDates({ checkIn: booking.checkIn, checkOut: booking.checkOut })
    .catch((err) => logger.error({ err, bookingId }, "Failed to process waitlist after no-refund cancellation"));

  return {
    status: 200,
    data: {
      success: true,
      refundAmountCents: 0,
      refundPercentage: 0,
      refundMethod: "card",
      creditRestoredCents: creditRestoredCents || undefined,
      message:
        "Booking cancelled. No refund applicable per cancellation policy.",
    },
  };
}

function hasOutstandingAdditionalPaymentIntent(
  payment:
    | {
        additionalPaymentIntentId?: string | null;
        additionalPaymentStatus?: string | null;
      }
    | null
    | undefined
) {
  return Boolean(
    payment?.additionalPaymentIntentId &&
      payment.additionalPaymentStatus !== "SUCCEEDED" &&
      payment.additionalPaymentStatus !== "FAILED"
  );
}

async function cancelOutstandingPaymentIntents({
  primaryPaymentIntentId,
  additionalPaymentIntentId,
  cancelPrimary,
  cancelAdditional,
}: {
  primaryPaymentIntentId?: string | null;
  additionalPaymentIntentId?: string | null;
  cancelPrimary: boolean;
  cancelAdditional: boolean;
}) {
  const paymentIntentIds = new Set<string>();

  if (cancelPrimary && primaryPaymentIntentId) {
    paymentIntentIds.add(primaryPaymentIntentId);
  }

  if (cancelAdditional && additionalPaymentIntentId) {
    paymentIntentIds.add(additionalPaymentIntentId);
  }

  for (const paymentIntentId of paymentIntentIds) {
    try {
      await cancelPaymentIntentIfCancellable(paymentIntentId);
    } catch (err) {
      logger.error(
        { err, paymentIntentId },
        "Failed to cancel Stripe PaymentIntent for cancelled booking"
      );
      throw err;
    }
  }
}

/**
 * Clean up promo redemption if booking used a promo code.
 */
async function cleanupPromoRedemption(bookingId: string) {
  const redemption = await prisma.promoRedemption.findUnique({
    where: { bookingId },
  });
  if (redemption) {
    await prisma.$transaction([
      prisma.promoRedemption.delete({ where: { id: redemption.id } }),
      prisma.promoCode.update({
        where: { id: redemption.promoCodeId },
        data: { currentRedemptions: { decrement: 1 } },
      }),
    ]);
  }
}
