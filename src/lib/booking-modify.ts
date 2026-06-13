import {
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  type AgeTier,
  type Booking,
  type BookingGuest,
  type Member,
  type Payment,
  type Prisma,
  type PromoCode,
  type PromoRedemption,
  type Role,
  AdminReviewStatus,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import {
  buildInProgressGuestRangePlan,
  type BookingEditGuestRangePlan,
} from "@/lib/booking-edit-guest-ranges";
import {
  getBookingEditPolicy,
  canModifyBookingStatusForRole,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";
import {
  cleanupChoreAssignmentsForDateChange,
  cleanupChoreAssignmentsForGuestStayRanges,
} from "@/lib/chore-cleanup";
import {
  calculateDualRefundAmounts,
  daysUntilDate,
  loadCancellationPolicy,
  getNonMemberHoldDays,
} from "@/lib/cancellation";
import { calculateChangeFee } from "@/lib/change-fee";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  calculateBookingPrice,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  deletePromoRedemptionAndAdjustCount,
  redeemPromoCode,
  replacePromoRedemptionAllocations,
  shouldPersistPromoRedemption,
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { findUnpaidMemberGuestNames } from "@/lib/booking-member-guest-subscriptions";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembers,
  type BookingGuestInput,
} from "@/lib/booking-guests";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";
import {
  formatDateOnly,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import { getLodgeCapacity } from "@/lib/lodge-capacity";

export type BatchModifyInput = {
  checkIn?: string;
  checkOut?: string;
  addGuests?: Array<{
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember: boolean;
    memberId?: string;
    stayStart?: string | null;
    stayEnd?: string | null;
  }>;
  removeGuestIds?: string[];
  guestStayRanges?: Array<{
    guestId: string;
    stayStart?: string | null;
    stayEnd?: string | null;
  }>;
  guestUpdates?: Array<{
    guestId: string;
    firstName: string;
    lastName: string;
  }>;
  promoCode?: string;
  promoGuestIndexes?: number[];
  removePromoCode?: boolean;
  memberReviewJustification?: string;
  settlementMethod?: BookingModificationSettlementMethod;
};

export type BookingModificationSettlementMethod = "card" | "credit";

export type BookingModificationSettlementOptions = {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
};

type ProposedGuestPricingInput = {
  bookingGuestId?: string | null;
  ageTier: AgeTier;
  isMember: boolean;
  memberId: string | null;
  stayStart: Date;
  stayEnd: Date;
};

type ProposedRemainingGuest = {
  guest: BookingGuest;
  stayStart: Date;
  stayEnd: Date;
};

type StayRangeInput = {
  stayStart?: string | null;
  stayEnd?: string | null;
};

function hasStayRangeValue(value: string | null | undefined): boolean {
  return typeof value === "string" ? value.trim() !== "" : value !== null && value !== undefined;
}

function hasStayRangeInput(input: StayRangeInput): boolean {
  return hasStayRangeValue(input.stayStart) || hasStayRangeValue(input.stayEnd);
}

function hasGuestStayRangeInputs(input: BatchModifyInput): boolean {
  return (
    (input.guestStayRanges?.some(hasStayRangeInput) ?? false) ||
    (input.addGuests?.some(hasStayRangeInput) ?? false)
  );
}

function normalizeRangeOrApiError(
  input: { stayStart?: string | Date | null; stayEnd?: string | Date | null },
  booking: { checkIn: Date; checkOut: Date },
  index: number
) {
  try {
    return normalizeGuestStayRange(input, booking, index);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      throw new ApiError(error.message, 400);
    }
    throw error;
  }
}

function normalizeRangesOrApiError<Guest extends { stayStart?: string | Date | null; stayEnd?: string | Date | null }>(
  guests: Guest[],
  booking: { checkIn: Date; checkOut: Date }
) {
  try {
    return normalizeGuestStayRanges(guests, booking);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      throw new ApiError(error.message, 400);
    }
    throw error;
  }
}

function getGuestStayRangeInputMap(input: BatchModifyInput) {
  return new Map(
    (input.guestStayRanges ?? []).map((range) => [range.guestId, range])
  );
}

