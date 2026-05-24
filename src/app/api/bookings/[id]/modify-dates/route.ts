import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
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
} from "@/lib/promo";
import { createPaymentIntent, findOrCreateCustomer } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import {
  queueSupersededAdditionalIntentCancellations,
  queueSupersededPrimaryIntentCancellations,
} from "@/lib/booking-payment-cleanup";
import { processWaitlistForDates } from "@/lib/waitlist";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { normalizeDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";
import {
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";

const modifyDatesSchema = z
  .object({
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
  })
  .refine((d) => d.checkIn || d.checkOut, {
    message: "At least one of checkIn or checkOut is required",
  });

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      },
      { status: 400 }
    );
  }

  const parsed = modifyDatesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn: newCheckInStr, checkOut: newCheckOutStr } = parsed.data;

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

      if (!["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
        throw new ApiError(
          "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
          400
        );
      }

      const editPolicy = getBookingEditPolicy({
        status: booking.status,
        role: session.user.role,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      });
      if (!editPolicy.canModify) {
        throw new ApiError(
          editPolicy.reason ?? "This booking cannot be modified",
          400
        );
      }
      if (editPolicy.mode !== "future") {
        throw new ApiError(
          "Use the full booking edit flow for in-progress booking date changes",
          400
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
        session.user.role !== "ADMIN" &&
        normalizeDateOnlyForTimeZone(newCheckIn) <= editPolicy.today
      ) {
        throw new ApiError(
          "NZ today and earlier are locked for self-service changes",
          400
        );
      }

      // Minimum stay policy validation (skip for admins)
      if (session.user.role !== "ADMIN") {
        const { validateMinimumStay, formatViolationsDetail } = await import("@/lib/booking-policies");
        const stayResult = await validateMinimumStay(newCheckIn, newCheckOut);
        if (!stayResult.valid) {
          throw new ApiError(
            formatViolationsDetail(stayResult.violations),
            400
          );
        }
      }

      // Capacity check excluding this booking (using tx to participate in advisory lock)
      const capacity = await checkCapacity(
        newCheckIn,
        newCheckOut,
        booking.guests.length,
        bookingId,
        tx
      );

      if (!capacity.available) {
        throw new ApiError(
          "Not enough beds available for the new dates",
          400
        );
      }

      // Load seasons for pricing
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

      // Recalculate price with new dates
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
          seasonRateData
        );
      } catch {
        throw new ApiError(
          "No season rate found for the requested dates",
          400
        );
      }

      const newTotalPriceCents = priceBreakdown.totalPriceCents;
      const guestNightRates = guestsForPricing.map((guest, index) => ({
        memberId: guest.memberId ?? null,
        perNightRates: priceBreakdown.guests[index].perNightCents,
      }));

      // Handle promo code recalculation
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
          // Promo no longer valid - remove it
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

          // Update redemption discount
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
      const checkInChanged =
        newCheckIn.getTime() !== new Date(booking.checkIn).getTime();

      if (checkInChanged) {
        const now = new Date();
        // Business rule: change fee is calculated against the ORIGINAL check-in date's
        // cancellation policy. This is because the member's cancellation obligations were
        // established when the booking was first created. Using the new date's policy could
        // allow gaming the system by first moving to a date with a more lenient policy.
        const policy = await loadCancellationPolicy(booking.checkIn);
        const feeResult = calculateChangeFee({
          daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, now),
          daysUntilNewCheckIn: daysUntilDate(newCheckIn, now),
          originalFinalPriceCents: booking.finalPriceCents,
          policyRules: policy,
        });
        changeFeeCents = feeResult.feeCents;
      }

      // Handle payment adjustments for CONFIRMED bookings with SUCCEEDED payment
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
      const xeroRefundAmountCents =
        xeroNetAmountCents < 0 ? Math.abs(xeroNetAmountCents) : 0;
      const xeroAdditionalAmountCents =
        xeroNetAmountCents > 0 ? xeroNetAmountCents : 0;

      // Capture refund/charge info for Stripe calls after transaction commits
      // (avoids holding advisory lock during external API calls)
      let pendingRefundAmountCents = 0;

      if (hasSucceededPayment && booking.payment) {
        // Net the price difference against any change fee:
        // e.g. price drops $20 but $15 change fee → net refund $5
        // e.g. price drops $10 but $15 change fee → net charge $5
        const netAmountCents = priceDiffCents + changeFeeCents;

        if (netAmountCents < 0) {
          // Net effect is a refund (price decrease exceeds change fee)
          refundAmountCents = Math.abs(netAmountCents);
          pendingRefundAmountCents = refundAmountCents;
        } else if (netAmountCents > 0) {
          // Net effect is a charge (price increase and/or change fee exceeds any decrease)
          additionalAmountCents = netAmountCents;
        }
        // netAmountCents === 0: price decrease exactly equals change fee, no Stripe action needed

        // Track change fee on payment record
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

      // Recalculate non-member hold
      const hasNonMembers = booking.guests.some((g) => !g.isMember);
      let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
      let newStatus = booking.status;

      if (hasNonMembers) {
        const holdDays = await getNonMemberHoldDays(newCheckIn);
        const daysUntilNewCheckIn = Math.ceil(
          (newCheckIn.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntilNewCheckIn <= holdDays) {
          // Within hold period - move PENDING bookings to immediate payment.
          newNonMemberHoldUntil = null;
          if (booking.status === "PENDING") {
            newStatus = "PAYMENT_PENDING";
          }
        } else {
          newNonMemberHoldUntil = new Date(
            newCheckIn.getTime() - holdDays * 24 * 60 * 60 * 1000
          );
        }
      } else {
        newNonMemberHoldUntil = null;
      }

      // Update guest prices (parallel to avoid sequential N+1)
      await Promise.all(
        booking.guests.map((g, i) =>
          tx.bookingGuest.update({
            where: { id: g.id },
            data: {
              stayStart: newCheckIn,
              stayEnd: newCheckOut,
              priceCents: priceBreakdown.guests[i].priceCents,
            },
          })
        )
      );

      // CHR-01: Clean up chore assignments for dates no longer in range
      const oldCheckIn = new Date(booking.checkIn);
      const oldCheckOut = new Date(booking.checkOut);
      const datesChanged =
        newCheckIn.getTime() !== oldCheckIn.getTime() ||
        newCheckOut.getTime() !== oldCheckOut.getTime();
      const dateCleanup = await cleanupChoreAssignmentsForDateChange(
        tx,
        bookingId,
        newCheckIn,
        newCheckOut
      );
      const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
        tx,
        bookingId
      );
      const choreWarnings = [
        ...dateCleanup.choreWarnings,
        ...rangeCleanup.choreWarnings,
      ];

      // Update booking
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

      // Defence in depth: date-only changes cannot drop a booking to zero
      // today, but a future change that adds promo recalculation to this
      // route would. Call the symmetric cleanup helper so the invariant
      // is enforced from both modify endpoints.
      if (updatedBooking.payment) {
        await queueSupersededPrimaryIntentCancellations(tx, {
          bookingId,
          paymentId: updatedBooking.payment.id,
          newFinalPriceCents,
        });
      }

      // Create BookingModification record
      const bookingModification = await tx.bookingModification.create({
        data: {
          bookingId,
          memberId: session.user.id,
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

    // Process Stripe refund outside transaction (avoids holding advisory lock during API call)
    let stripeRefundId: string | undefined;
    if (result.pendingRefundAmountCents > 0 && result.paymentId) {
      try {
        const refundResult = await refundPaymentTransactions({
          paymentId: result.paymentId,
          amountCents: result.pendingRefundAmountCents,
          metadata: { bookingId, reason: "date_change_price_decrease" },
          idempotencyKeyPrefix: `mod_dates_refund_${bookingId}`,
        });
        stripeRefundId = refundResult.refunds[0]?.refundId;
      } catch (refundErr) {
        logger.error({ err: refundErr, bookingId, amount: result.pendingRefundAmountCents },
          "Stripe refund failed after date change - requires manual reconciliation");
      }
    }

    // Create additional PaymentIntent for price increases (outside transaction to avoid holding advisory lock)
    let additionalPaymentClientSecret: string | undefined;
    let additionalPaymentIntentId: string | undefined;
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
            reason: "date_change_price_increase",
          },
          idempotencyKey: `mod_dates_${bookingId}_${result.bookingModificationId}`,
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
          reason: "date_change_price_increase",
          stripeCustomerId: customerId,
        });

        additionalPaymentClientSecret = pi.client_secret ?? undefined;
        additionalPaymentIntentId = pi.id;
      } catch (piErr) {
        logger.error({ err: piErr, bookingId }, "Failed to create additional PaymentIntent for modification");
        // Non-fatal: modification already applied, payment can be collected via booking detail page
      }
    }

    // Audit log (fire-and-forget)
    logAudit({
      action: "booking.modify.dates",
      memberId: session.user.id,
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
      createdByMemberId: session.user.id,
      hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
      originalPaymentStatus: result.paymentStatus,
      priceDiffCents: result.priceDiffCents,
      changeFeeCents: result.changeFeeCents,
      datesChanged: result.datesChanged,
      requiresAdditionalStripePayment:
        result.xeroAdditionalAmountCents > 0 && result.hasSucceededPayment,
      additionalPaymentIntentId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to queue Xero settlement for date modification")
    );

    // Send email notification (fire-and-forget)
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
        logger.error({ err, bookingId }, "Failed to send booking modified email")
      );
    }

    // If dates changed, trigger waitlist processing for the old date range
    // (which may have freed capacity)
    if (
      result.oldCheckIn.getTime() !== result.booking.checkIn.getTime() ||
      result.oldCheckOut.getTime() !== result.booking.checkOut.getTime()
    ) {
      processWaitlistForDates({
        checkIn: result.oldCheckIn,
        checkOut: result.oldCheckOut,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to process waitlist after date modification")
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
      choreWarnings: result.choreWarnings,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message =
      err instanceof Error ? err.message : "Failed to modify booking dates";
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
