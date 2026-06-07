import {
  type AgeTier,
  type Booking,
  type BookingGuest,
  type Payment,
  type PaymentStatus,
  type Role,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit";
import {
  queueSupersededPrimaryIntentCancellations,
} from "@/lib/booking-payment-cleanup";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import {
  createModificationAdditionalPaymentIntent,
  executeBookingModificationRefund,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import { checkCapacity } from "@/lib/capacity";
import {
  daysUntilDate,
  getNonMemberHoldDays,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import { normalizeDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";
import { sendBookingModifiedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import {
  deletePromoRedemptionAndAdjustCount,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/pricing";
import { processWaitlistForDates } from "@/lib/waitlist";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

export type ModifyBookingDatesInput = {
  checkIn?: string;
  checkOut?: string;
};

type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

type DateModificationTransactionResult =
  BookingModificationPaymentContext & {
    booking: ModifiedBooking;
    priceDiffCents: number;
    changeFeeCents: number;
    refundAmountCents: number;
    promoRemoved: boolean;
    choreWarnings: string[];
    datesChanged: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    xeroAdditionalAmountCents: number;
  };

export type DateModificationResponse = {
  booking: ModifiedBooking;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  additionalAmountCents: number;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  choreWarnings: string[];
};

export async function modifyBookingDates({
  bookingId,
  actor,
  input,
  ipAddress,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  input: ModifyBookingDatesInput;
  ipAddress: string;
}): Promise<DateModificationResponse> {
  const { checkIn: newCheckInStr, checkOut: newCheckOutStr } = input;

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

    if (booking.memberId !== actor.id && actor.role !== "ADMIN") {
      throw new ApiError("Forbidden", 403);
    }

    if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
      throw new ApiError(
        "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
        400,
      );
    }

    const editPolicy = getBookingEditPolicy({
      status: booking.status,
      role: actor.role,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    });
    if (!editPolicy.canModify) {
      throw new ApiError(
        editPolicy.reason ?? "This booking cannot be modified",
        400,
      );
    }
    if (editPolicy.mode !== "future") {
      throw new ApiError(
        "Use the full booking edit flow for in-progress booking date changes",
        400,
      );
    }

    const newCheckIn = newCheckInStr
      ? parseDateOnly(newCheckInStr)
      : booking.checkIn;
    const newCheckOut = newCheckOutStr
      ? parseDateOnly(newCheckOutStr)
      : booking.checkOut;

    if (
      Number.isNaN(newCheckIn.getTime()) ||
      Number.isNaN(newCheckOut.getTime())
    ) {
      throw new ApiError("Invalid booking dates", 400);
    }

    if (newCheckOut <= newCheckIn) {
      throw new ApiError("Check-out must be after check-in", 400);
    }

    if (
      actor.role !== "ADMIN" &&
      normalizeDateOnlyForTimeZone(newCheckIn) <= editPolicy.today
    ) {
      throw new ApiError(
        "NZ today and earlier are locked for self-service changes",
        400,
      );
    }

    if (actor.role !== "ADMIN") {
      const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
      const stayResult = await validateMinimumStay(newCheckIn, newCheckOut);
      if (!stayResult.valid) {
        throw new ApiError(
          formatViolationsDetail(stayResult.violations),
          400,
        );
      }
    }

    const capacity = await checkCapacity(
      newCheckIn,
      newCheckOut,
      booking.guests.length,
      bookingId,
      tx,
    );

    if (!capacity.available) {
      throw new ApiError(
        "Not enough beds available for the new dates",
        400,
      );
    }

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

    const guestsForPricing = booking.guests.map((g) => ({
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
    }));

    let priceBreakdown;
    try {
      priceBreakdown = calculateBookingPrice(
        newCheckIn,
        newCheckOut,
        guestsForPricing,
        seasonRateData,
      );
    } catch {
      throw new ApiError(
        "No season rate found for the requested dates",
        400,
      );
    }

    const newTotalPriceCents = priceBreakdown.totalPriceCents;
    const guestNightRates = guestsForPricing.map((guest, index) => ({
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: priceBreakdown.guests[index].perNightCents,
    }));

    let newDiscountCents = 0;
    let promoRemoved = false;

    if (booking.promoRedemption?.promoCode) {
      const promo = booking.promoRedemption.promoCode;
      const application = await validateAndCalculatePromoDiscount(
        promo,
        {
          memberId: booking.memberId,
          bookingCheckIn: newCheckIn,
          totalPriceCents: newTotalPriceCents,
          guests: guestNightRates,
        },
        promo.assignments.length > 0
          ? promo.assignments.map((assignment) => assignment.memberId)
          : null,
        { excludeBookingId: bookingId, db: tx },
      );

      if (application.error || !application.discount) {
        promoRemoved = true;
        await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      } else {
        const promoResult = application.discount;
        newDiscountCents = promoResult.discountCents;

        await replacePromoRedemptionAllocations(
          tx,
          booking.promoRedemption,
          newDiscountCents,
          promoResult.freeNightsUsed,
          promoResult.eligibleGuestCount,
          promoResult.allocations,
        );
      }
    }

    const newFinalPriceCents = newTotalPriceCents - newDiscountCents;
    const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

    let changeFeeCents = 0;
    const checkInChanged =
      newCheckIn.getTime() !== new Date(booking.checkIn).getTime();

    if (checkInChanged) {
      const now = new Date();
      const policy = await loadCancellationPolicy(booking.checkIn);
      const feeResult = calculateChangeFee({
        daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, now),
        daysUntilNewCheckIn: daysUntilDate(newCheckIn, now),
        originalFinalPriceCents: booking.finalPriceCents,
        policyRules: policy,
      });
      changeFeeCents = feeResult.feeCents;
    }

    let refundAmountCents = 0;
    let additionalAmountCents = 0;

    const hasSucceededPayment =
      ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
      booking.payment?.status === "SUCCEEDED";
    const hasIssuedXeroInvoice =
      ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
      !!booking.payment?.xeroInvoiceId;
    const xeroNetAmountCents = hasIssuedXeroInvoice
      ? priceDiffCents + changeFeeCents
      : 0;
    const xeroAdditionalAmountCents =
      xeroNetAmountCents > 0 ? xeroNetAmountCents : 0;

    let pendingRefundAmountCents = 0;

    if (hasSucceededPayment && booking.payment) {
      const netAmountCents = priceDiffCents + changeFeeCents;

      if (netAmountCents < 0) {
        refundAmountCents = Math.abs(netAmountCents);
        pendingRefundAmountCents = refundAmountCents;
      } else if (netAmountCents > 0) {
        additionalAmountCents = netAmountCents;
      }

      if (changeFeeCents > 0) {
        await tx.payment.update({
          where: { id: booking.payment.id },
          data: {
            changeFeeCents: {
              increment: changeFeeCents,
            },
          },
        });
      }
    } else if (xeroAdditionalAmountCents > 0) {
      additionalAmountCents = xeroAdditionalAmountCents;
    }

    const hasNonMembers = booking.guests.some((g) => !g.isMember);
    let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
    let newStatus = booking.status;

    if (hasNonMembers) {
      const holdDays = await getNonMemberHoldDays(newCheckIn);
      const daysUntilNewCheckIn = Math.ceil(
        (newCheckIn.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24),
      );

      if (daysUntilNewCheckIn <= holdDays) {
        newNonMemberHoldUntil = null;
        if (booking.status === "PENDING") {
          newStatus = "PAYMENT_PENDING";
        }
      } else {
        newNonMemberHoldUntil = new Date(
          newCheckIn.getTime() - holdDays * 24 * 60 * 60 * 1000,
        );
      }
    } else {
      newNonMemberHoldUntil = null;
    }

    await Promise.all(
      booking.guests.map((g, i) =>
        tx.bookingGuest.update({
          where: { id: g.id },
          data: {
            stayStart: newCheckIn,
            stayEnd: newCheckOut,
            priceCents: priceBreakdown.guests[i].priceCents,
          },
        }),
      ),
    );

    const oldCheckIn = new Date(booking.checkIn);
    const oldCheckOut = new Date(booking.checkOut);
    const datesChanged =
      newCheckIn.getTime() !== oldCheckIn.getTime() ||
      newCheckOut.getTime() !== oldCheckOut.getTime();
    const dateCleanup = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
    );
    const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
      tx,
      bookingId,
    );
    const choreWarnings = [
      ...dateCleanup.choreWarnings,
      ...rangeCleanup.choreWarnings,
    ];

    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        totalPriceCents: newTotalPriceCents,
        discountCents: newDiscountCents,
        finalPriceCents: newFinalPriceCents,
        nonMemberHoldUntil: newNonMemberHoldUntil,
        status: newStatus,
      },
      include: { guests: true, payment: true },
    });

    await reconcileBedAllocationsForBooking({
      bookingId,
      db: tx,
      previousRange: {
        checkIn: oldCheckIn,
        checkOut: oldCheckOut,
      },
    });

    if (updatedBooking.payment) {
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: updatedBooking.payment.id,
        newFinalPriceCents,
      });
    }

    const bookingModification = await tx.bookingModification.create({
      data: {
        bookingId,
        memberId: actor.id,
        modificationType: "DATE_CHANGE",
        previousData: {
          checkIn: oldCheckIn.toISOString().split("T")[0],
          checkOut: oldCheckOut.toISOString().split("T")[0],
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          finalPriceCents: booking.finalPriceCents,
        },
        newData: {
          checkIn: newCheckIn.toISOString().split("T")[0],
          checkOut: newCheckOut.toISOString().split("T")[0],
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          finalPriceCents: newFinalPriceCents,
        },
        priceDiffCents,
        changeFeeCents,
      },
    });

    return {
      booking: updatedBooking,
      priceDiffCents,
      changeFeeCents,
      refundAmountCents,
      additionalAmountCents,
      pendingRefundAmountCents,
      promoRemoved,
      choreWarnings,
      datesChanged,
      oldCheckIn,
      oldCheckOut,
      hasSucceededPayment,
      hasIssuedXeroInvoice,
      paymentStatus: booking.payment?.status ?? null,
      xeroAdditionalAmountCents,
      paymentId: booking.payment?.id ?? null,
      paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
      memberEmail: booking.member.email,
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.memberId,
      bookingModificationId: bookingModification.id,
    } satisfies DateModificationTransactionResult;
  });

  const stripeRefundId = await executeBookingModificationRefund({
    bookingId,
    result,
    metadataReason: "date_change_price_decrease",
    idempotencyKeyPrefix: `mod_dates_refund_${bookingId}`,
    failureMessage: "Stripe refund failed after date change - enqueueing recovery",
    recoveryFailureMessage:
      "Failed to enqueue payment recovery for Stripe refund failure after date change",
  });

  const { additionalPaymentClientSecret, additionalPaymentIntentId } =
    await createModificationAdditionalPaymentIntent({
      bookingId,
      result,
      reason: "date_change_price_increase",
      idempotencyKey: `mod_dates_${bookingId}_${result.bookingModificationId}`,
      failureMessage: "Failed to create additional PaymentIntent for modification",
    });

  await dispatchDatePostTransactionSideEffects({
    bookingId,
    actorMemberId: actor.id,
    ipAddress,
    result,
    additionalPaymentIntentId,
  });

  return {
    booking: result.booking,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    additionalAmountCents: result.additionalAmountCents,
    additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
    stripeRefundId: stripeRefundId ?? null,
    promoRemoved: result.promoRemoved,
    choreWarnings: result.choreWarnings,
  };
}

