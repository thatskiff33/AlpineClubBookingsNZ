import {
  type Booking,
  type BookingGuest,
  type Payment,
  type PaymentStatus,
  type Role,
} from "@prisma/client";

import { logAudit } from "@/lib/audit";
import {
  applyChoreCleanup,
  applyGuestChanges,
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  applyPromoCodeChanges,
  assertBookingModifiable,
  calculateModificationChangeFee,
  calculateModifiedPricing,
  loadActiveSeasonRates,
  prepareGuestPlan,
  resolveTargetDates,
  type BatchModifyInput,
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import {
  createModificationAdditionalPaymentIntent,
  drainSupersededPrimaryIntents,
  executeBookingModificationRefund,
  type BookingModificationPaymentContext,
} from "@/lib/booking-modification-settlement";
import { sendBookingModifiedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};

type BatchModificationTransactionResult =
  BookingModificationPaymentContext & {
    booking: ModifiedBooking;
    priceDiffCents: number;
    changeFeeCents: number;
    refundAmountCents: number;
    promoRemoved: boolean;
    promoChanged: boolean;
    choreWarnings: string[];
    datesChanged: boolean;
    oldCheckIn: Date;
    oldCheckOut: Date;
    oldGuestCount: number;
    hasIssuedXeroInvoice: boolean;
    paymentStatus: PaymentStatus | null;
    zeroDollarAutoPaid: boolean;
    supersededPrimaryPaymentIntents: { length: number };
    xeroAdditionalAmountCents: number;
  };

export type BatchModificationResponse = {
  booking: ModifiedBooking;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  additionalAmountCents: number;
  additionalPaymentClientSecret: string | null;
  stripeRefundId: string | null;
  promoRemoved: boolean;
  promoChanged: boolean;
  choreWarnings: string[];
};

export async function modifyBookingBatch({
  bookingId,
  actor,
  input,
  ipAddress,
}: {
  bookingId: string;
  actor: { id: string; role: Role };
  input: BatchModifyInput;
  ipAddress: string;
}): Promise<BatchModificationResponse> {
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

    const booking = (await tx.booking.findUnique({
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
    })) as LoadedBookingForModify | null;

    assertBookingModifiable(booking, {
      role: actor.role,
      actorId: actor.id,
    });

    const dates = resolveTargetDates({
      booking,
      role: actor.role,
      input,
    });

    const guestPlan = await prepareGuestPlan(tx, {
      booking,
      role: actor.role,
      actorId: actor.id,
      input,
      isInProgressEdit: dates.isInProgressEdit,
      editableFrom: dates.editableFrom,
      newCheckIn: dates.newCheckIn,
    });

    const seasonRateData = await loadActiveSeasonRates(tx);

    const pricing = await calculateModifiedPricing(tx, {
      booking,
      bookingId,
      isInProgressEdit: dates.isInProgressEdit,
      editableFrom: dates.editableFrom,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      normalizedAddGuests: guestPlan.normalizedAddGuests,
      removeGuestIds: input.removeGuestIds,
      guestsForPricing: guestPlan.guestsForPricing,
      totalGuestCount: guestPlan.totalGuestCount,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
      seasonRateData,
    });

    const promo = await applyPromoCodeChanges(tx, {
      booking,
      bookingId,
      input,
      inProgressPlan: pricing.inProgressPlan,
      newTotalPriceCents: pricing.newTotalPriceCents,
      guestNightRates: pricing.guestNightRates,
    });

    const newFinalPriceCents = pricing.newTotalPriceCents - promo.newDiscountCents;
    const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

    const changeFeeCents = await calculateModificationChangeFee({
      booking,
      newCheckIn: dates.newCheckIn,
      checkInChanged: dates.checkInChanged,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
    });

    await applyGuestChanges(tx, {
      bookingId,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      removedGuests: guestPlan.removedGuests,
      remainingGuests: guestPlan.remainingGuests,
      normalizedAddGuests: guestPlan.normalizedAddGuests,
      priceBreakdown: pricing.priceBreakdown,
      inProgressPlan: pricing.inProgressPlan,
    });

    const choreWarnings = await applyChoreCleanup(tx, {
      bookingId,
      newCheckIn: dates.newCheckIn,
      newCheckOut: dates.newCheckOut,
      datesChanged: dates.datesChanged,
    });

    const payments = await applyPaymentAdjustments(tx, {
      booking,
      priceDiffCents,
      changeFeeCents,
    });

    const lifecycle = await applyLifecycleTransitions(tx, {
      booking,
      bookingId,
      newCheckIn: dates.newCheckIn,
      newFinalPriceCents,
      guestsForPricing: guestPlan.guestsForPricing,
      skipBookingLifecycleRules: dates.skipBookingLifecycleRules,
      reviewUpdate: guestPlan.reviewUpdate,
    });

    const updatedBooking = await tx.booking.update({
      where: { id: bookingId },
      data: {
        checkIn: dates.newCheckIn,
        checkOut: dates.newCheckOut,
        totalPriceCents: pricing.newTotalPriceCents,
        discountCents: promo.newDiscountCents,
        finalPriceCents: newFinalPriceCents,
        hasNonMembers: lifecycle.hasNonMembers,
        nonMemberHoldUntil: lifecycle.newNonMemberHoldUntil,
        status: lifecycle.newStatus,
        requiresAdminReview: guestPlan.reviewUpdate.requiresAdminReview,
        adminReviewReason: guestPlan.reviewUpdate.adminReviewReason,
        memberReviewJustification: guestPlan.reviewUpdate.memberReviewJustification,
        adminReviewStatus: guestPlan.reviewUpdate.adminReviewStatus,
        adminReviewNotes: guestPlan.reviewUpdate.adminReviewNotes,
        adminReviewedById: guestPlan.reviewUpdate.adminReviewedById,
        adminReviewedAt: guestPlan.reviewUpdate.adminReviewedAt,
      },
      include: { guests: true, payment: true },
    });

    await reconcileBedAllocationsForBooking({
      bookingId,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    const bookingModification = await tx.bookingModification.create({
      data: {
        bookingId,
        memberId: actor.id,
        modificationType: "BATCH_MODIFY",
        previousData: {
          checkIn: new Date(booking.checkIn).toISOString().split("T")[0],
          checkOut: new Date(booking.checkOut).toISOString().split("T")[0],
          guestCount: booking.guests.length,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          finalPriceCents: booking.finalPriceCents,
          removedGuests: guestPlan.removedGuests.map((g) => ({
            firstName: g.firstName,
            lastName: g.lastName,
          })),
        },
        newData: {
          checkIn: dates.newCheckIn.toISOString().split("T")[0],
          checkOut: dates.newCheckOut.toISOString().split("T")[0],
          guestCount: updatedBooking.guests.length,
          addedGuests: (guestPlan.normalizedAddGuests ?? []).map((g) => ({
            firstName: g.firstName,
            lastName: g.lastName,
          })),
          totalPriceCents: pricing.newTotalPriceCents,
          discountCents: promo.newDiscountCents,
          finalPriceCents: newFinalPriceCents,
          promoRemoved: promo.promoRemoved,
          promoChanged: promo.promoChanged,
        },
        priceDiffCents,
        changeFeeCents,
      },
    });

    return {
      booking: updatedBooking,
      priceDiffCents,
      changeFeeCents,
      refundAmountCents: payments.refundAmountCents,
      additionalAmountCents: payments.additionalAmountCents,
      pendingRefundAmountCents: payments.pendingRefundAmountCents,
      promoRemoved: promo.promoRemoved,
      promoChanged: promo.promoChanged,
      choreWarnings,
      datesChanged: dates.datesChanged,
      oldCheckIn: booking.checkIn,
      oldCheckOut: booking.checkOut,
      oldGuestCount: booking.guests.length,
      hasSucceededPayment: payments.hasSucceededPayment,
      hasIssuedXeroInvoice: payments.hasIssuedXeroInvoice,
      paymentStatus: booking.payment?.status ?? null,
      zeroDollarAutoPaid: lifecycle.zeroDollarAutoPaid,
      supersededPrimaryPaymentIntents: lifecycle.supersededPrimaryPaymentIntents,
      xeroAdditionalAmountCents: payments.xeroAdditionalAmountCents,
      paymentId: booking.payment?.id ?? null,
      paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
      memberEmail: booking.member.email,
      memberName: `${booking.member.firstName} ${booking.member.lastName}`,
      memberId: booking.memberId,
      bookingModificationId: bookingModification.id,
    } satisfies BatchModificationTransactionResult;
  });

  await drainSupersededPrimaryIntents({
    bookingId,
    supersededPrimaryPaymentIntents: result.supersededPrimaryPaymentIntents,
  });

  const stripeRefundId = await executeBookingModificationRefund({
    bookingId,
    result,
    metadataReason: "batch_modification",
    idempotencyKeyPrefix: `mod_batch_refund_${bookingId}`,
    failureMessage: "Stripe refund failed after batch modification - enqueueing recovery",
    recoveryFailureMessage:
      "Failed to enqueue payment recovery for Stripe refund failure after batch modification",
  });

  const { additionalPaymentClientSecret, additionalPaymentIntentId } =
    await createModificationAdditionalPaymentIntent({
      bookingId,
      result,
      reason: "batch_modify_price_increase",
      idempotencyKey: `mod_batch_${bookingId}_${result.bookingModificationId}`,
      failureMessage: "Failed to create additional PaymentIntent for batch modification",
    });

  await dispatchBatchPostTransactionSideEffects({
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
    promoChanged: result.promoChanged,
    choreWarnings: result.choreWarnings,
  };
}

async function dispatchBatchPostTransactionSideEffects({
  bookingId,
  actorMemberId,
  ipAddress,
  result,
  additionalPaymentIntentId,
}: {
  bookingId: string;
  actorMemberId: string;
  ipAddress: string;
  result: BatchModificationTransactionResult;
  additionalPaymentIntentId: string | undefined;
}): Promise<void> {
  const auditDetails = {
    datesChanged: result.datesChanged,
    oldGuestCount: result.oldGuestCount,
    newGuestCount: result.booking.guests.length,
    priceDiffCents: result.priceDiffCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    promoRemoved: result.promoRemoved,
    promoChanged: result.promoChanged,
    zeroDollarAutoPaid: result.zeroDollarAutoPaid,
  };

  logAudit({
    action: "booking.modify.batch",
    memberId: actorMemberId,
    targetId: bookingId,
    subjectMemberId: result.booking.memberId,
    entityType: "BookingModification",
    entityId: result.bookingModificationId,
    category: "booking",
    outcome: "success",
    summary: "Booking modified",
    details: JSON.stringify(auditDetails),
    metadata: { bookingId, ...auditDetails },
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
    createPrimaryInvoiceWhenMissing:
      result.zeroDollarAutoPaid && !result.hasIssuedXeroInvoice,
    requiresAdditionalStripePayment:
      result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
    additionalPaymentIntentId,
  }).catch((err) =>
    logger.error(
      { err, bookingId },
      "Failed to queue Xero settlement for batch modification",
    ),
  );

  const member = await prisma.member.findUnique({
    where: { id: result.booking.memberId },
  });
  if (!member) return;

  sendBookingModifiedEmail({
    email: member.email,
    firstName: member.firstName,
    modificationType: "BATCH_MODIFY",
    oldCheckIn: result.oldCheckIn,
    oldCheckOut: result.oldCheckOut,
    newCheckIn: result.booking.checkIn,
    newCheckOut: result.booking.checkOut,
    oldGuestCount: result.oldGuestCount,
    newGuestCount: result.booking.guests.length,
    oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
    newFinalPriceCents: result.booking.finalPriceCents,
    changeFeeCents: result.changeFeeCents,
    refundAmountCents: result.refundAmountCents,
    additionalAmountCents: result.additionalAmountCents,
  }).catch((err) =>
    logger.error(
      { err, bookingId },
      "Failed to send batch modification email",
    ),
  );
}
