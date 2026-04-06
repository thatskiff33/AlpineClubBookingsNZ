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
} from "@/lib/cancellation";
import { validatePromoCodeRules } from "@/lib/promo";
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

  if (!["PENDING", "CONFIRMED"].includes(booking.status)) {
    return NextResponse.json(
      { error: "Only PENDING or CONFIRMED bookings can be modified" },
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

  const { checkIn: newCheckInStr, checkOut: newCheckOutStr, addGuests, removeGuestIds } = parsed.data;

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

  // Calculate new price
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

  // Check promo code validity
  let newDiscountCents = 0;
  let promoStillValid = true;

  if (booking.promoRedemption?.promoCode) {
    const promo = booking.promoRedemption.promoCode;
    const validationError = validatePromoCodeRules(
      promo,
      { memberId: booking.memberId },
      new Date(),
      0 // Don't count existing redemption against itself
    );

    if (validationError) {
      promoStillValid = false;
    } else {
      // Recalculate discount with new price
      const allPerNightRates = guestsForPricing.flatMap((guest) => {
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
    }
  }

  const newFinalPriceCents = newTotalPriceCents - newDiscountCents;
  const priceDiffCents = newFinalPriceCents - booking.finalPriceCents;

  // Calculate change fee (only if check-in date is changing)
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

  return NextResponse.json({
    newTotalPriceCents,
    newDiscountCents,
    newFinalPriceCents,
    priceDiffCents,
    changeFeeCents,
    capacityAvailable: capacity.available,
    promoStillValid,
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