function minDate(values: Date[]): Date {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function maxDate(values: Date[]): Date {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

export type LoadedPromoRedemption = PromoRedemption & {
  promoCode: PromoCode & {
    assignments: Array<{ memberId: string }>;
  };
  guestTargets?: Array<{ bookingGuestId: string }>;
};

export type LoadedBookingForModify = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
  member: Member;
  promoRedemption: LoadedPromoRedemption | null;
};

export type ResolvedGuestNameUpdate = {
  guestId: string;
  firstName: string;
  lastName: string;
  previousFirstName: string;
  previousLastName: string;
};

type BookingGuestNameEditPayment = Pick<
  Payment,
  "status" | "amountCents" | "additionalAmountCents" | "additionalPaymentStatus"
> | null;

const FULLY_PAID_BOOKING_STATUSES = new Set<BookingStatus | string>([
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
]);

function normalizeGuestName(value: string, fieldName: string) {
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  if (!normalized) {
    throw new ApiError(`${fieldName} is required`, 400);
  }
  if (normalized.length > 100) {
    throw new ApiError(`${fieldName} must be 100 characters or fewer`, 400);
  }
  return normalized;
}

export function hasOutstandingAdditionalPayment(
  payment: BookingGuestNameEditPayment,
) {
  return Boolean(
    payment &&
      payment.additionalAmountCents > 0 &&
      payment.additionalPaymentStatus !== "SUCCEEDED",
  );
}

export function isBookingFullyPaidForGuestNameEdits(booking: {
  status: BookingStatus | string;
  finalPriceCents: number;
  payment: BookingGuestNameEditPayment;
}) {
  if (hasOutstandingAdditionalPayment(booking.payment)) {
    return false;
  }

  if (hasCapturedPayment(booking.payment)) {
    return true;
  }

  return (
    booking.finalPriceCents <= 0 &&
    FULLY_PAID_BOOKING_STATUSES.has(booking.status)
  );
}

export function resolveGuestNameUpdates({
  booking,
  input,
}: {
  booking: Pick<
    LoadedBookingForModify,
    "guests" | "status" | "finalPriceCents" | "payment"
  >;
  input: Pick<BatchModifyInput, "guestUpdates" | "removeGuestIds">;
}): ResolvedGuestNameUpdate[] {
  if (!input.guestUpdates?.length) {
    return [];
  }

  if (isBookingFullyPaidForGuestNameEdits(booking)) {
    throw new ApiError(
      "Non-member guest names cannot be edited after the booking is fully paid",
      400,
    );
  }

  const removedGuestIds = new Set(input.removeGuestIds ?? []);
  const guestsById = new Map(booking.guests.map((guest) => [guest.id, guest]));
  const seenGuestIds = new Set<string>();
  const updates: ResolvedGuestNameUpdate[] = [];

  for (const update of input.guestUpdates) {
    if (seenGuestIds.has(update.guestId)) {
      throw new ApiError("Each guest can only be updated once", 400);
    }
    seenGuestIds.add(update.guestId);

    if (removedGuestIds.has(update.guestId)) {
      throw new ApiError(
        "A guest cannot be renamed and removed in the same change",
        400,
      );
    }

    const guest = guestsById.get(update.guestId);
    if (!guest) {
      throw new ApiError(
        "One or more guest updates referenced a guest not found on this booking",
        400,
      );
    }

    if (guest.isMember || guest.memberId) {
      throw new ApiError("Member guest names cannot be edited on a booking", 400);
    }

    const firstName = normalizeGuestName(update.firstName, "First name");
    const lastName = normalizeGuestName(update.lastName, "Last name");
    if (firstName === guest.firstName && lastName === guest.lastName) {
      continue;
    }

    updates.push({
      guestId: guest.id,
      firstName,
      lastName,
      previousFirstName: guest.firstName,
      previousLastName: guest.lastName,
    });
  }

  return updates;
}

export type ResolvedTargetDates = {
  newCheckIn: Date;
  newCheckOut: Date;
  isInProgressEdit: boolean;
  editableFrom: Date | null;
  skipBookingLifecycleRules: boolean;
  checkInChanged: boolean;
  datesChanged: boolean;
};

export function resolveTargetDates({
  booking,
  role,
  input,
}: {
  booking: LoadedBookingForModify;
  role: Role;
  input: BatchModifyInput;
}): ResolvedTargetDates {
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  if (!editPolicy.canModify) {
    throw new ApiError(
      editPolicy.reason ?? "This booking cannot be modified",
      400,
    );
  }

  const requestedCheckIn = input.checkIn
    ? parseDateOnly(input.checkIn)
    : booking.checkIn;
  const requestedCheckOut = input.checkOut
    ? parseDateOnly(input.checkOut)
    : booking.checkOut;
  if (
    Number.isNaN(requestedCheckIn.getTime()) ||
    Number.isNaN(requestedCheckOut.getTime())
  ) {
    throw new ApiError("Invalid booking dates", 400);
  }

  let finalRequestedCheckIn = requestedCheckIn;
  let finalRequestedCheckOut = requestedCheckOut;
  if (hasGuestStayRangeInputs(input)) {
    const removeSet = new Set(input.removeGuestIds ?? []);
    const existingRangeInputs = getGuestStayRangeInputMap(input);
    const proposedRanges: Array<{ stayStart: Date; stayEnd: Date }> = [];
    const envelope = {
      checkIn: requestedCheckIn < booking.checkIn ? requestedCheckIn : booking.checkIn,
      checkOut: requestedCheckOut > booking.checkOut ? requestedCheckOut : booking.checkOut,
    };

    for (const guest of booking.guests) {
      if (removeSet.has(guest.id)) {
        continue;
      }
      const rangeInput = existingRangeInputs.get(guest.id);
      if (rangeInput && hasStayRangeInput(rangeInput)) {
        proposedRanges.push(
          normalizeRangeOrApiError(rangeInput, envelope, proposedRanges.length)
        );
      } else {
        proposedRanges.push({
          stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
          stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
        });
      }
    }

    for (const addGuest of input.addGuests ?? []) {
      if (hasStayRangeInput(addGuest)) {
        proposedRanges.push(
          normalizeRangeOrApiError(addGuest, envelope, proposedRanges.length)
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
  }

  const isInProgressEdit = editPolicy.mode === "in-progress";
  const editableFrom = editPolicy.editableFrom;
  const bookingCheckIn = normalizeDateOnlyForTimeZone(booking.checkIn);

  if (isInProgressEdit) {
    if (
      formatDateOnly(normalizeDateOnlyForTimeZone(finalRequestedCheckIn)) !==
        formatDateOnly(bookingCheckIn)
    ) {
      throw new ApiError(
        "Check-in cannot be changed for an in-progress booking",
        400,
      );
    }
    if (editableFrom && normalizeDateOnlyForTimeZone(finalRequestedCheckOut) < editableFrom) {
      throw new ApiError(
        "NZ today and earlier are locked for self-service changes",
        400,
      );
    }
    if (input.promoCode || input.removePromoCode) {
      throw new ApiError(
        "Promo code changes are not available for in-progress bookings",
        400,
      );
    }
  } else if (
    role !== "ADMIN" &&
    normalizeDateOnlyForTimeZone(finalRequestedCheckIn) <= editPolicy.today
  ) {
    throw new ApiError(
      "NZ today and earlier are locked for self-service changes",
      400,
    );
  }

  const newCheckIn = isInProgressEdit ? booking.checkIn : finalRequestedCheckIn;
  const newCheckOut = finalRequestedCheckOut;

  if (newCheckOut <= newCheckIn) {
    throw new ApiError("Check-out must be after check-in", 400);
  }

  const skipBookingLifecycleRules =
    role === "ADMIN" && !usesActiveBookingEditLifecycle(booking.status);

  const checkInChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime();
  const datesChanged =
    checkInChanged ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();

  return {
    newCheckIn,
    newCheckOut,
    isInProgressEdit,
    editableFrom,
    skipBookingLifecycleRules,
    checkInChanged,
    datesChanged,
  };
}

export type GuestPlan = {
  remainingGuests: BookingGuest[];
  proposedRemainingGuests: ProposedRemainingGuest[];
  removedGuests: BookingGuest[];
  normalizedAddGuests: BookingGuestInput[] | undefined;
  guestsForPricing: ProposedGuestPricingInput[];
  totalGuestCount: number;
  requiresAdminReview: boolean;
  adminReviewReason: string | null;
  /**
   * Review-related fields to write to the booking after the modification.
   * Encapsulates four scenarios: rule clears (fields nulled), rule trips
   * for the first time on a member modification (justification captured,
   * adminReviewStatus = PENDING), rule trips on an admin modification
   * (auto-approved), rule already tripped (existing review state kept).
   */
  reviewUpdate: {
    requiresAdminReview: boolean;
    adminReviewReason: string | null;
    memberReviewJustification: string | null;
    adminReviewStatus: AdminReviewStatus | null;
    adminReviewNotes: string | null;
    adminReviewedById: string | null;
    adminReviewedAt: Date | null;
    /** When true, status must move to AWAITING_REVIEW unless already there. */
    parkForReview: boolean;
    /** When true, AWAITING_REVIEW should be released to PAYMENT_PENDING. */
    releaseFromReview: boolean;
  };
};

export async function prepareGuestPlan(
  tx: Prisma.TransactionClient,
  {
    booking,
    role,
    actorId,
    input,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
  }: {
    booking: LoadedBookingForModify;
    role: Role;
    actorId: string;
    input: BatchModifyInput;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
  },
): Promise<GuestPlan> {
  const linkedMembers = await resolveLinkedBookingMembers(
    tx,
    booking.memberId,
    (input.addGuests ?? []).map((guest) => guest.memberId),
    { skipAuthorization: role === "ADMIN" },
  );
  await assertLinkedBookingMembersCanBeBooked(tx, linkedMembers, actorId, {
    actorRole: role,
    onBehalfOfMemberId: role === "ADMIN" ? booking.memberId : null,
  });
  const normalizedAddGuests = input.addGuests
    ? normalizeBookingGuestInputs(input.addGuests, linkedMembers).map((guest, index) => ({
        ...guest,
        stayStart: input.addGuests?.[index]?.stayStart ?? null,
        stayEnd: input.addGuests?.[index]?.stayEnd ?? null,
      }))
    : undefined;

  const removeSet = new Set(input.removeGuestIds ?? []);
  const remainingGuests = booking.guests.filter((g) => !removeSet.has(g.id));
  const removedGuests = booking.guests.filter((g) => removeSet.has(g.id));

  if (
    !isInProgressEdit &&
    remainingGuests.length === 0 &&
    (!normalizedAddGuests || normalizedAddGuests.length === 0)
  ) {
    throw new ApiError("Booking must have at least one guest", 400);
  }

  const hasRangeInputs = hasGuestStayRangeInputs(input);
  const datesChanged =
    newCheckIn.getTime() !== new Date(booking.checkIn).getTime() ||
    newCheckOut.getTime() !== new Date(booking.checkOut).getTime();
  const existingRangeInputs = getGuestStayRangeInputMap(input);
  const proposedRemainingGuests: ProposedRemainingGuest[] = remainingGuests.map((guest, index) => {
    if (!hasRangeInputs) {
      return datesChanged
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
        ? normalizeRangeOrApiError(rangeInput, { checkIn: newCheckIn, checkOut: newCheckOut }, index)
        : {
            stayStart: normalizeDateOnlyForTimeZone(guest.stayStart ?? booking.checkIn),
            stayEnd: normalizeDateOnlyForTimeZone(guest.stayEnd ?? booking.checkOut),
          };

    return { guest, ...normalizedRange };
  });

  const normalizedAddGuestsWithRanges = normalizedAddGuests
    ? normalizeRangesOrApiError(normalizedAddGuests, {
        checkIn: newCheckIn,
        checkOut: newCheckOut,
      })
    : undefined;

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
  const lodgeCapacity = await getLodgeCapacity(tx);
  if (totalGuestCount > lodgeCapacity) {
    throw new ApiError(
      `A booking cannot exceed ${lodgeCapacity} guests`,
      400,
    );
  }

  const requiresAdminReview = requiresAdultSupervisionReview(guestsForPricing);
  const adminReviewReason = requiresAdminReview
    ? ADULT_SUPERVISION_REVIEW_REASON
    : null;

  const reviewUpdate = resolveModifyReviewUpdate({
    booking,
    role,
    actorId,
    nowFlagged: requiresAdminReview,
    memberReviewJustification: input.memberReviewJustification,
  });

  if (role !== "ADMIN") {
    const unpaidMemberGuests = await findUnpaidMemberGuestNames(tx, {
      bookingMemberId: booking.memberId,
      checkIn: isInProgressEdit && editableFrom ? editableFrom : newCheckIn,
      guests: normalizedAddGuests ?? [],
    });
    if (unpaidMemberGuests.length > 0) {
      throw new ApiError(
        `The following member guests have unpaid subscriptions: ${unpaidMemberGuests.join(", ")}. All member guests must have a paid subscription before booking.`,
        403,
      );
    }
  }

  return {
    remainingGuests,
    proposedRemainingGuests,
    removedGuests,
    normalizedAddGuests: normalizedAddGuestsWithRanges,
    guestsForPricing,
    totalGuestCount,
    requiresAdminReview,
    adminReviewReason,
    reviewUpdate,
  };
}

/**
 * Thrown by prepareGuestPlan when a member modification causes the no-adult
 * rule to trip for a booking that was not previously flagged, and the
 * caller did not supply `memberReviewJustification`.
 */
export class BookingModifyReviewJustificationRequiredError extends ApiError {
  constructor() {
    super(
      "Removing the last adult requires a written reason so an admin can review. Please add a justification and try again.",
      400,
    );
    this.name = "BookingModifyReviewJustificationRequiredError";
  }
}

function resolveModifyReviewUpdate({
  booking,
  role,
  actorId,
  nowFlagged,
  memberReviewJustification,
}: {
  booking: LoadedBookingForModify;
  role: Role;
  actorId: string;
  nowFlagged: boolean;
  memberReviewJustification: string | undefined;
}): GuestPlan["reviewUpdate"] {
  const wasFlagged = booking.requiresAdminReview;
  const existingStatus = booking.adminReviewStatus;
  const justification = memberReviewJustification?.trim();

  if (!nowFlagged) {
    // Rule cleared. Wipe review state so the booking returns to the
    // normal lifecycle; if it was parked in AWAITING_REVIEW, release it.
    return {
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      adminReviewStatus: null,
      adminReviewNotes: null,
      adminReviewedById: null,
      adminReviewedAt: null,
      parkForReview: false,
      releaseFromReview: booking.status === "AWAITING_REVIEW",
    };
  }

  // Still flagged after modification. If review already happened (or is
  // pending), preserve it — admins should not be re-prompted for the same
  // booking just because the guest list shuffled.
  if (wasFlagged && existingStatus !== null) {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification:
        justification ?? booking.memberReviewJustification ?? null,
      adminReviewStatus: existingStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewedById: booking.adminReviewedById,
      adminReviewedAt: booking.adminReviewedAt,
      parkForReview: existingStatus === AdminReviewStatus.PENDING,
      releaseFromReview: false,
    };
  }

  // First time the rule has tripped on this booking.
  if (role === "ADMIN") {
    return {
      requiresAdminReview: true,
      adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      memberReviewJustification: justification ?? null,
      adminReviewStatus: AdminReviewStatus.APPROVED,
      adminReviewNotes: "Approved at modification by admin.",
      adminReviewedById: actorId,
      adminReviewedAt: new Date(),
      parkForReview: false,
      releaseFromReview: false,
    };
  }

  if (!justification) {
    throw new BookingModifyReviewJustificationRequiredError();
  }

  return {
    requiresAdminReview: true,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    memberReviewJustification: justification,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    parkForReview: true,
    releaseFromReview: false,
  };
}

export async function loadActiveSeasonRates(
  tx: Prisma.TransactionClient,
): Promise<SeasonRateData[]> {
  const seasons = await tx.season.findMany({
    where: { active: true },
    include: { rates: true },
  });
  return seasons.map((s) => ({
    seasonId: s.id,
    startDate: s.startDate,
    endDate: s.endDate,
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));
}

export type PricingResult = {
  inProgressPlan: BookingEditGuestRangePlan | null;
  newTotalPriceCents: number;
  priceBreakdown: {
    totalPriceCents: number;
    guests: Array<{ priceCents: number; perNightCents: number[] }>;
  };
  guestNightRates: Array<{
    bookingGuestId?: string | null;
    memberId: string | null;
    isMember: boolean;
    perNightRates: number[];
  }>;
};

export async function calculateModifiedPricing(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    isInProgressEdit,
    editableFrom,
    newCheckIn,
    newCheckOut,
    normalizedAddGuests,
    removeGuestIds,
    guestsForPricing,
    skipBookingLifecycleRules,
    seasonRateData,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    isInProgressEdit: boolean;
    editableFrom: Date | null;
    newCheckIn: Date;
    newCheckOut: Date;
    normalizedAddGuests: BookingGuestInput[] | undefined;
    removeGuestIds: string[] | undefined;
    guestsForPricing: Array<{
      bookingGuestId?: string | null;
      ageTier: AgeTier;
      isMember: boolean;
      memberId: string | null;
      stayStart?: Date | null;
      stayEnd?: Date | null;
    }>;
    skipBookingLifecycleRules: boolean;
    seasonRateData: SeasonRateData[];
  },
): Promise<PricingResult> {
  let inProgressPlan: BookingEditGuestRangePlan | null = null;
  if (isInProgressEdit && editableFrom) {
    inProgressPlan = buildInProgressGuestRangePlan({
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
    });
  }

  const capacity = skipBookingLifecycleRules
    ? { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] }
    : inProgressPlan && editableFrom
      ? await checkCapacityForGuestRanges(
          editableFrom,
          newCheckOut,
          inProgressPlan.capacityGuestRanges,
          bookingId,
          tx,
        )
      : await checkCapacityForGuestRanges(
          newCheckIn,
          newCheckOut,
          guestsForPricing,
          bookingId,
          tx,
        );
  if (!capacity.available) {
    throw new ApiError("Not enough beds available for these changes", 400);
  }

  let priceBreakdown: PricingResult["priceBreakdown"];
  try {
    priceBreakdown = inProgressPlan
      ? {
          totalPriceCents: inProgressPlan.newTotalPriceCents,
          guests: [
            ...inProgressPlan.proposedExistingGuests.map((entry) => ({
              priceCents: entry.priceCents,
              perNightCents: [] as number[],
            })),
            ...inProgressPlan.proposedAddedGuests.map((entry) => ({
              priceCents: entry.priceCents,
              perNightCents: [] as number[],
            })),
          ],
        }
      : calculateBookingPrice(newCheckIn, newCheckOut, guestsForPricing, seasonRateData);
  } catch {
    throw new ApiError("No season rate found for the requested dates", 400);
  }

  const newTotalPriceCents = priceBreakdown.totalPriceCents;
  const guestNightRates = inProgressPlan
    ? []
    : guestsForPricing.map((guest, index) => ({
        memberId: guest.memberId ?? null,
        bookingGuestId: guest.bookingGuestId ?? null,
        isMember: guest.isMember,
        perNightRates: priceBreakdown.guests[index]?.perNightCents ?? [],
        // Dates the positional rates so internal work-party promos restrict
        // the discount to the event's night window.
        firstNight: guest.stayStart ?? newCheckIn,
      }));

  return {
    inProgressPlan,
    newTotalPriceCents,
    priceBreakdown,
    guestNightRates,
  };
}

export type PromoChangeResult = {
  newDiscountCents: number;
  newPromoAdjustmentCents: number;
  promoRemoved: boolean;
  promoChanged: boolean;
};

function promoRequiresStoredGuestTargets(
  promo: PromoCode & { assignments: Array<{ memberId: string }> }
) {
  return promo.assignments.length > 0 && promo.assignedMembersOnlyOwnNights === false;
}

function selectedIndexesForStoredGuestTargets(
  redemption: LoadedPromoRedemption,
  guestNightRates: Array<{ bookingGuestId?: string | null }>
) {
  if (!promoRequiresStoredGuestTargets(redemption.promoCode)) {
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

function targetBookingGuestIdsForSelectedIndexes(
  guestNightRates: Array<{ bookingGuestId?: string | null }>,
  selectedGuestIndexes: number[] | undefined
) {
  if (!selectedGuestIndexes) return undefined;
  return selectedGuestIndexes
    .map((index) => guestNightRates[index]?.bookingGuestId)
    .filter((id): id is string => Boolean(id));
}

export async function applyPromoCodeChanges(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    input,
    inProgressPlan,
    newCheckIn,
    newTotalPriceCents,
    guestNightRates,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    input: BatchModifyInput;
    inProgressPlan: BookingEditGuestRangePlan | null;
    newCheckIn: Date;
    newTotalPriceCents: number;
    guestNightRates: Array<{
      bookingGuestId?: string | null;
      memberId: string | null;
      isMember: boolean;
      perNightRates: number[];
    }>;
  },
): Promise<PromoChangeResult> {
  if (inProgressPlan) {
    return {
      newDiscountCents: inProgressPlan.newDiscountCents,
      newPromoAdjustmentCents: inProgressPlan.newPromoAdjustmentCents,
      promoRemoved: false,
      promoChanged: false,
    };
  }

  let newDiscountCents = 0;
  let newPromoAdjustmentCents = 0;
  let promoRemoved = false;
  let promoChanged = false;

  if (input.removePromoCode && booking.promoRedemption) {
    await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
    promoRemoved = true;
  }

  if (input.promoCode && !input.removePromoCode) {
    if (booking.promoRedemption && !promoRemoved) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    }

    const promoCode = await tx.promoCode.findUnique({
      where: { code: input.promoCode.toUpperCase().trim() },
      include: { assignments: { select: { memberId: true } } },
    });

    // Internal promos (work party events) cannot be entered as codes.
    if (!promoCode || promoCode.internal) {
      throw new ApiError("Promo code not found", 400);
    }

    const assignedMemberIds = promoCode.assignments.length
      ? promoCode.assignments.map((assignment) => assignment.memberId)
      : null;
    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: booking.memberId,
        bookingCheckIn: newCheckIn,
        totalPriceCents: newTotalPriceCents,
        guests: guestNightRates,
      },
      assignedMemberIds,
      {
        excludeBookingId: bookingId,
        db: tx,
        selectedGuestIndexes: input.promoGuestIndexes,
      },
    );
    if (application.error || !application.discount) {
      throw new ApiError(application.error ?? "Promo code could not be applied", 400);
    }

    const promoResult = application.discount;
    newDiscountCents = promoResult.discountCents;
    newPromoAdjustmentCents = promoResult.priceAdjustmentCents;

    if (shouldPersistPromoRedemption(promoResult)) {
      await redeemPromoCode(
        tx,
        promoCode.id,
        bookingId,
        booking.memberId,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
    promoChanged = true;
  } else if (
    !input.removePromoCode &&
    !promoRemoved &&
    booking.promoRedemption?.promoCode
  ) {
    const promo = booking.promoRedemption.promoCode;
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
      { excludeBookingId: bookingId, db: tx, selectedGuestIndexes },
    );

    if (application.error || !application.discount) {
      await deletePromoRedemptionAndAdjustCount(tx, booking.promoRedemption);
      promoRemoved = true;
    } else {
      const promoResult = application.discount;
      newDiscountCents = promoResult.discountCents;
      newPromoAdjustmentCents = promoResult.priceAdjustmentCents;

      await replacePromoRedemptionAllocations(
        tx,
        booking.promoRedemption,
        newDiscountCents,
        newPromoAdjustmentCents,
        promoResult.freeNightsUsed,
        promoResult.eligibleGuestCount,
        promoResult.allocations,
        targetBookingGuestIdsForSelectedIndexes(
          guestNightRates,
          application.selectedGuestIndexes
        ),
      );
    }
  }

  return { newDiscountCents, newPromoAdjustmentCents, promoRemoved, promoChanged };
}

export async function calculateModificationChangeFee({
  booking,
  newCheckIn,
  checkInChanged,
  skipBookingLifecycleRules,
}: {
  booking: LoadedBookingForModify;
  newCheckIn: Date;
  checkInChanged: boolean;
  skipBookingLifecycleRules: boolean;
}): Promise<number> {
  if (skipBookingLifecycleRules || !checkInChanged) {
    return 0;
  }
  const now = new Date();
  const policy = await loadCancellationPolicy(booking.checkIn);
  const feeResult = calculateChangeFee({
    daysUntilOriginalCheckIn: daysUntilDate(booking.checkIn, now),
    daysUntilNewCheckIn: daysUntilDate(newCheckIn, now),
    originalFinalPriceCents: booking.finalPriceCents,
    policyRules: policy,
  });
  return feeResult.feeCents;
}

export async function applyGuestChanges(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    removedGuests,
    remainingGuests,
    proposedRemainingGuests,
    normalizedAddGuests,
    guestNameUpdates,
    priceBreakdown,
    inProgressPlan,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    removedGuests: BookingGuest[];
    remainingGuests: BookingGuest[];
    proposedRemainingGuests: ProposedRemainingGuest[];
    normalizedAddGuests: BookingGuestInput[] | undefined;
    guestNameUpdates?: ResolvedGuestNameUpdate[];
    priceBreakdown: PricingResult["priceBreakdown"];
    inProgressPlan: BookingEditGuestRangePlan | null;
  },
): Promise<{ createdGuests: BookingGuest[] }> {
  const createdGuests: BookingGuest[] = [];
  const nameUpdatesByGuestId = new Map(
    (guestNameUpdates ?? []).map((update) => [update.guestId, update]),
  );

  if (inProgressPlan) {
    for (const entry of inProgressPlan.proposedExistingGuests) {
      const nameUpdate = nameUpdatesByGuestId.get(entry.guest.id);
      await tx.bookingGuest.update({
        where: { id: entry.guest.id },
        data: {
          ...(nameUpdate
            ? {
                firstName: nameUpdate.firstName,
                lastName: nameUpdate.lastName,
              }
            : {}),
          stayStart: entry.stayStart,
          stayEnd: entry.stayEnd,
          priceCents: entry.priceCents,
        },
      });
    }

    for (const entry of inProgressPlan.proposedAddedGuests) {
      const g = entry.guest;
      const guest = await tx.bookingGuest.create({
        data: {
          bookingId,
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          memberId: g.memberId || null,
          stayStart: entry.stayStart,
          stayEnd: entry.stayEnd,
          priceCents: entry.priceCents,
        },
      });
      createdGuests.push(guest);
    }

    return { createdGuests };
  }

  for (const guest of removedGuests) {
    await tx.choreAssignment.deleteMany({
      where: { bookingGuestId: guest.id },
    });
    await tx.bookingGuest.delete({ where: { id: guest.id } });
  }

  const addedGuestStartIndex = remainingGuests.length;
  const addList = normalizedAddGuests ?? [];
  for (let i = 0; i < addList.length; i++) {
    const g = addList[i];
    const guestPriceIndex = addedGuestStartIndex + i;
    const guest = await tx.bookingGuest.create({
      data: {
        bookingId,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: g.ageTier,
        isMember: g.isMember,
        memberId: g.memberId || null,
        stayStart: g.stayStart ?? newCheckIn,
        stayEnd: g.stayEnd ?? newCheckOut,
        priceCents: priceBreakdown.guests[guestPriceIndex].priceCents,
      },
    });
    createdGuests.push(guest);
  }

  for (let i = 0; i < remainingGuests.length; i++) {
    const proposedRange = proposedRemainingGuests[i];
    const nameUpdate = nameUpdatesByGuestId.get(remainingGuests[i].id);
    await tx.bookingGuest.update({
      where: { id: remainingGuests[i].id },
      data: {
        ...(nameUpdate
          ? {
              firstName: nameUpdate.firstName,
              lastName: nameUpdate.lastName,
            }
          : {}),
        stayStart: proposedRange?.stayStart ?? newCheckIn,
        stayEnd: proposedRange?.stayEnd ?? newCheckOut,
        priceCents: priceBreakdown.guests[i].priceCents,
      },
    });
  }

  return { createdGuests };
}

export async function applyChoreCleanup(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    newCheckIn,
    newCheckOut,
    datesChanged,
  }: {
    bookingId: string;
    newCheckIn: Date;
    newCheckOut: Date;
    datesChanged: boolean;
  },
): Promise<string[]> {
  let choreWarnings: string[] = [];
  if (datesChanged) {
    const result = await cleanupChoreAssignmentsForDateChange(
      tx,
      bookingId,
      newCheckIn,
      newCheckOut,
    );
    choreWarnings = result.choreWarnings;
  }
  const rangeCleanup = await cleanupChoreAssignmentsForGuestStayRanges(
    tx,
    bookingId,
  );
  return [...choreWarnings, ...rangeCleanup.choreWarnings];
}