async function dispatchDatePostTransactionSideEffects({
  bookingId,
  actorMemberId,
  ipAddress,
  result,
  additionalPaymentIntentId,
}: {
  bookingId: string;
  actorMemberId: string;
  ipAddress: string;
  result: DateModificationTransactionResult;
  additionalPaymentIntentId: string | undefined;
}): Promise<void> {
  logAudit({
    action: "booking.modify.dates",
    memberId: actorMemberId,
    targetId: bookingId,
    subjectMemberId: result.booking.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: "Booking dates modified",
    details: JSON.stringify({
      oldCheckIn: result.oldCheckIn.toISOString().split("T")[0],
      oldCheckOut: result.oldCheckOut.toISOString().split("T")[0],
      newCheckIn: result.booking.checkIn,
      newCheckOut: result.booking.checkOut,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      promoRemoved: result.promoRemoved,
    }),
    metadata: {
      bookingId,
      oldCheckIn: result.oldCheckIn.toISOString().split("T")[0],
      oldCheckOut: result.oldCheckOut.toISOString().split("T")[0],
      newCheckIn: result.booking.checkIn.toISOString().split("T")[0],
      newCheckOut: result.booking.checkOut.toISOString().split("T")[0],
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      promoRemoved: result.promoRemoved,
    },
    ipAddress,
  });

  void queueXeroBookingEditSettlement({
    bookingId,
    bookingModificationId: result.bookingModificationId,
    createdByMemberId: actorMemberId,
    hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
    originalPaymentStatus: result.paymentStatus,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    datesChanged: result.datesChanged,
    requiresAdditionalStripePayment:
      result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
    additionalPaymentIntentId,
  }).catch((err) =>
    logger.error({ err, bookingId }, "Failed to queue Xero settlement for date modification"),
  );

  const member = await prisma.member.findUnique({
    where: { id: result.booking.memberId },
  });
  if (member) {
    sendBookingModifiedEmail({
      email: member.email,
      firstName: member.firstName,
      modificationType: "DATE_CHANGE",
      oldCheckIn: result.oldCheckIn,
      oldCheckOut: result.oldCheckOut,
      newCheckIn: result.booking.checkIn,
      newCheckOut: result.booking.checkOut,
      oldGuestCount: result.booking.guests.length,
      newGuestCount: result.booking.guests.length,
      oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
      newFinalPriceCents: result.booking.finalPriceCents,
      changeFeeCents: result.changeFeeCents,
      refundAmountCents: result.refundAmountCents,
      additionalAmountCents: result.additionalAmountCents,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send booking modified email"),
    );
  }

  if (
    result.oldCheckIn.getTime() !== result.booking.checkIn.getTime() ||
    result.oldCheckOut.getTime() !== result.booking.checkOut.getTime()
  ) {
    processWaitlistForDates({
      checkIn: result.oldCheckIn,
      checkOut: result.oldCheckOut,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to process waitlist after date modification"),
    );
  }
}
