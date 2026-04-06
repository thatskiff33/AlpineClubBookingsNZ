import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkCapacity } from "@/lib/capacity";
import {
  calculateBookingPrice,
  calculatePromoDiscount,
  getStayNights,
  type SeasonRateData,
} from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  daysUntilDate,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import { validatePromoCodeRules, validatePromoCodeFull } from "@/lib/promo";
import { z } from "zod";

const modifyQuoteSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
        isMember: z.boolean(),
      })
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  promoCode: z.string().optional(),
  removePromoCode: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { id: bookingId } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: true,
      payment: true,
      promoRedemption: { include: { promoCode: true } },
    },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!["PENDING", "CONFIRMED", "PAID"].includes(booking.status)) {
    return NextResponse.json(
      { error: "Only PENDING, CONFIRMED, or PAID bookings can be modified" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const parsed = modifyQuoteSchema.safeParse(body);
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

  // Determine new dates
  const newCheckIn = newCheckInStr ? new Date(newCheckInStr) : booking.checkIn;
  const newCheckOut = newCheckOutStr ? new Date(newCheckOutStr) : booking.checkOut;

  if (newCheckOut <= newCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
  }

  // Determine new guest list
  const removeSet = new Set(removeGuestIds ?? []);
  const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

  if (remainingGuests.length === 0 && (!addGuests || addGuests.length === 0)) {
    return NextResponse.json(
      { error: "Booking must have at least one guest" },
      { status: 400 }
    );
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

  // Capacity check (exclude current booking)
  const capacity = await checkCapacity(
    newCheckIn,
    newCheckOut,
    totalGuestCount,
    bookingId
  );

  // Load seasons for pricing
  const seasons = await prisma.season.findMany({
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
  let newTotalPriceCents: number;
  try {
    const priceBreakdown = calculateBookingPrice(
      newCheckIn,
      newCheckOut,
      guestsForPricing,
      seasonRateData
    );
    newTotalPriceCents = priceBreakdown.totalPriceCents;
  } catch {
    return NextResponse.json(
      { error: "No season rate found for the requested dates" },
      { status: 400 }
    );
  }

  // --- Build itemized changes ---
  const itemizedChanges: Array<{ label: string; amountCents: number }> = [];

  const oldNights = getStayNights(booking.checkIn, booking.checkOut).length;
  const newNights = getStayNights(newCheckIn, newCheckOut).length;
  const datesChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime() ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

  // 1. Date change cost: price remaining guests at new dates vs old dates
  if (datesChanged && remainingGuests.length > 0) {
    const remainingForPricing = remainingGuests.map((g) => ({
      ageTier: g.ageTier as "ADULT" | "YOUTH" | "CHILD",
      isMember: g.isMember,
    }));

    try {
      const oldPriceForRemaining = calculateBookingPrice(
        booking.checkIn,
        booking.checkOut,
        remainingForPricing,
        seasonRateData
      );
      const newPriceForRemaining = calculateBookingPrice(
        newCheckIn,
        newCheckOut,
        remainingForPricing,
        seasonRateData
      );
      const dateChangeCost =
        newPriceForRemaining.totalPriceCents -
        oldPriceForRemaining.totalPriceCents;

      if (dateChangeCost !== 0) {
        const nightLabel =
          oldNights !== newNights
            ? `Date change: ${oldNights} night${oldNights !== 1 ? "s" : ""} → ${newNights} night${newNights !== 1 ? "s" : ""}`
            : "Date change (rate difference)";
        itemizedChanges.push({ label: nightLabel, amountCents: dateChangeCost });
      }
    } catch {
      // If pricing fails for old dates (unlikely), skip itemization
    }
  }

  // 2. Change fee
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

    if (changeFeeCents > 0) {
      itemizedChanges.push({
        label: "Late-notice change fee",
        amountCents: changeFeeCents,
      });
    }
  }

  // 3. Per-added-guest costs
  if (addGuests && addGuests.length > 0) {
    for (const guest of addGuests) {
      try {
        const guestPrice = calculateBookingPrice(
          newCheckIn,
          newCheckOut,
          [{ ageTier: guest.ageTier, isMember: guest.isMember }],
          seasonRateData
        );
        const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
        const memberLabel = guest.isMember ? "Member" : "Non-member";
        itemizedChanges.push({
          label: `Added: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
          amountCents: guestPrice.totalPriceCents,
        });
      } catch {
        // skip itemization if pricing fails
      }
    }
  }

  // 4. Per-removed-guest credits (use their stored priceCents)
  for (const guest of removedGuests) {
    const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
    const memberLabel = guest.isMember ? "Member" : "Non-member";
    itemizedChanges.push({
      label: `Removed: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
      amountCents: -guest.priceCents,
    });
  }

  // 5. Promo code handling
  let newDiscountCents = 0;
  let promoStillValid = true;
  let promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
  } | null = null;

  // Helper: get all per-night rates for promo calculation
  function getAllPerNightRates(): number[] {
    return guestsForPricing.flatMap((guest) => {
      try {
        const breakdown = calculateBookingPrice(
          newCheckIn,
          newCheckOut,
          [guest],
          seasonRateData
        );
        return breakdown.guests[0].perNightCents;
      } catch {
        return [];
      }
    });
  }

  if (removePromoCode) {
    // User wants to remove existing promo (for reuse later)
    newDiscountCents = 0;
    promoValidation = null;
  } else if (newPromoCode) {
    // User wants to apply a new promo code
    const validation = await validatePromoCodeFull(newPromoCode, {
      totalPriceCents: newTotalPriceCents,
      perNightRates: getAllPerNightRates(),
      memberId: booking.memberId,
    });

    if (validation.valid && validation.discountCents) {
      newDiscountCents = validation.discountCents;
      promoValidation = {
        valid: true,
        code: validation.promoCode?.code,
        discountCents: validation.discountCents,
      };
    } else {
      promoValidation = {
        valid: false,
        error: validation.error,
      };
      // Fall back to existing promo if new one fails
      if (booking.promoRedemption?.promoCode) {
        const promo = booking.promoRedemption.promoCode;
        const validationError = validatePromoCodeRules(
          promo,
          { memberId: booking.memberId },
          new Date(),
          0
        );
        if (!validationError) {
          newDiscountCents = calculatePromoDiscount(
            {
              type: promo.type,
              valueCents: promo.valueCents,
              percentOff: promo.percentOff,
              freeNights: promo.freeNights,
            },
            newTotalPriceCents,
            getAllPerNightRates()
          );
        }
      }
    }
  } else if (booking.promoRedemption?.promoCode) {
    // Keep existing promo, recalculate with new price
    const promo = booking.promoRedemption.promoCode;
    const validationError = validatePromoCodeRules(
      promo,
      { memberId: booking.memberId },
      new Date(),
      0
    );

    if (validationError) {
      promoStillValid = false;
    } else {
      newDiscountCents = calculatePromoDiscount(
        {
          type: promo.type,
          valueCents: promo.valueCents,
          percentOff: promo.percentOff,
          freeNights: promo.freeNights,
        },
        newTotalPriceCents,
        getAllPerNightRates()
      );
    }
  }

  // Add promo line item
  if (newDiscountCents > 0) {
    const promoLabel = newPromoCode
      ? `Promo '${newPromoCode.toUpperCase()}'`
      : booking.promoRedemption?.promoCode
        ? `Promo '${booking.promoRedemption.promoCode.code}'`
        : "Promo discount";
    itemizedChanges.push({
      label: promoLabel,
      amountCents: -newDiscountCents,
    });
  }

  // Show removed promo as a charge (loss of discount)
  if (removePromoCode && booking.discountCents > 0) {
    itemizedChanges.push({
      label: `Removed promo '${booking.promoRedemption?.promoCode?.code || "discount"}'`,
      amountCents: booking.discountCents,
    });
  }

  const newFinalPriceCents = newTotalPriceCents - newDiscountCents;
  const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;
  const netChargeCents = priceDiffCents + changeFeeCents;

  return NextResponse.json({
    newTotalPriceCents,
    newDiscountCents,
    newFinalPriceCents,
    priceDiffCents,
    changeFeeCents,
    netChargeCents,
    capacityAvailable: capacity.available,
    promoStillValid,
    promoValidation,
    itemizedChanges,
    ...(capacity.available
      ? {}
      : {
          nightDetails: capacity.nightDetails.map((n) => ({
            date: n.date.toISOString().split("T")[0],
            availableBeds: n.availableBeds,
          })),
        }),
  });
}