export type PaymentAdjustmentResult = {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  additionalAmountCents: number;
  pendingRefundAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
};

const SETTLED_BOOKING_STATUSES = [
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "COMPLETED",
] as const;

function isSettledBookingStatus(status: BookingStatus | string) {
  return (SETTLED_BOOKING_STATUSES as readonly string[]).includes(status);
}

export async function calculateModificationSettlementOptions({
  booking,
  netChargeCents,
}: {
  booking: Pick<LoadedBookingForModify, "checkIn" | "status" | "payment">;
  netChargeCents: number;
}): Promise<BookingModificationSettlementOptions | null> {
  const reductionAmountCents = Math.max(0, -netChargeCents);
  const remainingRefundableCents = getRemainingRefundableCents(booking.payment);
  const basisAmountCents = Math.min(
    reductionAmountCents,
    remainingRefundableCents,
  );
  const hasSettledPayment =
    isSettledBookingStatus(booking.status) && hasCapturedPayment(booking.payment);

  if (basisAmountCents <= 0 || !hasSettledPayment) {
    return null;
  }

  const policy = await loadCancellationPolicy(booking.checkIn);
  const daysUntilCheckIn = daysUntilDate(booking.checkIn);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(basisAmountCents, daysUntilCheckIn, policy);

  return {
    basisAmountCents,
    cardRefundAmountCents,
    cardRefundPercentage,
    accountCreditAmountCents: creditRefundAmountCents,
    accountCreditPercentage: creditRefundPercentage,
    daysUntilCheckIn,
    requiresSettlementMethod:
      cardRefundAmountCents > 0 || creditRefundAmountCents > 0,
  };
}

