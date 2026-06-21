import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  BookingGuestRemovalError,
  removeBookingGuestInTransaction,
} from "@/lib/booking-guest-removal-service";
import { refundPaymentTransactions } from "@/lib/payment-transactions";
import { enqueueBookingModificationRefundRecovery } from "@/lib/payment-recovery";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; guestId: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId, guestId } = await params;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  try {
    const result = await prisma.$transaction((tx) =>
      removeBookingGuestInTransaction({
        tx,
        bookingId,
        guestId,
        actorMemberId: session.user.id,
        actorRole: session.user.role,
      })
    );

    // Process Stripe refund outside transaction (avoids holding advisory lock during API call)
    let stripeRefundId: string | undefined;
    if (result.refundAmountCents > 0 && result.paymentId) {
      try {
        const refundResult = await refundPaymentTransactions({
          paymentId: result.paymentId,
          amountCents: result.refundAmountCents,
          metadata: { bookingId, reason: "guest_removed_price_decrease" },
          idempotencyKeyPrefix: `guest_remove_refund_${bookingId}`,
        });
        stripeRefundId = refundResult.refunds[0]?.refundId;
      } catch (refundErr) {
        logger.error({ err: refundErr, bookingId, amount: result.refundAmountCents },
          "Stripe refund failed after guest removal - enqueuing durable recovery");
        // Match the booking-modification settlement path: enqueue a durable,
        // admin-visible REFUND_BOOKING_MODIFICATION recovery operation so the
        // refund is retried instead of silently needing manual reconciliation
        // (issue #818). Idempotent on the booking modification id.
        try {
          await enqueueBookingModificationRefundRecovery({
            bookingId,
            paymentId: result.paymentId,
            bookingModificationId: result.bookingModificationId,
            amountCents: result.refundAmountCents,
          });
        } catch (recoveryErr) {
          logger.error(
            { err: recoveryErr, bookingId, amount: result.refundAmountCents },
            "Failed to enqueue guest-removal refund recovery - manual reconciliation required",
          );
        }
      }
    }

    // Audit log
    logAudit({
      action: "booking.modify.guests.remove",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: result.booking.memberId,
      entityType: "BookingModification",
      entityId: result.bookingModificationId,
      category: "booking",
      outcome: "success",
      summary: "Booking guest removed",
      details: JSON.stringify({
        removedGuest: `${result.removedGuest.firstName} ${result.removedGuest.lastName}`,
        priceDiffCents: result.priceDiffCents,
        refundAmountCents: result.refundAmountCents,
        choreWarnings: result.choreWarnings,
      }),
      metadata: {
        bookingId,
        removedGuest: `${result.removedGuest.firstName} ${result.removedGuest.lastName}`,
        priceDiffCents: result.priceDiffCents,
        refundAmountCents: result.refundAmountCents,
        choreWarnings: result.choreWarnings,
        newGuestCount: result.booking.guests.length,
      },
      ipAddress,
    });

    void queueXeroBookingEditSettlement({
      bookingId,
      bookingModificationId: result.bookingModificationId,
      createdByMemberId: session.user.id,
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      originalPaymentStatus: result.paymentStatus,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: 0,
      datesChanged: false,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to queue Xero settlement for guest removal")
    );

    // Send email
    const member = await prisma.member.findUnique({
      where: { id: result.booking.memberId },
    });
    if (member) {
      sendBookingModifiedEmail({
        email: member.email,
        firstName: member.firstName,
        modificationType: "GUEST_REMOVE",
        oldCheckIn: result.booking.checkIn,
        oldCheckOut: result.booking.checkOut,
        newCheckIn: result.booking.checkIn,
        newCheckOut: result.booking.checkOut,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
        newFinalPriceCents: result.booking.finalPriceCents,
        changeFeeCents: 0,
        refundAmountCents: result.refundAmountCents,
        additionalAmountCents: 0,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send booking modified email")
      );
    }

    return NextResponse.json({
      booking: result.booking,
      removedGuest: result.removedGuest,
      priceDiffCents: result.priceDiffCents,
      refundAmountCents: result.refundAmountCents,
      stripeRefundId: stripeRefundId ?? null,
      promoRemoved: result.promoRemoved,
      choreWarnings: result.choreWarnings,
    });
  } catch (err) {
    if (err instanceof BookingGuestRemovalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message =
      err instanceof Error ? err.message : "Failed to remove guest";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
