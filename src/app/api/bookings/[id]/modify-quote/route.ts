import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { checkCapacity } from "@/lib/capacity";
import {
  calculateBookingPrice,
  getStayNights,
  type SeasonRateData,
} from "@/lib/pricing";
import { calculateChangeFee } from "@/lib/change-fee";
import {
  daysUntilDate,
  loadCancellationPolicy,
} from "@/lib/cancellation";
import {
  calculatePromoDiscountForGuestRates,
  getMemberFreeNightsUsed,
  validatePromoCodeRules,
  validatePromoCodeFull,
} from "@/lib/promo";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import {
  canModifyBookingStatus,
  usesActiveBookingLifecycle,
} from "@/lib/booking-modify-permissions";

const modifyQuoteSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
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

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      guests: true,
      payment: true,
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
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!canModifyBookingStatus(booking.status, session.user.role)) {
    return NextResponse.json(
      { error: "This booking cannot be modified in its current status" },
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
  let normalizedAddGuests = addGuests;

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      booking.memberId,
      (addGuests ?? []).map((guest) => guest.memberId),
      { skipAuthorization: session.user.role === "ADMIN" }
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
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
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status }
      );
    }
    throw error;
  }

  // Determine new dates
  const newCheckIn = newCheckInStr ? new Date(newCheckInStr) : booking.checkIn;
  const newCheckOut = newCheckOutStr ? new Date(newCheckOutStr) : booking.checkOut;
  const skipBookingLifecycleRules =
    session.user.role === "ADMIN" &&
    !usesActiveBookingLifecycle(booking.status);

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

  if (remainingGuests.length === 0 && (!normalizedAddGuests || normalizedAddGuests.length === 0)) {
    return NextResponse.json(
      { error: "Booking must have at least one guest" },
      { status: 400 }
    );
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

  if (totalGuestCount > 29) {
    return NextResponse.json(
      { error: "A booking cannot exceed 29 guests" },
      { status: 400 }
    );
  }

  if (session.user.role !== "ADMIN") {
    const unpaidMemberGuests = await findUnpaidMemberGuestNames(prisma, {
      bookingMemberId: booking.memberId,
      checkIn: newCheckIn,
      guests: normalizedAddGuests ?? [],
    });

    if (unpaidMemberGuests.length > 0) {
      return NextResponse.json(
        {
          error: `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
          code: "GUEST_SUBSCRIPTION_REQUIRED",
          unpaidMembers: unpaidMemberGuests,
        },
        { status: 403 }
      );
    }
  }

  // Minimum stay policy validation (skip for admins)
  let minimumStayViolations: { policyName: string; triggerDay: string; minimumNights: number; actualNights: number }[] = [];
  if (session.user.role !== "ADMIN") {
    const { validateMinimumStay } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(newCheckIn, newCheckOut);
    minimumStayViolations = stayResult.violations;
  }

  // Capacity check (exclude current booking)
  const capacity = skipBookingLifecycleRules
    ? { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] }
    : await checkCapacity(newCheckIn, newCheckOut, totalGuestCount, bookingId);

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
      ageTier: g.ageTier as AgeTier,
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

    if (changeFeeCents > 0) {
      itemizedChanges.push({
        label: "Late-notice change fee",
        amountCents: changeFeeCents,
      });
    }
  }

  // 3. Per-added-guest costs
  if (normalizedAddGuests && normalizedAddGuests.length > 0) {
    for (const guest of normalizedAddGuests) {
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

  // Helper: get per-night rates per guest for promo calculation
  function getGuestNightRates() {
    return guestsForPricing.map((guest) => {
      try {
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
      } catch {
        return {
          memberId: guest.memberId ?? null,
          perNightRates: [],
        };
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
      perNightRates: guestsForPricing.flatMap((guest) => {
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
      }),
      memberId: booking.memberId,
      guestNightRates: getGuestNightRates(),
    }, bookingId);

    if (validation.valid) {
      newDiscountCents = validation.discountCents ?? 0;
      promoValidation = {
        valid: true,
        code: validation.promoCode?.code,
        discountCents: validation.discountCents ?? 0,
      };
    } else {
      promoValidation = {
        valid: false,
        error: validation.error,
      };
      // Invalid new promo — discount stays 0, don't fall back to old promo
    }
  } else if (booking.promoRedemption?.promoCode) {
    // Keep existing promo, recalculate with new price
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
      promoStillValid = false;
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
        getGuestNightRates(),
        promo.assignments.length > 0
          ? promo.assignments.map((assignment) => assignment.memberId)
          : null,
        undefined,
        remainingFreeNights
      );
      newDiscountCents = promoResult.discountCents;
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
    minimumStayValid: minimumStayViolations.length === 0,
    minimumStayViolations,
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