function resolveSelectedSettlementAmount({
  settlementOptions,
  settlementMethod,
}: {
  settlementOptions: BookingModificationSettlementOptions | null | undefined;
  settlementMethod: BookingModificationSettlementMethod | undefined;
}) {
  if (!settlementOptions) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: 0,
    };
  }

  if (settlementOptions.requiresSettlementMethod && !settlementMethod) {
    throw new ApiError("Choose a refund or account credit before saving", 400);
  }

  if (!settlementOptions.requiresSettlementMethod) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: settlementOptions.basisAmountCents,
    };
  }

  const resolvedMethod = settlementMethod ?? "card";
  const amountCents =
    resolvedMethod === "credit"
      ? settlementOptions.accountCreditAmountCents
      : settlementOptions.cardRefundAmountCents;

  return {
    settlementMethod: resolvedMethod,
    amountCents,
    policyRetainedAmountCents: Math.max(
      0,
      settlementOptions.basisAmountCents - amountCents,
    ),
  };
}

export async function applyPaymentAdjustments(
  tx: Prisma.TransactionClient,
  {
    booking,
    priceDiffCents,
    changeFeeCents,
    settlementOptions,
    settlementMethod,
  }: {
    booking: LoadedBookingForModify;
    priceDiffCents: number;
    changeFeeCents: number;
    settlementOptions?: BookingModificationSettlementOptions | null;
    settlementMethod?: BookingModificationSettlementMethod;
  },
): Promise<PaymentAdjustmentResult> {
  const inSettledStatus = isSettledBookingStatus(booking.status);
  const hasSettledPayment =
    inSettledStatus && hasCapturedPayment(booking.payment);
  const hasSucceededPayment =
    hasSettledPayment && booking.payment?.source === PaymentSource.STRIPE;
  const hasIssuedXeroInvoice =
    inSettledStatus && !!booking.payment?.xeroInvoiceId;
  const remainingRefundableCents = getRemainingRefundableCents(booking.payment);

  const netAmountCents = priceDiffCents + changeFeeCents;
  const selectedSettlement = resolveSelectedSettlementAmount({
    settlementOptions,
    settlementMethod,
  });
  const xeroRefundAmountCents =
    hasIssuedXeroInvoice && netAmountCents < 0
      ? selectedSettlement.amountCents
      : 0;
  const xeroAdditionalAmountCents =
    hasIssuedXeroInvoice && netAmountCents > 0 ? netAmountCents : 0;

  let refundAmountCents = 0;
  let accountCreditAmountCents = 0;
  let additionalAmountCents = 0;
  let pendingRefundAmountCents = 0;

  if (hasSettledPayment && booking.payment) {
    if (settlementOptions && netAmountCents < 0) {
      if (selectedSettlement.settlementMethod === "credit") {
        accountCreditAmountCents = selectedSettlement.amountCents;
      } else {
        refundAmountCents = selectedSettlement.amountCents;
      }
      pendingRefundAmountCents = hasSucceededPayment ? refundAmountCents : 0;
    } else if (netAmountCents < 0) {
      refundAmountCents = Math.min(
        Math.abs(netAmountCents),
        remainingRefundableCents,
      );
      pendingRefundAmountCents = hasSucceededPayment ? refundAmountCents : 0;
    } else if (netAmountCents > 0) {
      additionalAmountCents = hasSucceededPayment
        ? netAmountCents
        : xeroAdditionalAmountCents;
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

  return {
    refundAmountCents,
    accountCreditAmountCents,
    additionalAmountCents,
    pendingRefundAmountCents,
    hasSucceededPayment,
    hasIssuedXeroInvoice,
    xeroRefundAmountCents,
    xeroAdditionalAmountCents,
    settlementMethod: selectedSettlement.settlementMethod,
    policyRetainedAmountCents: selectedSettlement.policyRetainedAmountCents,
  };
}

export type LifecycleTransitionResult = {
  hasNonMembers: boolean;
  newNonMemberHoldUntil: Date | null;
  newStatus: BookingStatus;
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
};

export async function applyLifecycleTransitions(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    newCheckIn,
    newFinalPriceCents,
    guestsForPricing,
    skipBookingLifecycleRules,
    reviewUpdate,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    newCheckIn: Date;
    newFinalPriceCents: number;
    guestsForPricing: Array<{ isMember: boolean }>;
    skipBookingLifecycleRules: boolean;
    reviewUpdate?: GuestPlan["reviewUpdate"];
  },
): Promise<LifecycleTransitionResult> {
  const hasNonMembers = !guestsForPricing.every((g) => g.isMember);
  let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
  let newStatus = booking.status;
  let zeroDollarAutoPaid = false;
  let supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[] = [];

  if (reviewUpdate?.parkForReview && newStatus !== "AWAITING_REVIEW") {
    newStatus = "AWAITING_REVIEW";
  } else if (reviewUpdate?.releaseFromReview && newStatus === "AWAITING_REVIEW") {
    newStatus = "PAYMENT_PENDING";
  }

  if (!skipBookingLifecycleRules && hasNonMembers) {
    const holdDays = await getNonMemberHoldDays(newCheckIn);
    const daysUntilNewCheckIn = Math.ceil(
      (newCheckIn.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysUntilNewCheckIn <= holdDays) {
      newNonMemberHoldUntil = null;
      if (booking.status === "PENDING") {
        newStatus = "PAYMENT_PENDING";
      }
    } else {
      newNonMemberHoldUntil = new Date(
        newCheckIn.getTime() - holdDays * 24 * 60 * 60 * 1000,
      );
    }
  } else if (!skipBookingLifecycleRules) {
    newNonMemberHoldUntil = null;
  }

  if (
    !skipBookingLifecycleRules &&
    newFinalPriceCents === 0 &&
    newStatus === BookingStatus.PAYMENT_PENDING
  ) {
    newStatus = BookingStatus.PAID;
    zeroDollarAutoPaid = true;
    const zeroDollarPayment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      },
      update: {
        amountCents: 0,
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    supersededPrimaryPaymentIntents =
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: zeroDollarPayment.id,
        newFinalPriceCents,
      });
  }

  return {
    hasNonMembers,
    newNonMemberHoldUntil,
    newStatus,
    zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents,
  };
}

export function assertBookingModifiable(
  booking: LoadedBookingForModify | null,
  { role, actorId }: { role: Role; actorId: string },
): asserts booking is LoadedBookingForModify {
  if (!booking) throw new ApiError("Booking not found", 404);
  if (booking.memberId !== actorId && role !== "ADMIN") {
    throw new ApiError("Forbidden", 403);
  }
  if (!canModifyBookingStatusForRole(booking.status, role)) {
    throw new ApiError(
      "This booking cannot be modified in its current status",
      400,
    );
  }
}
