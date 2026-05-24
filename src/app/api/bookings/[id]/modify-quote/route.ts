import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";
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
import { nameField } from "@/lib/zod-helpers";
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  buildInProgressGuestRangePlan,
  type BookingEditGuestRangePlan,
} from "@/lib/booking-edit-guest-ranges";
import { formatDateOnly, normalizeDateOnlyForTimeZone, parseDateOnly } from "@/lib/date-only";

const modifyQuoteSchema = z.object({
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

  if (!canModifyBookingStatusForRole(booking.status, session.user.role)) {
    return NextResponse.json(
      { error: "This booking cannot be modified in its current status" },
      { status: 400 }
    );
  }

  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: session.user.role,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  if (!editPolicy.canModify) {
    return NextResponse.json(
      { error: editPolicy.reason ?? "This booking cannot be modified" },
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
  const requestedCheckIn = newCheckInStr ? parseDateOnly(newCheckInStr) : booking.checkIn;
  const requestedCheckOut = newCheckOutStr ? parseDateOnly(newCheckOutStr) : booking.checkOut;
  if (
    Number.isNaN(requestedCheckIn.getTime()) ||
    Number.isNaN(requestedCheckOut.getTime())
  ) {
    return NextResponse.json(
      { error: "Invalid booking dates" },
      { status: 400 }
    );
  }

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const bookingCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);
  const editableFrom = editPolicy.editableFrom;

  if (isInProgressEdit) {
    if (
      newCheckInStr &&
      formatDateOnly(normalizeDateOnlyForTimeZone(requestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      return NextResponse.json(
        { error: "Check-in cannot be changed for an in-progress booking" },
        { status: 400 }
      );
    }
    if (editableFrom && normalizeDateOnlyForTimeZone(requestedCheckOut) < editableFrom) {
      return NextResponse.json(
        { error: "NZ today and earlier are locked for self-service changes" },
        { status: 400 }
      );
    }
    if (newPromoCode || removePromoCode) {
      return NextResponse.json(
        { error: "Promo code changes are not available for in-progress bookings" },
        { status: 400 }
      );
    }
  } else if (
    session.user.role !== "ADMIN" &&
    normalizeDateOnlyForTimeZone(requestedCheckIn) <= editPolicy.today
  ) {
    return NextResponse.json(
      { error: "NZ today and earlier are locked for self-service changes" },
      { status: 400 }
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : requestedCheckIn;
  const newCheckOut = requestedCheckOut;
  const skipBookingLifecycleRules =
    session.user.role === "ADMIN" &&
    !usesActiveBookingEditLifecycle(booking.status);

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

  if (
    !isInProgressEdit &&
    remainingGuests.length === 0 &&
    (!normalizedAddGuests || normalizedAddGuests.length === 0)
  ) {
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

  if (totalGuestCount > LODGE_CAPACITY) {
    return NextResponse.json(
      { error: `A booking cannot exceed ${LODGE_CAPACITY} guests` },
      { status: 400 }
    );
  }

  if (session.user.role !== "ADMIN") {
    const unpaidMemberGuests = await findUnpaidMemberGuestNames(prisma, {
      bookingMemberId: booking.memberId,
      checkIn: isInProgressEdit && editableFrom ? editableFrom : newCheckIn,
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
  if (session.user.role !== "ADMIN" && !isInProgressEdit) {
    const { validateMinimumStay } = await import("@/lib/booking-policies");
    const stayResult = await validateMinimumStay(newCheckIn, newCheckOut);
    minimumStayViolations = stayResult.violations;
  }

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

  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  try {
    inProgressPlan =
      isInProgressEdit && editableFrom
        ? buildInProgressGuestRangePlan({
          booking: {
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            totalPriceCents: booking.totalPriceCents,
            discountCents: booking.discountCents,
            finalPriceCents: booking.finalPriceCents,
            guests: booking.guests.map((guest) => ({
              ...guest,
              ageTier: guest.ageTier as AgeTier,
            })),
          },
          editableFrom,
          newCheckOut,
          addGuests: normalizedAddGuests,
          removeGuestIds,
          seasons: seasonRateData,
        })
        : null;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to price the requested future-night changes",
      },
      { status: 400 }
    );
  }

  // Capacity check (exclude current booking)
  const capacity = skipBookingLifecycleRules
    ? { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] }
    : inProgressPlan && editableFrom
      ? await checkCapacityForGuestRanges(
          editableFrom,
          newCheckOut,
          inProgressPlan.capacityGuestRanges,
          bookingId
        )
      : await checkCapacity(newCheckIn, newCheckOut, totalGuestCount, bookingId);

  // Calculate new total price
  let newTotalPriceCents: number;
  try {
    if (inProgressPlan) {
      newTotalPriceCents = inProgressPlan.newTotalPriceCents;
    } else {
      const priceBreakdown = calculateBookingPrice(
        newCheckIn,
        newCheckOut,
        guestsForPricing,
        seasonRateData
      );
      newTotalPriceCents = priceBreakdown.totalPriceCents;
    }
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
  if (inProgressPlan) {
    if (inProgressPlan.futureExistingDeltaCents !== 0) {
      itemizedChanges.push({
        label:
          newCheckOut.getTime() !== new Date(booking.checkOut).getTime()
            ? "Future-night date change"
            : "Future-night guest range change",
        amountCents: inProgressPlan.futureExistingDeltaCents,
      });
    }
  } else if (datesChanged && remainingGuests.length > 0) {
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

  if (!skipBookingLifecycleRules && checkInChanged && !isInProgressEdit) {
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
  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedAddedGuests) {
      const guest = entry.guest;
      const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
      const memberLabel = guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Added: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: entry.priceCents,
      });
    }
  } else if (normalizedAddGuests && normalizedAddGuests.length > 0) {
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
  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedExistingGuests.filter(
      (guest) => guest.removedFromFuture
    )) {
      const tierLabel = entry.guest.ageTier.charAt(0) + entry.guest.ageTier.slice(1).toLowerCase();
      const memberLabel = entry.guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Removed from future nights: ${entry.guest.firstName} ${entry.guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: -entry.oldFuturePriceCents,
      });
    }
  } else {
    for (const guest of removedGuests) {
      const tierLabel = guest.ageTier.charAt(0) + guest.ageTier.slice(1).toLowerCase();
      const memberLabel = guest.isMember ? "Member" : "Non-member";
      itemizedChanges.push({
        label: `Removed: ${guest.firstName} ${guest.lastName} (${tierLabel}, ${memberLabel})`,
        amountCents: -guest.priceCents,
      });
    }
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

  if (inProgressPlan) {
    newDiscountCents = inProgressPlan.newDiscountCents;
  } else if (removePromoCode) {
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

  const newFinalPriceCents = inProgressPlan
    ? inProgressPlan.newFinalPriceCents
    : newTotalPriceCents - newDiscountCents;
  const priceDiffCents = inProgressPlan
    ? inProgressPlan.priceDiffCents
    : newFinalPriceCents - booking.finalPriceCents;
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
