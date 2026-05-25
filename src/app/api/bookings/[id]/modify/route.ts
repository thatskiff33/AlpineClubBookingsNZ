import { NextRequest, NextResponse } from "next/server";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import {
  queueSupersededAdditionalIntentCancellations,
} from "@/lib/booking-payment-cleanup";
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
  type LoadedBookingForModify,
} from "@/lib/booking-modify";
import { sendBookingModifiedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import {
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import {
  enqueueBookingModificationRefundRecovery,
  processPaymentRecoveryOperations,
} from "@/lib/payment-recovery";
import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  createPaymentIntent,
  findOrCreateCustomer,
} from "@/lib/stripe";
import { nameField } from "@/lib/zod-helpers";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";

const batchModifySchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: ageTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
      }),
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  promoCode: z.string().optional(),
  removePromoCode: z.boolean().optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      },
      { status: 400 },
    );
  }

  const parsed = batchModifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  try {
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
        role: session.user.role,
        actorId: session.user.id,
      });

      const dates = resolveTargetDates({
        booking,
        role: session.user.role,
        input,
      });

      const guestPlan = await prepareGuestPlan(tx, {
        booking,
        role: session.user.role,
        actorId: session.user.id,
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
          requiresAdminReview: guestPlan.requiresAdminReview,
          adminReviewReason: guestPlan.adminReviewReason,
        },
        include: { guests: true, payment: true },
      });

      const bookingModification = await tx.bookingModification.create({
        data: {
          bookingId,
          memberId: session.user.id,
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
        xeroRefundAmountCents: payments.xeroRefundAmountCents,
        xeroAdditionalAmountCents: payments.xeroAdditionalAmountCents,
        paymentId: booking.payment?.id ?? null,
        paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
        memberEmail: booking.member.email,
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        memberId: booking.memberId,
        bookingModificationId: bookingModification.id,
      };
    });

    await drainSupersededPrimaryIntents({ bookingId, result });

    const stripeRefundId = await executeStripeRefund({
      bookingId,
      result,
    });

    const { additionalPaymentClientSecret, additionalPaymentIntentId } =
      await createAdditionalPaymentIntentIfNeeded({
        bookingId,
        result,
      });

    await dispatchPostTransactionSideEffects({
      bookingId,
      actorMemberId: session.user.id,
      ipAddress,
      result,
      additionalPaymentIntentId,
    });

    return NextResponse.json({
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
    });
  } catch (err) {
    if (err instanceof BookingGuestValidationError) {
      return NextResponse.json(getBookingGuestValidationErrorResponse(err), {
        status: err.status,
      });
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Failed to modify booking";
    logger.error({ err, bookingId }, "Batch modify failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function drainSupersededPrimaryIntents({
  bookingId,
  result,
}: {
  bookingId: string;
  result: { supersededPrimaryPaymentIntents: { length: number } };
}): Promise<void> {
  if (result.supersededPrimaryPaymentIntents.length === 0) return;
  try {
    await processPaymentRecoveryOperations({
      limit: result.supersededPrimaryPaymentIntents.length,
    });
  } catch (err) {
    logger.error(
      { err, bookingId },
      "Failed to immediately process queued Stripe payment recovery operations",
    );
  }
}

type TransactionResult = {
  pendingRefundAmountCents: number;
  paymentId: string | null;
  booking: {
    checkIn: Date;
    checkOut: Date;
    memberId: string;
    finalPriceCents: number;
    guests: { length: number };
  };
  memberName: string;
  additionalAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  paymentCustomerId: string | null;
  paymentStatus: string | null;
  memberEmail: string;
  memberId: string;
  bookingModificationId: string;
  datesChanged: boolean;
  oldGuestCount: number;
  oldCheckIn: Date;
  oldCheckOut: Date;
  priceDiffCents: number;
  changeFeeCents: number;
  refundAmountCents: number;
  promoRemoved: boolean;
  promoChanged: boolean;
  zeroDollarAutoPaid: boolean;
  xeroAdditionalAmountCents: number;
};

async function dispatchPostTransactionSideEffects({
  bookingId,
  actorMemberId,
  ipAddress,
  result,
  additionalPaymentIntentId,
}: {
  bookingId: string;
  actorMemberId: string;
  ipAddress: string;
  result: TransactionResult;
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

async function executeStripeRefund({
  bookingId,
  result,
}: {
  bookingId: string;
  result: TransactionResult;
}): Promise<string | undefined> {
  if (result.pendingRefundAmountCents <= 0 || !result.paymentId) {
    return undefined;
  }

  try {
    const refundResult = await refundPaymentTransactions({
      paymentId: result.paymentId,
      amountCents: result.pendingRefundAmountCents,
      metadata: { bookingId, reason: "batch_modification" },
      idempotencyKeyPrefix: `mod_batch_refund_${bookingId}`,
    });
    return refundResult.refunds[0]?.refundId;
  } catch (refundErr) {
    logger.error(
      { err: refundErr, bookingId, amount: result.pendingRefundAmountCents },
      "Stripe refund failed after batch modification - enqueueing recovery",
    );
    await enqueueBookingModificationRefundRecovery({
      bookingId,
      paymentId: result.paymentId,
      bookingModificationId: result.bookingModificationId,
      amountCents: result.pendingRefundAmountCents,
    }).catch((enqueueErr) =>
      logger.error(
        { err: enqueueErr, bookingId },
        "Failed to enqueue payment recovery for Stripe refund failure after batch modification",
      ),
    );
    return undefined;
  }
}

async function createAdditionalPaymentIntentIfNeeded({
  bookingId,
  result,
}: {
  bookingId: string;
  result: TransactionResult;
}): Promise<{
  additionalPaymentClientSecret: string | undefined;
  additionalPaymentIntentId: string | undefined;
}> {
  if (
    result.additionalAmountCents <= 0 ||
    !result.hasSucceededPayment ||
    !result.paymentId
  ) {
    return {
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
    };
  }

  try {
    let customerId = result.paymentCustomerId ?? undefined;
    if (!customerId) {
      const customer = await findOrCreateCustomer({
        email: result.memberEmail,
        name: result.memberName,
        memberId: result.memberId,
      });
      customerId = customer.id;
    }

    const pi = await createPaymentIntent({
      amountCents: result.additionalAmountCents,
      customerId,
      metadata: {
        bookingId,
        type: "modification_additional",
        reason: "batch_modify_price_increase",
      },
      idempotencyKey: `mod_batch_${bookingId}_${result.bookingModificationId}`,
    });

    await queueSupersededAdditionalIntentCancellations({
      bookingId,
      paymentId: result.paymentId,
      newPaymentIntentId: pi.id,
    }).catch((err) =>
      logger.error(
        { err, bookingId, paymentIntentId: pi.id },
        "Failed to queue superseded additional intent cancellations",
      ),
    );

    await upsertPaymentIntentTransaction({
      paymentId: result.paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: pi.id,
      amountCents: result.additionalAmountCents,
      status: PaymentStatus.PENDING,
      reason: "batch_modify_price_increase",
      stripeCustomerId: customerId,
    });

    return {
      additionalPaymentClientSecret: pi.client_secret ?? undefined,
      additionalPaymentIntentId: pi.id,
    };
  } catch (piErr) {
    logger.error(
      { err: piErr, bookingId },
      "Failed to create additional PaymentIntent for batch modification",
    );
    return {
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
    };
  }
}
