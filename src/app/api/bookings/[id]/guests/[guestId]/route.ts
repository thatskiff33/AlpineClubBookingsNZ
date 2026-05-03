import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  calculatePromoDiscountForGuestRates,
  getMemberFreeNightsUsed,
  validatePromoCodeRules,
} from "@/lib/promo";
import { processRefund } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import {
  enqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";

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
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          guests: true,
          payment: true,
          member: true,
          promoRedemption: {
            include: {
              promoCode: {
                include: { assignments: { select: { memberId: true } } },
              },
            },
          },
        },
      });

      if (!booking) {
        throw new ApiError("Booking not found", 404);
      }

      if (
        booking.memberId !== session.user.id &&
        session.user.role !== "ADMIN"
      ) {
        throw new ApiError("Forbidden", 403);
      }

      if (!["PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
        throw new ApiError(
          "Only PENDING, CONFIRMED, or PAID bookings can be modified",
          400
        );
      }

      const guestToRemove = booking.guests.find((g) => g.id === guestId);
      if (!guestToRemove) {
        throw new ApiError("Guest not found on this booking", 404);
      }

      if (booking.guests.length <= 1) {
        throw new ApiError(
          "Cannot remove the last guest. Cancel the booking instead.",
          400
        );
      }

      // Check for chore assignments on the guest
      const choreWarnings: string[] = [];
      const guestAssignments = await tx.choreAssignment.findMany({
        where: { bookingGuestId: guestId },
        include: { choreTemplate: true },
      });

      for (const assignment of guestAssignments) {
        if (
          assignment.status === "CONFIRMED" ||
          assignment.status === "COMPLETED"
        ) {
          choreWarnings.push(
            `${assignment.choreTemplate.name} on ${assignment.date.toISOString().split("T")[0]} was ${assignment.status}`
          );
        }
      }

      // Delete chore assignments for this guest
      await tx.choreAssignment.deleteMany({
        where: { bookingGuestId: guestId },
      });

      // Delete the guest
      await tx.bookingGuest.delete({ where: { id: guestId } });

      // Recalculate price with remaining guests
      const remainingGuests = booking.guests.filter((g) => g.id !== guestId);

      const seasons = await tx.season.findMany({
        where: { active: true },
        include: { rates: true },
      });

      const seasonRateData: SeasonRateData[] = seasons.map((s) => ({
        seasonId: s.id,
        startDate: s.startDate,
        endDate: s.endDate,
        rates: s.rates.map((r) => ({
          ageTier: r.ageTier,
          isMember: r.isMember,
          pricePerNightCents: r.pricePerNightCents,
        })),
      }));

      const guestsForPricing = remainingGuests.map((g) => ({
        ageTier: g.ageTier as AgeTier,
        isMember: g.isMember,
        memberId: g.memberId ?? null,
      }));

      const priceBreakdown = calculateBookingPrice(
        booking.checkIn,
        booking.checkOut,
        guestsForPricing,
        seasonRateData
      );
      const guestNightRates = guestsForPricing.map((guest, index) => ({
        memberId: guest.memberId ?? null,
        perNightRates: priceBreakdown.guests[index].perNightCents,
      }));

      const newTotalPriceCents = priceBreakdown.totalPriceCents;

      // Handle promo recalculation
      let newDiscountCents = 0;
      let promoRemoved = false;

      if (booking.promoRedemption?.promoCode) {
        const promo = booking.promoRedemption.promoCode;
        const memberFreeNightsUsed = promo.type === "FREE_NIGHTS" && promo.freeNights
          ? await getMemberFreeNightsUsed(promo.id, booking.memberId, bookingId)
          : 0;
        const validationError = validatePromoCodeRules(
          promo,
          { memberId: booking.memberId },
          new Date(),
          0,
          promo.assignments.length > 0
            ? promo.assignments.map((assignment) => assignment.memberId)
            : null,
          memberFreeNightsUsed
        );

        if (validationError) {
          promoRemoved = true;
          await tx.promoRedemption.delete({
            where: { id: booking.promoRedemption.id },
          });
          await tx.promoCode.update({
            where: { id: promo.id },
            data: { currentRedemptions: { decrement: 1 } },
          });
        } else {
          const remainingFreeNights = promo.type === "FREE_NIGHTS" && promo.freeNights
            ? promo.freeNights - memberFreeNightsUsed
            : undefined;
          const promoResult = calculatePromoDiscountForGuestRates(
            {
              type: promo.type,
              valueCents: promo.valueCents,
              percentOff: promo.percentOff,
              freeNights: promo.freeNights,
            },
            newTotalPriceCents,
            booking.memberId,
            guestNightRates,
            promo.assignments.length > 0
              ? promo.assignments.map((assignment) => assignment.memberId)
              : null,
            undefined,
            remainingFreeNights
          );
          newDiscountCents = promoResult.discountCents;

          await tx.promoRedemption.update({
            where: { id: booking.promoRedemption.id },
            data: {
              discountCents: newDiscountCents,
              freeNightsUsed: promoResult.freeNightsUsed || null,
            },
          });
        }
      }

      const newFinalPriceCents = newTotalPriceCents - newDiscountCents;
      const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;
      const requiresAdminReview = requiresAdultSupervisionReview(remainingGuests);
      const adminReviewReason = requiresAdminReview
        ? ADULT_SUPERVISION_REVIEW_REASON
        : null;

      // Handle refund for price decrease (Stripe call deferred to after tx)
      let refundAmountCents = 0;
      let pendingRefundPaymentIntentId: string | null = null;
      const hasSucceededPayment =
        ["CONFIRMED", "PAID"].includes(booking.status) &&
        booking.payment?.status === "SUCCEEDED";
      const hasIssuedXeroInvoice =
        ["CONFIRMED", "PAID"].includes(booking.status) &&
        !!booking.payment?.xeroInvoiceId;
      const xeroRefundAmountCents =
        hasIssuedXeroInvoice && priceDiffCents < 0 ? Math.abs(priceDiffCents) : 0;

      if (hasSucceededPayment && priceDiffCents < 0 && booking.payment) {
        refundAmountCents = Math.abs(priceDiffCents);
        pendingRefundPaymentIntentId = booking.payment.stripePaymentIntentId;
        if (pendingRefundPaymentIntentId && refundAmountCents > 0) {
          // Pre-update payment record with expected refund state
          const newRefundedTotal =
            booking.payment.refundedAmountCents + refundAmountCents;
          await tx.payment.update({
            where: { id: booking.payment.id },
            data: {
              refundedAmountCents: newRefundedTotal,
              status: "PARTIALLY_REFUNDED",
            },
          });
        }
      }

      // Update hasNonMembers
      const wasOnlyNonMember =
        !guestToRemove.isMember &&
        remainingGuests.every((g) => g.isMember);
      const hasNonMembers = wasOnlyNonMember
        ? false
        : booking.hasNonMembers;

      // Update guest prices (parallel to avoid sequential N+1)
      await Promise.all(
        remainingGuests.map((g, i) =>
          tx.bookingGuest.update({
            where: { id: g.id },
            data: { priceCents: priceBreakdown.guests[i].priceCents },
          })
        )
      );

      // Update booking
      const updatedBooking = await tx.booking.update({
        where: { id: bookingId },
        data: {
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          finalPriceCents: newFinalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil: hasNonMembers
            ? booking.nonMemberHoldUntil
            : null,
          requiresAdminReview,
          adminReviewReason,
        },
        include: { guests: true, payment: true },
      });

      // Create BookingModification record
      const bookingModification = await tx.bookingModification.create({
        data: {
          bookingId,
          memberId: session.user.id,
          modificationType: "GUEST_REMOVE",
          previousData: {
            guestCount: booking.guests.length,
            removedGuest: {
              firstName: guestToRemove.firstName,
              lastName: guestToRemove.lastName,
              ageTier: guestToRemove.ageTier,
              isMember: guestToRemove.isMember,
            },
            totalPriceCents: booking.totalPriceCents,
            finalPriceCents: booking.finalPriceCents,
          },
          newData: {
            guestCount: updatedBooking.guests.length,
            totalPriceCents: newTotalPriceCents,
            finalPriceCents: newFinalPriceCents,
          },
          priceDiffCents,
          changeFeeCents: 0,
        },
      });

      return {
        booking: updatedBooking,
        removedGuest: guestToRemove,
        priceDiffCents,
        refundAmountCents,
        xeroRefundAmountCents,
        pendingRefundPaymentIntentId,
        promoRemoved,
        choreWarnings,
        oldGuestCount: booking.guests.length,
        bookingModificationId: bookingModification.id,
      };
    });

    // Process Stripe refund outside transaction (avoids holding advisory lock during API call)
    let stripeRefundId: string | undefined;
    if (result.refundAmountCents > 0 && result.pendingRefundPaymentIntentId) {
      try {
        const refund = await processRefund({
          paymentIntentId: result.pendingRefundPaymentIntentId,
          amountCents: result.refundAmountCents,
          metadata: {
            bookingId,
            reason: "guest_removed_price_decrease",
          },
        });
        stripeRefundId = refund.id;
      } catch (refundErr) {
        logger.error({ err: refundErr, bookingId, amount: result.refundAmountCents },
          "Stripe refund failed after guest removal - requires manual reconciliation");
      }
    }

    // Audit log
    logAudit({
      action: "booking.modify.guests.remove",
      memberId: session.user.id,
      targetId: bookingId,
      details: JSON.stringify({
        removedGuest: `${result.removedGuest.firstName} ${result.removedGuest.lastName}`,
        priceDiffCents: result.priceDiffCents,
        refundAmountCents: result.refundAmountCents,
        choreWarnings: result.choreWarnings,
      }),
      ipAddress,
    });

    // XER-01: Xero credit note for price decrease (fire-and-forget)
    if (result.xeroRefundAmountCents > 0) {
      void enqueueXeroModificationCreditNoteOperation(
        {
          bookingId,
          refundAmountCents: result.xeroRefundAmountCents,
          bookingModificationId: result.bookingModificationId,
        },
        {
          createdByMemberId: session.user.id,
        }
      )
        .then(async (queued) => {
          if (queued.queueOperationId) {
            await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
          }
        })
        .catch((err) =>
          logger.error({ err, bookingId }, "Failed to queue Xero credit note for guest removal")
        );
    }

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
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message =
      err instanceof Error ? err.message : "Failed to remove guest";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
