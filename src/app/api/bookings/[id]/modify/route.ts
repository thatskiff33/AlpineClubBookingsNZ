import { NextRequest, NextResponse } from "next/server";
import { PaymentStatus, PaymentTransactionKind, type AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkCapacity } from "@/lib/capacity";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  daysUntilDate,
  loadCancellationPolicy,
  getNonMemberHoldDays,
} from "@/lib/cancellation";
import {
  calculatePromoDiscountForGuestRates,
  getMemberFreeNightsUsed,
  validatePromoCodeRules,
  redeemPromoCode,
} from "@/lib/promo";
import { createPaymentIntent, findOrCreateCustomer } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { cleanupChoreAssignmentsForDateChange } from "@/lib/chore-cleanup";
import {
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import {
  canModifyBookingStatus,
  usesActiveBookingLifecycle,
} from "@/lib/booking-modify-permissions";
import {
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { nameField } from "@/lib/zod-helpers";

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
      })
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  promoCode: z.string().optional(),
  removePromoCode: z.boolean().optional(),
});

class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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

  const body = await request.json();
  const parsed = batchModifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const {
    checkIn: newCheckInStr,
    checkOut: newCheckOutStr,
    addGuests,
    removeGuestIds,
    promoCode: newPromoCode,
    removePromoCode,
  } = parsed.data;

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

      if (!booking) throw new ApiError("Booking not found", 404);

      if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
        throw new ApiError("Forbidden", 403);
      }

      if (!canModifyBookingStatus(booking.status, session.user.role)) {
        throw new ApiError(
          "This booking cannot be modified in its current status",
          400
        );
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (new Date(booking.checkIn) < today) {
        throw new ApiError("Cannot modify a booking with past check-in", 400);
      }

      // Determine new dates
      const newCheckIn = newCheckInStr ? new Date(newCheckInStr) : booking.checkIn;
      const newCheckOut = newCheckOutStr ? new Date(newCheckOutStr) : booking.checkOut;

      if (newCheckOut <= newCheckIn) {
        throw new ApiError("Check-out must be after check-in", 400);
      }

      if (newCheckIn < today) {
        throw new ApiError("Check-in cannot be in the past", 400);
      }

      const skipBookingLifecycleRules =
        session.user.role === "ADMIN" &&
        !usesActiveBookingLifecycle(booking.status);

      let normalizedAddGuests = addGuests;
      try {
        const linkedMembers = await resolveLinkedBookingMembers(
          tx,
          booking.memberId,
          (addGuests ?? []).map((guest) => guest.memberId),
          { skipAuthorization: session.user.role === "ADMIN" }
        );
        await assertLinkedBookingMembersCanBeBooked(
          tx,
          linkedMembers,
          session.user.id,
          {
            actorRole: session.user.role,
            onBehalfOfMemberId:
              session.user.role === "ADMIN" ? booking.memberId : null,
          }
        );
        normalizedAddGuests = addGuests
          ? normalizeBookingGuestInputs(addGuests, linkedMembers)
          : undefined;
      } catch (error) {
        if (error instanceof BookingGuestValidationError) {
          throw error;
        }
        throw error;
      }

      // Determine guest changes
      const removeSet = new Set(removeGuestIds ?? []);
      const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
      const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

      if (remainingGuests.length === 0 && (!normalizedAddGuests || normalizedAddGuests.length === 0)) {
        throw new ApiError("Booking must have at least one guest", 400);
      }

      const guestsForPricing = [
        ...remainingGuests.map((g) => ({
          ageTier: g.ageTier as AgeTier,
          isMember: g.isMember,
          memberId: g.memberId ?? null,
        })),
        ...(normalizedAddGuests ?? []).map((g) => ({
          ageTier: g.ageTier as AgeTier,
          isMember: g.isMember,
          memberId: g.memberId ?? null,
        })),
      ];

      const totalGuestCount = guestsForPricing.length;
      const requiresAdminReview = requiresAdultSupervisionReview(guestsForPricing);
      const adminReviewReason = requiresAdminReview
        ? ADULT_SUPERVISION_REVIEW_REASON
        : null;

      if (totalGuestCount > 29) {
        throw new ApiError("A booking cannot exceed 29 guests", 400);
      }

      if (session.user.role !== "ADMIN") {
        const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
          bookingMemberId: booking.memberId,
          checkIn: newCheckIn,
          guests: normalizedAddGuests ?? [],
        });

        if (unpaidMemberGuests.length > 0) {
          throw new ApiError(
            `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
            403
          );
        }
      }

      // Capacity check excluding this booking
      const capacity = skipBookingLifecycleRules
        ? { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] }
        : await checkCapacity(newCheckIn, newCheckOut, totalGuestCount, bookingId);
      if (!capacity.available) {
        throw new ApiError("Not enough beds available for these changes", 400);
      }

      // Load seasons
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

      // Calculate new total price
      let priceBreakdown;
      try {
        priceBreakdown = calculateBookingPrice(newCheckIn, newCheckOut, guestsForPricing, seasonRateData);
      } catch {
        throw new ApiError("No season rate found for the requested dates", 400);
      }

      const newTotalPriceCents = priceBreakdown.totalPriceCents;
      const guestNightRates = guestsForPricing.map((guest) => {
        const breakdown = calculateBookingPrice(
          newCheckIn,
          newCheckOut,
          [guest],
          seasonRateData
        );
        return {
          memberId: guest.memberId ?? null,
          perNightRates: breakdown.guests[0].perNightCents,
        };
      });

      // --- Handle promo code ---
      let newDiscountCents = 0;
      let promoRemoved = false;
      let promoChanged = false;

      if (removePromoCode && booking.promoRedemption) {
        // Remove existing promo for reuse
        await tx.promoRedemption.delete({ where: { id: booking.promoRedemption.id } });
        await tx.promoCode.update({
          where: { id: booking.promoRedemption.promoCodeId },
          data: { currentRedemptions: { decrement: 1 } },
        });
        promoRemoved = true;
      }

      if (newPromoCode && !removePromoCode) {
        // Remove old promo first if exists
        if (booking.promoRedemption && !promoRemoved) {
          await tx.promoRedemption.delete({ where: { id: booking.promoRedemption.id } });
          await tx.promoCode.update({
            where: { id: booking.promoRedemption.promoCodeId },
            data: { currentRedemptions: { decrement: 1 } },
          });
          promoRemoved = true;
        }

        // Validate and apply new promo
        const promoCode = await tx.promoCode.findUnique({
          where: { code: newPromoCode.toUpperCase().trim() },
          include: { assignments: { select: { memberId: true } } },
        });

        if (!promoCode) throw new ApiError("Promo code not found", 400);

        // Check single-use (exclude current booking since we just removed old redemption)
        let memberRedemptionCount = 0;
        if (promoCode.singleUse) {
          memberRedemptionCount = await tx.promoRedemption.count({
            where: { promoCodeId: promoCode.id, memberId: booking.memberId, bookingId: { not: bookingId } },
          });
        }

        // For FREE_NIGHTS, get cumulative free nights used (exclude current booking)
        let memberFreeNightsUsed = 0;
        if (promoCode.type === "FREE_NIGHTS" && promoCode.freeNights) {
          memberFreeNightsUsed = await getMemberFreeNightsUsed(
            promoCode.id,
            booking.memberId,
            bookingId
          );
        }

        const assignedMemberIds = promoCode.assignments.length
          ? promoCode.assignments.map((assignment) => assignment.memberId)
          : null;
        const validationError = validatePromoCodeRules(
          promoCode,
          { memberId: booking.memberId },
          new Date(),
          memberRedemptionCount,
          assignedMemberIds,
          memberFreeNightsUsed
        );

        if (validationError) throw new ApiError(validationError, 400);

        const remainingFreeNights = promoCode.type === "FREE_NIGHTS" && promoCode.freeNights
          ? promoCode.freeNights - memberFreeNightsUsed
          : undefined;
        const promoResult = calculatePromoDiscountForGuestRates(
          {
            type: promoCode.type,
            valueCents: promoCode.valueCents,
            percentOff: promoCode.percentOff,
            freeNights: promoCode.freeNights,
          },
          newTotalPriceCents,
          booking.memberId,
          guestNightRates,
          assignedMemberIds,
          undefined,
          remainingFreeNights
        );
        newDiscountCents = promoResult.discountCents;

        await redeemPromoCode(tx, promoCode.id, bookingId, booking.memberId, newDiscountCents, promoResult.freeNightsUsed);
        promoChanged = true;
      } else if (!removePromoCode && !promoRemoved && booking.promoRedemption?.promoCode) {
        // Keep existing promo, recalculate discount
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
          // Promo no longer valid - remove it
          await tx.promoRedemption.delete({ where: { id: booking.promoRedemption.id } });
          await tx.promoCode.update({
            where: { id: promo.id },
            data: { currentRedemptions: { decrement: 1 } },
          });
          promoRemoved = true;
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

      // Calculate change fee (only if check-in changed)
      let changeFeeCents = 0;
      const checkInChanged = newCheckIn.getTime() !== new Date(booking.checkIn).getTime();
      const datesChanged = checkInChanged || newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

      if (!skipBookingLifecycleRules && checkInChanged) {
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

      // --- Delete removed guests and their chore assignments ---
      for (const guest of removedGuests) {
        await tx.choreAssignment.deleteMany({ where: { bookingGuestId: guest.id } });
        await tx.bookingGuest.delete({ where: { id: guest.id } });
      }

      // --- Create new guests ---
      const createdGuests = [];
      const addedGuestStartIndex = remainingGuests.length;
      for (let i = 0; i < (normalizedAddGuests ?? []).length; i++) {
        const g = normalizedAddGuests![i];
        const guestPriceIndex = addedGuestStartIndex + i;
        const guest = await tx.bookingGuest.create({
          data: {
            bookingId,
            firstName: g.firstName,
            lastName: g.lastName,
            ageTier: g.ageTier,
            isMember: g.isMember,
            memberId: g.memberId || null,
            priceCents: priceBreakdown.guests[guestPriceIndex].priceCents,
          },
        });
        createdGuests.push(guest);
      }

      // --- Update remaining guest prices ---
      for (let i = 0; i < remainingGuests.length; i++) {
        await tx.bookingGuest.update({
          where: { id: remainingGuests[i].id },
          data: { priceCents: priceBreakdown.guests[i].priceCents },
        });
      }

      // --- Clean up chore assignments if dates changed ---
      let choreWarnings: string[] = [];
      if (datesChanged) {
        const result = await cleanupChoreAssignmentsForDateChange(
          tx,
          bookingId,
          newCheckIn,
          newCheckOut
        );
        choreWarnings = result.choreWarnings;
      }

      // --- Handle Stripe payment adjustments ---
      let refundAmountCents = 0;
      let additionalAmountCents = 0;
      let pendingRefundAmountCents = 0;

      const hasSucceededPayment =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        booking.payment?.status === "SUCCEEDED";
      const hasIssuedXeroInvoice =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        !!booking.payment?.xeroInvoiceId;
      const xeroNetAmountCents = hasIssuedXeroInvoice
        ? priceDiffCents + changeFeeCents
        : 0;
      const xeroRefundAmountCents =
        xeroNetAmountCents < 0 ? Math.abs(xeroNetAmountCents) : 0;
      const xeroAdditionalAmountCents =
        xeroNetAmountCents > 0 ? xeroNetAmountCents : 0;

      if (hasSucceededPayment && booking.payment) {
        if (priceDiffCents < 0) {
          refundAmountCents = Math.abs(priceDiffCents);
          pendingRefundAmountCents = refundAmountCents;
        } else if (priceDiffCents > 0 || changeFeeCents > 0) {
          additionalAmountCents = Math.max(priceDiffCents, 0) + changeFeeCents;
        }

        if (changeFeeCents > 0) {
          await tx.payment.update({
            where: { id: booking.payment.id },
            data: { changeFeeCents: { increment: changeFeeCents } },
          });
        }
      } else if (xeroAdditionalAmountCents > 0) {
        additionalAmountCents = xeroAdditionalAmountCents;
      }

      // --- Update hasNonMembers and nonMemberHoldUntil ---
      const allGuestsNowMembers = guestsForPricing.every((g) => g.isMember);
      const hasNonMembers = !allGuestsNowMembers;
      let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
      let newStatus = booking.status;

      if (!skipBookingLifecycleRules && hasNonMembers) {
        const holdDays = await getNonMemberHoldDays(newCheckIn);
        const daysUntilNewCheckIn = Math.ceil(
          (newCheckIn.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntilNewCheckIn <= holdDays) {
          newNonMemberHoldUntil = null;
          if (booking.status === "PENDING") {
            newStatus = "PAYMENT_PENDING";
          }
        } else {
          newNonMemberHoldUntil = new Date(
            newCheckIn.getTime() - holdDays * 24 * 60 * 60 * 1000
          );
        }
      } else if (!skipBookingLifecycleRules) {
        newNonMemberHoldUntil = null;
      }

      // --- Update booking ---
      const updatedBooking = await tx.booking.update({
        where: { id: bookingId },
        data: {
          checkIn: newCheckIn,
          checkOut: newCheckOut,
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          finalPriceCents: newFinalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil: newNonMemberHoldUntil,
          status: newStatus,
          requiresAdminReview,
          adminReviewReason,
        },
        include: { guests: true, payment: true },
      });

      // --- Create modification record ---
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
            removedGuests: removedGuests.map((g) => ({
              firstName: g.firstName,
              lastName: g.lastName,
            })),
          },
          newData: {
            checkIn: newCheckIn.toISOString().split("T")[0],
            checkOut: newCheckOut.toISOString().split("T")[0],
            guestCount: updatedBooking.guests.length,
            addedGuests: (normalizedAddGuests ?? []).map((g) => ({
              firstName: g.firstName,
              lastName: g.lastName,
            })),
            totalPriceCents: newTotalPriceCents,
            discountCents: newDiscountCents,
            finalPriceCents: newFinalPriceCents,
            promoRemoved,
            promoChanged,
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
        promoChanged,
        choreWarnings,
        datesChanged,
        oldCheckIn: booking.checkIn,
        oldCheckOut: booking.checkOut,
        oldGuestCount: booking.guests.length,
        hasSucceededPayment,
        hasIssuedXeroInvoice,
        xeroRefundAmountCents,
        xeroAdditionalAmountCents,
        paymentId: booking.payment?.id ?? null,
        paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
        memberEmail: booking.member.email,
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        memberId: booking.memberId,
        bookingModificationId: bookingModification.id,
      };
    });

    let stripeRefundId: string | undefined;
    if (result.pendingRefundAmountCents > 0 && result.paymentId) {
      try {
        const refundResult = await refundPaymentTransactions({
          paymentId: result.paymentId,
          amountCents: result.pendingRefundAmountCents,
          metadata: { bookingId, reason: "batch_modification" },
          idempotencyKeyPrefix: `mod_batch_refund_${bookingId}`,
        });
        stripeRefundId = refundResult.refunds[0]?.refundId;
      } catch (refundErr) {
        logger.error(
          { err: refundErr, bookingId, amount: result.pendingRefundAmountCents },
          "Stripe refund failed after batch modification - requires manual reconciliation"
        );
      }
    }

    // --- Post-transaction side effects (fire-and-forget) ---

    let additionalPaymentClientSecret: string | undefined;
    if (result.additionalAmountCents > 0 && result.hasSucceededPayment && result.paymentId) {
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

        await upsertPaymentIntentTransaction({
          paymentId: result.paymentId,
          kind: PaymentTransactionKind.ADDITIONAL,
          paymentIntentId: pi.id,
          amountCents: result.additionalAmountCents,
          status: PaymentStatus.PENDING,
          reason: "batch_modify_price_increase",
          stripeCustomerId: customerId,
        });

        additionalPaymentClientSecret = pi.client_secret ?? undefined;
      } catch (piErr) {
        logger.error(
          { err: piErr, bookingId },
          "Failed to create additional PaymentIntent for batch modification"
        );
      }
    }

    // Audit log
    logAudit({
      action: "booking.modify.batch",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: result.booking.memberId,
      entityType: "BookingModification",
      entityId: result.bookingModificationId,
      category: "booking",
      outcome: "success",
      summary: "Booking modified",
      details: JSON.stringify({
        datesChanged: result.datesChanged,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        priceDiffCents: result.priceDiffCents,
        changeFeeCents: result.changeFeeCents,
        refundAmountCents: result.refundAmountCents,
        promoRemoved: result.promoRemoved,
        promoChanged: result.promoChanged,
      }),
      metadata: {
        bookingId,
        datesChanged: result.datesChanged,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        priceDiffCents: result.priceDiffCents,
        changeFeeCents: result.changeFeeCents,
        refundAmountCents: result.refundAmountCents,
        promoRemoved: result.promoRemoved,
        promoChanged: result.promoChanged,
      },
      ipAddress,
    });

    // Xero integration
    const kickQueuedXeroOperation = async (queued: { queueOperationId: string | null }) => {
      if (queued.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    };

    if (result.xeroAdditionalAmountCents > 0) {
      void enqueueXeroSupplementaryInvoiceOperation(
        {
          bookingId,
          priceDiffCents: Math.max(result.priceDiffCents, 0),
          changeFeeCents: result.changeFeeCents,
          bookingModificationId: result.bookingModificationId,
        },
        {
          createdByMemberId: session.user.id,
        }
      )
        .then(kickQueuedXeroOperation)
        .catch((err) =>
          logger.error({ err, bookingId }, "Failed to queue Xero supplementary invoice for batch modification")
        );
    } else if (result.xeroRefundAmountCents > 0) {
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
        .then(kickQueuedXeroOperation)
        .catch((err) =>
          logger.error({ err, bookingId }, "Failed to queue Xero credit note for batch modification")
        );
    }

    if (result.hasIssuedXeroInvoice && result.datesChanged) {
      void enqueueXeroBookingInvoiceUpdateOperation(bookingId, {
        createdByMemberId: session.user.id,
      })
        .then(kickQueuedXeroOperation)
        .catch((err) =>
          logger.error({ err, bookingId }, "Failed to queue Xero primary invoice update for batch date modification")
        );
    }

    // Email notification
    const member = await prisma.member.findUnique({
      where: { id: result.booking.memberId },
    });
    if (member) {
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
        oldFinalPriceCents: booking_finalPriceCentsFromDiff(result),
        newFinalPriceCents: result.booking.finalPriceCents,
        changeFeeCents: result.changeFeeCents,
        refundAmountCents: result.refundAmountCents,
        additionalAmountCents: result.additionalAmountCents,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send batch modification email")
      );
    }

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
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(err),
        { status: err.status }
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Failed to modify booking";
    logger.error({ err, bookingId }, "Batch modify failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function booking_finalPriceCentsFromDiff(result: {
  booking: { finalPriceCents: number };
  priceDiffCents: number;
}): number {
  return result.booking.finalPriceCents - result.priceDiffCents;
}
