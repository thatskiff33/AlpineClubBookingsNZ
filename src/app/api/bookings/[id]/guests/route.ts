import { NextRequest, NextResponse } from "next/server";
import { PaymentStatus, PaymentTransactionKind, type AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkCapacity } from "@/lib/capacity";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  deletePromoRedemptionAndAdjustCount,
  replacePromoRedemptionAllocations,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";
import { createPaymentIntent, findOrCreateCustomer } from "@/lib/stripe";
import logger from "@/lib/logger";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { nameField } from "@/lib/zod-helpers";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

const addGuestsSchema = z.object({
  guests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: ageTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
      })
    )
    .min(1)
    .max(LODGE_CAPACITY),
});

export async function POST(
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
  const parsed = addGuestsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { guests: newGuests } = parsed.data;
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
          "Use the full booking edit flow for in-progress booking guest changes",
          400
        );
      }

      let normalizedNewGuests = newGuests;
      try {
        const linkedMembers = await resolveLinkedBookingMembers(
          tx,
          booking.memberId,
          newGuests.map((guest) => guest.memberId),
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
        normalizedNewGuests = normalizeBookingGuestInputs(newGuests, linkedMembers);
      } catch (error) {
        if (error instanceof BookingGuestValidationError) {
          throw error;
        }
        throw error;
      }

      if (session.user.role !== "ADMIN") {
        const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
          bookingMemberId: booking.memberId,
          checkIn: booking.checkIn,
          guests: normalizedNewGuests,
        });

        if (unpaidMemberGuests.length > 0) {
          throw new ApiError(
            `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
            403
          );
        }
      }

      const totalGuestCount = booking.guests.length + normalizedNewGuests.length;

      // Capacity check excluding this booking (using tx to participate in advisory lock)
      const capacity = await checkCapacity(
        booking.checkIn,
        booking.checkOut,
        totalGuestCount,
        bookingId,
        tx
      );

      if (!capacity.available) {
        throw new ApiError(
          "Not enough beds available to add these guests",
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

      // Calculate price for new guests
      const newGuestInputs = normalizedNewGuests.map((g) => ({
        ageTier: g.ageTier as AgeTier,
        isMember: g.isMember,
        memberId: g.memberId ?? null,
      }));

      let newGuestPrice;
      try {
        newGuestPrice = calculateBookingPrice(
          booking.checkIn,
          booking.checkOut,
          newGuestInputs,
          seasonRateData
        );
      } catch {
        throw new ApiError(
          "No season rate found for the booking dates",
          400
        );
      }

      // Create BookingGuest records
      const createdGuests = [];
      for (let i = 0; i < normalizedNewGuests.length; i++) {
        const guest = await tx.bookingGuest.create({
          data: {
            bookingId,
            firstName: normalizedNewGuests[i].firstName,
            lastName: normalizedNewGuests[i].lastName,
            ageTier: normalizedNewGuests[i].ageTier,
            isMember: normalizedNewGuests[i].isMember,
            memberId: normalizedNewGuests[i].memberId || null,
            stayStart: booking.checkIn,
            stayEnd: booking.checkOut,
            priceCents: newGuestPrice.guests[i].priceCents,
          },
        });
        createdGuests.push(guest);
      }

      // Recalculate total booking price with all guests
      const allGuestsForPricing = [
        ...booking.guests.map((g) => ({
          ageTier: g.ageTier as AgeTier,
          isMember: g.isMember,
          memberId: g.memberId ?? null,
        })),
        ...newGuestInputs,
      ];
      const requiresAdminReview = requiresAdultSupervisionReview(allGuestsForPricing);
      const adminReviewReason = requiresAdminReview
        ? ADULT_SUPERVISION_REVIEW_REASON
        : null;

      const fullPriceBreakdown = calculateBookingPrice(
        booking.checkIn,
        booking.checkOut,
        allGuestsForPricing,
        seasonRateData
      );
      const guestNightRates = allGuestsForPricing.map((guest, index) => ({
        memberId: guest.memberId ?? null,
        isMember: guest.isMember,
        perNightRates: fullPriceBreakdown.guests[index].perNightCents,
      }));

      const newTotalPriceCents = fullPriceBreakdown.totalPriceCents;

      // Recalculate promo discount
      let newDiscountCents = 0;
      let promoRemoved = false;

      if (booking.promoRedemption?.promoCode) {
        const promo = booking.promoRedemption.promoCode;
        const application = await validateAndCalculatePromoDiscount(
          promo,
          {
            memberId: booking.memberId,
            bookingCheckIn: booking.checkIn,
            totalPriceCents: newTotalPriceCents,
            guests: guestNightRates,
          },
          promo.assignments.length > 0
            ? promo.assignments.map((assignment) => assignment.memberId)
            : null,
          { excludeBookingId: bookingId, db: tx }
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

      // Update hasNonMembers
      const addingNonMembers = normalizedNewGuests.some((g) => !g.isMember);
      const hasNonMembers = booking.hasNonMembers || addingNonMembers;

      // Update nonMemberHoldUntil if adding non-members
      let nonMemberHoldUntil = booking.nonMemberHoldUntil;
      if (addingNonMembers && !booking.hasNonMembers) {
        const holdDays = await getNonMemberHoldDays(booking.checkIn);
        const daysUntilCheckIn = Math.ceil(
          (new Date(booking.checkIn).getTime() - new Date().getTime()) /
            (1000 * 60 * 60 * 24)
        );
        if (daysUntilCheckIn > holdDays && booking.status === "PENDING") {
          nonMemberHoldUntil = new Date(
            new Date(booking.checkIn).getTime() -
              holdDays * 24 * 60 * 60 * 1000
          );
        }
      }

      // Calculate additional amount for confirmed+paid bookings
      let additionalAmountCents = 0;
      const hasSucceededPayment =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        booking.payment?.status === "SUCCEEDED";
      const hasIssuedXeroInvoice =
        ["PAYMENT_PENDING", "CONFIRMED", "PAID"].includes(booking.status) &&
        !!booking.payment?.xeroInvoiceId;

      if ((hasSucceededPayment || hasIssuedXeroInvoice) && priceDiffCents > 0) {
        additionalAmountCents = priceDiffCents;
      }

      // This route only adds guests, so the no-adult rule can only
      // change from flagged → cleared (by adding an adult). When that
      // happens, wipe the review state and release the booking from
      // AWAITING_REVIEW. The rule cannot newly trip through this route.
      const reviewCleared = booking.requiresAdminReview && !requiresAdminReview;
      const reviewFieldUpdates = reviewCleared
        ? {
            requiresAdminReview: false,
            adminReviewReason: null,
            memberReviewJustification: null,
            adminReviewStatus: null,
            adminReviewNotes: null,
            adminReviewedById: null,
            adminReviewedAt: null,
          }
        : {
            requiresAdminReview,
            adminReviewReason,
          };

      const newStatus =
        reviewCleared && booking.status === "AWAITING_REVIEW"
          ? "PAYMENT_PENDING"
          : booking.status;

      const updatedBooking = await tx.booking.update({
        where: { id: bookingId },
        data: {
          totalPriceCents: newTotalPriceCents,
          discountCents: newDiscountCents,
          finalPriceCents: newFinalPriceCents,
          hasNonMembers,
          nonMemberHoldUntil,
          status: newStatus,
          ...reviewFieldUpdates,
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

      // Create BookingModification record
      const bookingModification = await tx.bookingModification.create({
        data: {
          bookingId,
          memberId: session.user.id,
          modificationType: "GUEST_ADD",
          previousData: {
            guestCount: booking.guests.length,
            totalPriceCents: booking.totalPriceCents,
            finalPriceCents: booking.finalPriceCents,
          },
          newData: {
            guestCount: updatedBooking.guests.length,
            addedGuests: normalizedNewGuests.map((g) => ({
              firstName: g.firstName,
              lastName: g.lastName,
              ageTier: g.ageTier,
              isMember: g.isMember,
            })),
            totalPriceCents: newTotalPriceCents,
            finalPriceCents: newFinalPriceCents,
          },
          priceDiffCents,
          changeFeeCents: 0,
        },
      });

      return {
        booking: updatedBooking,
        addedGuests: createdGuests,
        priceDiffCents,
        additionalAmountCents,
        promoRemoved,
        oldGuestCount: booking.guests.length,
        hasSucceededPayment,
        hasIssuedXeroInvoice,
        paymentStatus: booking.payment?.status ?? null,
        paymentId: booking.payment?.id ?? null,
        paymentCustomerId: booking.payment?.stripeCustomerId ?? null,
        memberEmail: booking.member.email,
        memberName: `${booking.member.firstName} ${booking.member.lastName}`,
        memberId: booking.memberId,
        addedGuestNames: normalizedNewGuests.map((guest) => `${guest.firstName} ${guest.lastName}`),
        bookingModificationId: bookingModification.id,
      };
    });

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
            reason: "guest_add_price_increase",
          },
          idempotencyKey: `mod_guest_${bookingId}_${result.bookingModificationId}`,
        });

        await upsertPaymentIntentTransaction({
          paymentId: result.paymentId,
          kind: PaymentTransactionKind.ADDITIONAL,
          paymentIntentId: pi.id,
          amountCents: result.additionalAmountCents,
          status: PaymentStatus.PENDING,
          reason: "guest_add_price_increase",
          stripeCustomerId: customerId,
        });

        additionalPaymentClientSecret = pi.client_secret ?? undefined;
        additionalPaymentIntentId = pi.id;
      } catch (piErr) {
        logger.error({ err: piErr, bookingId }, "Failed to create additional PaymentIntent for guest addition");
      }
    }

    // Audit log
    logAudit({
      action: "booking.modify.guests.add",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: result.booking.memberId,
      entityType: "BookingModification",
      entityId: result.bookingModificationId,
      category: "booking",
      outcome: "success",
      summary: "Booking guests added",
      details: JSON.stringify({
        addedGuests: result.addedGuestNames,
        priceDiffCents: result.priceDiffCents,
      }),
      metadata: {
        bookingId,
        addedGuests: result.addedGuestNames,
        priceDiffCents: result.priceDiffCents,
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
      requiresAdditionalStripePayment:
        result.hasIssuedXeroInvoice && result.priceDiffCents > 0 && result.hasSucceededPayment,
      additionalPaymentIntentId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to queue Xero settlement for guest addition")
    );

    // Send email
    const member = await prisma.member.findUnique({
      where: { id: result.booking.memberId },
    });
    if (member) {
      sendBookingModifiedEmail({
        email: member.email,
        firstName: member.firstName,
        modificationType: "GUEST_ADD",
        oldCheckIn: result.booking.checkIn,
        oldCheckOut: result.booking.checkOut,
        newCheckIn: result.booking.checkIn,
        newCheckOut: result.booking.checkOut,
        oldGuestCount: result.oldGuestCount,
        newGuestCount: result.booking.guests.length,
        oldFinalPriceCents: result.booking.finalPriceCents - result.priceDiffCents,
        newFinalPriceCents: result.booking.finalPriceCents,
        changeFeeCents: 0,
        refundAmountCents: 0,
        additionalAmountCents: result.additionalAmountCents,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send booking modified email")
      );
    }

    return NextResponse.json({
      booking: result.booking,
      addedGuests: result.addedGuests,
      priceDiffCents: result.priceDiffCents,
      additionalAmountCents: result.additionalAmountCents,
      additionalPaymentClientSecret: additionalPaymentClientSecret ?? null,
      promoRemoved: result.promoRemoved,
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
    const message =
      err instanceof Error ? err.message : "Failed to add guests";
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
