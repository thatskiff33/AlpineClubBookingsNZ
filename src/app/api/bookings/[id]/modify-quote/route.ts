import { NextRequest, NextResponse } from "next/server";
import type { AgeTier } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
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
import { parseJsonRequestBody } from "@/lib/api-json";
import { ApiError } from "@/lib/api-error";
import {
  validateAndCalculatePromoDiscount,
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
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  calculateModificationSettlementOptions,
  resolveGuestNameUpdates,
} from "@/lib/booking-modify";
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
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      })
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
      })
    )
    .optional(),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1),
        firstName: nameField(),
        lastName: nameField(),
      })
    )
    .optional(),
  promoCode: z.string().optional(),
  removePromoCode: z.boolean().optional(),
});

type StayRangeInput = {
  stayStart?: string | null;
  stayEnd?: string | null;
};

type NormalizedAddGuest = {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string | null;
  stayEnd?: string | null;
};

type NormalizedAddGuestWithRange = Omit<NormalizedAddGuest, "stayStart" | "stayEnd"> & {
  stayStart: Date;
  stayEnd: Date;
};

type PromoRedemptionWithTargets = {
  promoCode: {
    assignedMembersOnlyOwnNights?: boolean | null;
    assignments: Array<{ memberId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

function promoRequiresStoredGuestTargets(redemption: PromoRedemptionWithTargets) {
  return (
    redemption.promoCode.assignments.length > 0 &&
    redemption.promoCode.assignedMembersOnlyOwnNights === false
  );
}

function selectedIndexesForStoredGuestTargets(
  redemption: PromoRedemptionWithTargets,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption)) {
    return undefined;
  }

  const targetIds = new Set((redemption.guestTargets ?? []).map((target) => target.bookingGuestId));
  if (targetIds.size === 0) {
    return guestNightRates.map((_, index) => index);
  }

  return guestNightRates
    .map((guest, index) => (guest.bookingGuestId && targetIds.has(guest.bookingGuestId) ? index : -1))
    .filter((index) => index >= 0);
}

function hasStayRangeValue(value: string | null | undefined): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== null && value !== undefined;
}

function hasStayRangeInput(input: StayRangeInput): boolean {
  return hasStayRangeValue(input.stayStart) || hasStayRangeValue(input.stayEnd);
}

