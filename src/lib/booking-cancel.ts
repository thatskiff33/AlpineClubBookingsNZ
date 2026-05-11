import { prisma } from "./prisma";
import { cancelPaymentIntentIfCancellable, cancelSetupIntentIfCancellable } from "./stripe";
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
import {
  applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed,
  refundPaymentTransactions,
} from "@/lib/payment-transactions";

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

  if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID", "WAITLISTED", "WAITLIST_OFFERED"].includes(booking.status)) {
    return {
      status: 400,
      error: "Only PENDING, PAYMENT_PENDING, CONFIRMED, PAID, WAITLISTED, or WAITLIST_OFFERED bookings can be cancelled",
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

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details: `Waitlisted booking cancelled (was ${wasOffered ? "WAITLIST_OFFERED" : "WAITLISTED"})`,
      ipAddress,
      metadata: { wasOffered },
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
    if (booking.payment?.stripeSetupIntentId) {
      try {
        await cancelSetupIntentIfCancellable(booking.payment.stripeSetupIntentId);
      } catch (err) {
        logger.error(
          { err, bookingId, setupIntentId: booking.payment.stripeSetupIntentId },
          "Failed to cancel Stripe SetupIntent for cancelled pending booking"
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      if (booking.payment) {
        await tx.payment.update({
          where: { id: booking.payment.id },
          data: { stripeSetupIntentId: null },
        });
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" },
      });
    });
    await cleanupPromoRedemption(bookingId);

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details: "Pending booking cancelled, no payment taken",
      ipAddress,
      metadata: {
        paymentTaken: false,
        setupIntentCancelled: Boolean(booking.payment?.stripeSetupIntentId),
      },
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

  // Handle PAYMENT_PENDING/CONFIRMED/PAID bookings without successful payment
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

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details:
        xeroClearingAmountCents > 0
          ? `Confirmed booking cancelled before payment capture; queued Xero credit note for ${xeroClearingAmountCents} cents to clear the outstanding invoice`
          : "Confirmed booking cancelled, no payment to refund",
      ipAddress,
      metadata: {
        paymentTaken: false,
        xeroClearingAmountCents,
        queuedXeroClearingCreditNote: xeroClearingAmountCents > 0,
      },
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

    if (booking.payment.additionalPaymentIntentId) {
      await markPaymentIntentTransactionFailed({
        paymentIntentId: booking.payment.additionalPaymentIntentId,
      });
    }
  }

  // Process refund based on method
  if (refundAmountCents > 0 && refundMethod === "credit") {
    // ── Credit path: skip Stripe, create MemberCredit record ──────────
    const paymentId = booking.payment.id;

    await applyLocalRefundAllocation({
      paymentId,
      amountCents: refundAmountCents,
    });
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });

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

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details: booking.payment.changeFeeCents > 0
        ? `Credit ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${booking.payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents as account credit`
        : `Credit ${refundPercentage}% = ${refundAmountCents} cents as account credit`,
      ipAddress,
      metadata: {
        refundMethod: "credit",
        refundAmountCents,
        refundPercentage,
        refundableBaseCents,
        changeFeeCents: booking.payment.changeFeeCents,
        creditRestoredCents,
      },
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
  if (refundAmountCents > 0) {
    const paymentId = booking.payment.id;
    const refundResult = await refundPaymentTransactions({
      paymentId,
      amountCents: refundAmountCents,
      metadata: {
        bookingId: booking.id,
        reason: "cancellation",
        refundPercentage: refundPercentage.toString(),
      },
      idempotencyKeyPrefix: `booking_cancel_refund_${booking.id}`,
    });
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: "CANCELLED" },
    });

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

    logBookingCancellationAudit({
      booking,
      bookingId,
      sessionUserId,
      details: booking.payment.changeFeeCents > 0
        ? `Refund ${refundPercentage}% of ${refundableBaseCents} cents (excluding ${booking.payment.changeFeeCents} cents change fee) = ${refundAmountCents} cents`
        : `Refund ${refundPercentage}% = ${refundAmountCents} cents`,
      ipAddress,
      metadata: {
        refundMethod: "card",
        refundAmountCents,
        refundPercentage,
        refundableBaseCents,
        changeFeeCents: booking.payment.changeFeeCents,
        creditRestoredCents,
        stripeRefundId: refundResult.refunds[0]?.refundId ?? null,
      },
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
        stripeRefundId: refundResult.refunds[0]?.refundId,
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

  logBookingCancellationAudit({
    booking,
    bookingId,
    sessionUserId,
    details: "No refund per cancellation policy",
    ipAddress,
    metadata: {
      refundAmountCents: 0,
      refundPercentage,
      refundMethod: "card",
      creditRestoredCents,
      failedOutstandingAdditionalPayment: shouldFailAdditionalPayment,
    },
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

type CancellationAuditBooking = {
  memberId: string;
  status: string;
  checkIn: Date;
  checkOut: Date;
  payment?: {
    id?: string | null;
    status?: string | null;
    amountCents?: number | null;
    refundedAmountCents?: number | null;
    changeFeeCents?: number | null;
    creditAppliedCents?: number | null;
  } | null;
};

function logBookingCancellationAudit({
  booking,
  bookingId,
  sessionUserId,
  details,
  ipAddress,
  metadata,
}: {
  booking: CancellationAuditBooking;
  bookingId: string;
  sessionUserId: string;
  details: string;
  ipAddress: string;
  metadata?: Record<string, unknown>;
}) {
  logAudit({
    action: "booking.cancel",
    memberId: sessionUserId,
    targetId: bookingId,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: bookingId,
    category: "booking",
    severity: "critical",
    outcome: "success",
    summary: "Booking cancelled",
    details,
    metadata: {
      statusBefore: booking.status,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
      paymentId: booking.payment?.id ?? null,
      paymentStatus: booking.payment?.status ?? null,
      paidAmountCents: booking.payment?.amountCents ?? null,
      refundedAmountCents: booking.payment?.refundedAmountCents ?? null,
      creditAppliedCents: booking.payment?.creditAppliedCents ?? null,
      ...metadata,
    },
    ipAddress,
  });
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
      await markPaymentIntentTransactionFailed({ paymentIntentId });
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
