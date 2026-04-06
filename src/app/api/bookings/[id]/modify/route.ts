import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkCapacity } from "@/lib/capacity";
import {
  calculateBookingPrice,
  calculatePromoDiscount,
  type SeasonRateData,
} from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  daysUntilDate,
  loadCancellationPolicy,
  getNonMemberHoldDays,
} from "@/lib/cancellation";
import { validatePromoCodeRules, redeemPromoCode } from "@/lib/promo";
import { processRefund } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import { cleanupChoreAssignmentsForDateChange } from "@/lib/chore-cleanup";
import {
  createXeroSupplementaryInvoice,
  createXeroCreditNoteForModification,
} from "@/lib/xero";
import logger from "@/lib/logger";
import { z } from "zod";

const batchModifySchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
        isMember: z.boolean(),
        memberId: z.string().optional(),
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
          promoRedemption: { include: { promoCode: true } },
        },
      });

      if (!booking) throw new ApiError("Booking not found", 404);

      if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
        throw new ApiError("Forbidden", 403);
      }

      if (!["PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
        throw new ApiError("Only PENDING, CONFIRMED, or PAID bookings can be modified", 400);
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

      // Determine guest changes
      const removeSet = new Set(removeGuestIds ?? []);
      const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
      const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

      if (remainingGuests.length === 0 && (!addGuests || addGuests.length === 0)) {
        throw new ApiError("Booking must have at least one guest", 400);
      }

      const guestsForPricing = [
        ...remainingGuests.map((g) => ({
          ageTier: g.ageTier as "ADULT" | "YOUTH" | "CHILD",
          isMember: g.isMember,
        })),
        ...(addGuests ?? []).map((g) => ({
          ageTier: g.ageTier as "ADULT" | "YOUTH" | "CHILD",
          isMember: g.isMember,
        })),
      ];

      const totalGuestCount = guestsForPricing.length;

      // Capacity check excluding this booking
      const capacity = await checkCapacity(newCheckIn, newCheckOut, totalGuestCount, bookingId);
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
        });

        if (!promoCode) throw new ApiError("Promo code not found", 400);

        // Check single-use
        let memberRedemptionCount = 0;
        if (promoCode.singleUse) {
          memberRedemptionCount = await tx.promoRedemption.count({
            where: { promoCodeId: promoCode.id, memberId: booking.memberId },
          });
        }

        const validationError = validatePromoCodeRules(
          promoCode,
          { memberId: booking.memberId },
          new Date(),
          memberRedemptionCount
        );

        if (validationError) throw new ApiError(validationError, 400);

        const allPerNightRates = guestsForPricing.flatMap((guest) => {
          const breakdown = calculateBookingPrice(newCheckIn, newCheckOut, [guest], seasonRateData);
          return breakdown.guests[0].perNightCents;
        });

        newDiscountCents = calculatePromoDiscount(
          {
            type: promoCode.type,
            valueCents: promoCode.valueCents,
            percentOff: promoCode.percentOff,
            freeNights: promoCode.freeNights,
          },
          newTotalPriceCents,
          allPerNightRates
        );

        await redeemPromoCode(tx, promoCode.id, bookingId, booking.memberId, newDiscountCents);
        promoChanged = true;
      } else if (!removePromoCode && !promoRemoved && booking.promoRedemption?.promoCode) {
        // Keep existing promo, recalculate discount
        const promo = booking.promoRedemption.promoCode;
        const validationError = validatePromoCodeRules(
          promo,
          { memberId: booking.memberId },
          new Date(),
          0
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
          const allPerNightRates = guestsForPricing.flatMap((guest) => {
            const breakdown = calculateBookingPrice(newCheckIn, newCheckOut, [guest], seasonRateData);
            return breakdown.guests[0].perNightCents;
          });

          newDiscountCents = calculatePromoDiscount(
            {
              type: promo.type,
              valueCents: promo.valueCents,
              percentOff: promo.percentOff,
              freeNights: promo.freeNights,
            },
            newTotalPriceCents,
            allPerNightRates
          );

          await tx.promoRedemption.update({
            where: { id: booking.promoRedemption.id },
            data: { discountCents: newDiscountCents },
          });
        }
      }

      const newFinalPriceCents = newTotalPriceCents - newDiscountCents;
      const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

      // Calculate change fee (only if check-in changed)
      let changeFeeCents = 0;
      const checkInChanged = newCheckIn.getTime() !== new Date(booking.checkIn).getTime();
      const datesChanged = checkInChanged || newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

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

      // --- Delete removed guests and their chore assignments ---
      for (const guest of removedGuests) {
        await tx.choreAssignment.deleteMany({ where: { bookingGuestId: guest.id } });
        await tx.bookingGuest.delete({ where: { id: guest.id } });
      }

      // --- Create new guests ---
      const createdGuests = [];
      const addedGuestStartIndex = remainingGuests.length;
      for (let i = 0; i < (addGuests ?? []).length; i++) {
        const g = addGuests![i];
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
      let stripeRefundId: string | undefined;

      const hasSucceededPayment =
        ["CONFIRMED", "PAID"].includes(booking.status) &&
        booking.payment?.status === "SUCCEEDED";

      if (hasSucceededPayment && booking.payment) {
        if (priceDiffCents < 0) {
          refundAmountCents = Math.abs(priceDiffCents);
          if (booking.payment.stripePaymentIntentId && refundAmountCents > 0) {
            const refund = await processRefund({
              paymentIntentId: booking.payment.stripePaymentIntentId,
              amountCents: refundAmountCents,
              metadata: { bookingId: booking.id, reason: "batch_modification" },
            });
            stripeRefundId = refund.id;

            const newRefundedTotal = booking.payment.refundedAmountCents + refundAmountCents;
            await tx.payment.update({
              where: { id: booking.payment.id },
              data: {
                refundedAmountCents: newRefundedTotal,
                status: "PARTIALLY_REFUNDED",
              },
            });
          }
        } else if (priceDiffCents > 0 || changeFeeCents > 0) {
          additionalAmountCents = Math.max(priceDiffCents, 0) + changeFeeCents;
        }

        if (changeFeeCents > 0) {
          await tx.payment.update({
            where: { id: booking.payment.id },
            data: { changeFeeCents: { increment: changeFeeCents } },
          });
        }
      }

      // --- Update hasNonMembers and nonMemberHoldUntil ---
      const allGuestsNowMembers = guestsForPricing.every((g) => g.isMember);
      const hasNonMembers = !allGuestsNowMembers;
      let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
      let newStatus = booking.status;

      if (hasNonMembers) {
        const holdDays = await getNonMemberHoldDays(newCheckIn);
        const daysUntilNewCheckIn = Math.ceil(
          (newCheckIn.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntilNewCheckIn <= holdDays) {
          newNonMemberHoldUntil = null;
          if (booking.status === "PENDING") {
            newStatus = "CONFIRMED";
          }
        } else {
          newNonMemberHoldUntil = new Date(
            newCheckIn.getTime() - holdDays * 24 * 60 * 60 * 1000
          );
        }
      } else {
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
        },
        include: { guests: true, payment: true },
      });

      // --- Create modification record ---
      await tx.bookingModification.create({
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
            addedGuests: (addGuests ?? []).map((g) => ({
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
        stripeRefundId,
        promoRemoved,
        promoChanged,
        choreWarnings,
        datesChanged,
        oldCheckIn: booking.checkIn,
        oldCheckOut: booking.checkOut,
        oldGuestCount: booking.guests.length,
      };
    });

    // --- Post-transaction side effects (fire-and-forget) ---

    // Audit log
    logAudit({
      action: "booking.modify.batch",
      memberId: session.user.id,
      targetId: bookingId,
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
      ipAddress,
    });

    // Xero integration
    if (result.additionalAmountCents > 0 || result.changeFeeCents > 0) {
      createXeroSupplementaryInvoice({
        bookingId,
        priceDiffCents: Math.max(result.priceDiffCents, 0),
        changeFeeCents: result.changeFeeCents,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to create Xero supplementary invoice for batch modification")
      );
    } else if (result.refundAmountCents > 0) {
      createXeroCreditNoteForModification({
        bookingId,
        refundAmountCents: result.refundAmountCents,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to create Xero credit note for batch modification")
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
      stripeRefundId: result.stripeRefundId,
      promoRemoved: result.promoRemoved,
      promoChanged: result.promoChanged,
      choreWarnings: result.choreWarnings,
    });
  } catch (err) {
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