function minDate(values: Date[]): Date {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function maxDate(values: Date[]): Date {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

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
          guestTargets: { select: { bookingGuestId: true } },
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

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = modifyQuoteSchema.safeParse(json.body);
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
    guestStayRanges,
    guestUpdates,
    promoCode: newPromoCode,
    removePromoCode,
  } = parsed.data;
  let normalizedAddGuests: NormalizedAddGuest[] | undefined = addGuests;
  let guestNameUpdates: ReturnType<typeof resolveGuestNameUpdates> = [];

  try {
    guestNameUpdates = resolveGuestNameUpdates({
      booking,
      input: { guestUpdates, removeGuestIds },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

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
      ? normalizeBookingGuestInputs(addGuests, linkedMembers).map((guest, index) => ({
          ...guest,
          stayStart: addGuests[index]?.stayStart ?? null,
          stayEnd: addGuests[index]?.stayEnd ?? null,
        }))
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

  const hasRangeInputs =
    (guestStayRanges?.some(hasStayRangeInput) ?? false) ||
    (normalizedAddGuests?.some(hasStayRangeInput) ?? false);
  const existingRangeInputs = new Map(
    (guestStayRanges ?? []).map((range) => [range.guestId, range])
  );
  let finalRequestedCheckIn = requestedCheckIn;
  let finalRequestedCheckOut = requestedCheckOut;

  if (hasRangeInputs) {
    try {
      const removeSet = new Set(removeGuestIds ?? []);
      const envelope = {
        checkIn: requestedCheckIn < booking.checkIn ? requestedCheckIn : booking.checkIn,
        checkOut: requestedCheckOut > booking.checkOut ? requestedCheckOut : booking.checkOut,
      };
      const proposedRanges: Array<{ stayStart: Date; stayEnd: Date }> = [];

      for (const guest of booking.guests) {
        if (removeSet.has(guest.id)) {
          continue;
        }
        const rangeInput = existingRangeInputs.get(guest.id);
        if (rangeInput && hasStayRangeInput(rangeInput)) {
          proposedRanges.push(
            normalizeGuestStayRange(rangeInput, envelope, proposedRanges.length)
          );
        } else {
          proposedRanges.push({
            stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
            stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
          });
        }
      }

      for (const guest of normalizedAddGuests ?? []) {
        if (hasStayRangeInput(guest)) {
          proposedRanges.push(
            normalizeGuestStayRange(guest, envelope, proposedRanges.length)
          );
        } else {
          proposedRanges.push({
            stayStart: normalizeDateOnlyForTimeZone(requestedCheckIn),
            stayEnd: normalizeDateOnlyForTimeZone(requestedCheckOut),
          });
        }
      }

      if (proposedRanges.length > 0) {
        finalRequestedCheckIn = minDate(proposedRanges.map((range) => range.stayStart));
        finalRequestedCheckOut = maxDate(proposedRanges.map((range) => range.stayEnd));
      }
    } catch (error) {
      if (error instanceof BookingGuestStayRangeValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const bookingCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);
  const editableFrom = editPolicy.editableFrom;

  if (isInProgressEdit) {
    if (
      formatDateOnly(normalizeDateOnlyForTimeZone(finalRequestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      return NextResponse.json(
        { error: "Check-in cannot be changed for an in-progress booking" },
        { status: 400 }
      );
    }
    if (editableFrom && normalizeDateOnlyForTimeZone(finalRequestedCheckOut) < editableFrom) {
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
    normalizeDateOnlyForTimeZone(finalRequestedCheckIn) <= editPolicy.today
  ) {
    return NextResponse.json(
      { error: "NZ today and earlier are locked for self-service changes" },
      { status: 400 }
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : finalRequestedCheckIn;
  const newCheckOut = finalRequestedCheckOut;
  const skipBookingLifecycleRules =
    session.user.role === "ADMIN" &&
    !usesActiveBookingEditLifecycle(booking.status);

  if (newCheckOut <= newCheckIn) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
  }
  const targetDatesChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime() ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

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

  let proposedRemainingGuests: Array<{
    guest: (typeof remainingGuests)[number];
    stayStart: Date;
    stayEnd: Date;
  }>;
  let normalizedAddGuestsWithRanges: NormalizedAddGuestWithRange[] | undefined;
  try {
    proposedRemainingGuests = remainingGuests.map((guest, index) => {
      if (!hasRangeInputs) {
        return targetDatesChanged
          ? { guest, stayStart: newCheckIn, stayEnd: newCheckOut }
          : {
              guest,
              stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
              stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
            };
      }

      const rangeInput = existingRangeInputs.get(guest.id);
      const normalizedRange =
        rangeInput && hasStayRangeInput(rangeInput)
          ? normalizeGuestStayRange(rangeInput, { checkIn: newCheckIn, checkOut: newCheckOut }, index)
          : {
              stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
              stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
            };

      return { guest, ...normalizedRange };
    });
    normalizedAddGuestsWithRanges = normalizedAddGuests
      ? normalizeGuestStayRanges(normalizedAddGuests, {
          checkIn: newCheckIn,
          checkOut: newCheckOut,
        })
      : undefined;
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const guestsForPricing = [
    ...proposedRemainingGuests.map((entry) => ({
      bookingGuestId: entry.guest.id,
      ageTier: entry.guest.ageTier as AgeTier,
      isMember: entry.guest.isMember,
      memberId: entry.guest.memberId ?? null,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
    })),
    ...(normalizedAddGuestsWithRanges ?? []).map((g) => ({
      bookingGuestId: null,
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      memberId: g.memberId ?? null,
      stayStart: g.stayStart,
      stayEnd: g.stayEnd,
    })),
  ];

  const totalGuestCount = guestsForPricing.length;

  const lodgeCapacity = await getLodgeCapacity();
  if (totalGuestCount > lodgeCapacity) {
    return NextResponse.json(
      { error: `A booking cannot exceed ${lodgeCapacity} guests` },
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
            promoAdjustmentCents: booking.promoAdjustmentCents,
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
      : await checkCapacityForGuestRanges(
          newCheckIn,
          newCheckOut,
          guestsForPricing,
          bookingId
        );

  // Calculate new total price
  let newTotalPriceCents: number;
  let priceBreakdown: {
    totalPriceCents: number;
    guests: Array<{ priceCents: number; perNightCents: number[] }>;
  } | null = null;
  try {
    if (inProgressPlan) {
      newTotalPriceCents = inProgressPlan.newTotalPriceCents;
    } else {
      priceBreakdown = calculateBookingPrice(
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
  if (guestNameUpdates.length > 0) {
    itemizedChanges.push({
      label:
        guestNameUpdates.length === 1
          ? "Guest name update"
          : "Guest name updates",
      amountCents: 0,
    });
  }

  const oldNights = getStayNights(booking.checkIn, booking.checkOut).length;
  const newNights = getStayNights(newCheckIn, newCheckOut).length;
  const datesChanged = targetDatesChanged;
  const guestRangesChanged = proposedRemainingGuests.some((entry) => {
    const currentStayStart = normalizeDateOnlyForTimeZone(
      entry.guest.stayStart ?? booking.checkIn
    );
    const currentStayEnd = normalizeDateOnlyForTimeZone(
      entry.guest.stayEnd ?? booking.checkOut
    );
    return (
      currentStayStart.getTime() !== entry.stayStart.getTime() ||
      currentStayEnd.getTime() !== entry.stayEnd.getTime()
    );
  });

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
  } else if ((datesChanged || guestRangesChanged) && remainingGuests.length > 0) {
    const oldRemainingForPricing = remainingGuests.map((g) => ({
      ageTier: g.ageTier as AgeTier,
      isMember: g.isMember,
      stayStart: normalizeDateOnlyForTimeZone(g.stayStart ?? booking.checkIn),
      stayEnd: normalizeDateOnlyForTimeZone(g.stayEnd ?? booking.checkOut),
    }));
    const newRemainingForPricing = proposedRemainingGuests.map((entry) => ({
      ageTier: entry.guest.ageTier as AgeTier,
      isMember: entry.guest.isMember,
      stayStart: entry.stayStart,
      stayEnd: entry.stayEnd,
    }));

    try {
      const oldPriceForRemaining = calculateBookingPrice(
        booking.checkIn,
        booking.checkOut,
        oldRemainingForPricing,
        seasonRateData
      );
      const newPriceForRemaining = calculateBookingPrice(
        newCheckIn,
        newCheckOut,
        newRemainingForPricing,
        seasonRateData
      );
      const dateChangeCost =
        newPriceForRemaining.totalPriceCents -
        oldPriceForRemaining.totalPriceCents;

      if (dateChangeCost !== 0) {
        const nightLabel =
          oldNights !== newNights
            ? `Date change: ${oldNights} night${oldNights !== 1 ? "s" : ""} → ${newNights} night${newNights !== 1 ? "s" : ""}`
            : guestRangesChanged
              ? "Guest stay range change"
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
  } else if (normalizedAddGuestsWithRanges && normalizedAddGuestsWithRanges.length > 0) {
    for (const guest of normalizedAddGuestsWithRanges) {
      try {
        const guestPrice = calculateBookingPrice(
          newCheckIn,
          newCheckOut,
          [
            {
              ageTier: guest.ageTier,
              isMember: guest.isMember,
              stayStart: guest.stayStart,
              stayEnd: guest.stayEnd,
            },
          ],
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
  let newPromoAdjustmentCents = 0;
  let promoStillValid = true;
  let promoValidation: {
    valid: boolean;
    error?: string;
    code?: string;
    discountCents?: number;
    promoAdjustmentCents?: number;
  } | null = null;

  // Helper: get per-night rates per guest for promo calculation
  function getGuestNightRates() {
    return guestsForPricing.map((guest, index) => ({
      bookingGuestId: guest.bookingGuestId,
      memberId: guest.memberId ?? null,
      isMember: guest.isMember,
      perNightRates: priceBreakdown?.guests[index]?.perNightCents ?? [],
      // Dates the positional rates so internal work-party promos restrict
      // the discount to the event's night window.
      firstNight: guest.stayStart ?? newCheckIn,
    }));
  }

  if (inProgressPlan) {
    newDiscountCents = inProgressPlan.newDiscountCents;
    newPromoAdjustmentCents = inProgressPlan.newPromoAdjustmentCents;
  } else if (removePromoCode) {
    // User wants to remove existing promo (for reuse later)
    newDiscountCents = 0;
    newPromoAdjustmentCents = 0;
    promoValidation = null;
  } else if (newPromoCode) {
    // User wants to apply a new promo code
    const validation = await validatePromoCodeFull(newPromoCode, {
      totalPriceCents: newTotalPriceCents,
      memberId: booking.memberId,
      guests: getGuestNightRates(),
    }, bookingId);

    if (validation.valid) {
      newDiscountCents = validation.discountCents ?? 0;
      newPromoAdjustmentCents = validation.promoAdjustmentCents ?? 0;
      promoValidation = {
        valid: true,
        code: validation.promoCode?.code,
        discountCents: validation.discountCents ?? 0,
        promoAdjustmentCents: validation.promoAdjustmentCents ?? 0,
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
    const guestNightRates = getGuestNightRates();
    const selectedGuestIndexes = selectedIndexesForStoredGuestTargets(
      booking.promoRedemption,
      guestNightRates
    );
    const application = await validateAndCalculatePromoDiscount(
      promo,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      promo.assignments.length > 0
        ? promo.assignments.map((assignment) => assignment.memberId)
        : null,
      { excludeBookingId: bookingId, db: prisma, selectedGuestIndexes },
    );

    if (application.error || !application.discount) {
      promoStillValid = false;
    } else {
      const promoResult = application.discount;
      newDiscountCents = promoResult.discountCents;
      newPromoAdjustmentCents = promoResult.priceAdjustmentCents;
    }
  }

  // Add promo line item
  if (newPromoAdjustmentCents !== 0) {
    const promoLabel = newPromoCode
      ? `Promo '${newPromoCode.toUpperCase()}'`
      : booking.promoRedemption?.promoCode
        ? `Promo '${booking.promoRedemption.promoCode.code}'`
        : "Promo discount";
    itemizedChanges.push({
      label: promoLabel,
      amountCents: newPromoAdjustmentCents,
    });
  }

  // Show removed promo as the inverse of its previous signed adjustment.
  if (removePromoCode && booking.promoAdjustmentCents !== 0) {
    itemizedChanges.push({
      label: `Removed promo '${booking.promoRedemption?.promoCode?.code || "adjustment"}'`,
      amountCents: -booking.promoAdjustmentCents,
    });
  }

  const newFinalPriceCents = inProgressPlan
    ? inProgressPlan.newFinalPriceCents
    : newTotalPriceCents + newPromoAdjustmentCents;
  const priceDiffCents = inProgressPlan
    ? inProgressPlan.priceDiffCents
    : newFinalPriceCents - booking.finalPriceCents;
  const netChargeCents = priceDiffCents + changeFeeCents;
  const settlementOptions = await calculateModificationSettlementOptions({
    booking,
    netChargeCents,
  });

  return NextResponse.json({
    newTotalPriceCents,
    newDiscountCents,
    newPromoAdjustmentCents,
    newFinalPriceCents,
    priceDiffCents,
    changeFeeCents,
    netChargeCents,
    settlementOptions,
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
