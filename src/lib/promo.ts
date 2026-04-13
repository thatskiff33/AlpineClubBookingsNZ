import { PromoCodeType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { calculatePromoDiscount, type PromoCodeInput, type PromoDiscountResult } from "@/lib/pricing";

export interface PromoValidationResult {
  valid: boolean;
  error?: string;
  promoCode?: {
    id: string;
    code: string;
    description: string | null;
    type: PromoCodeType;
    valueCents: number | null;
    percentOff: number | null;
    freeNights: number | null;
  };
  discountCents?: number;
  freeNightsUsed?: number;
  remainingFreeNights?: number;
}

export interface AvailablePromoCode {
  code: string;
  description: string | null;
  type: PromoCodeType;
  percentOff: number | null;
  valueCents: number | null;
  freeNights: number | null;
}

export interface BookingDetailsForPromo {
  totalPriceCents: number;
  perNightRates: number[];
  memberId: string;
  bookingCheckIn?: Date;
  guestNightRates?: GuestNightRatesForPromo[];
}

export interface GuestNightRatesForPromo {
  memberId: string | null;
  perNightRates: number[];
}

export function calculatePromoDiscountForGuestRates(
  promo: PromoCodeInput,
  totalPriceCents: number,
  bookingMemberId: string,
  guestNightRates: GuestNightRatesForPromo[] | undefined,
  assignedMemberIds: string[] | null = null,
  fallbackPerNightRates?: number[],
  remainingFreeNights?: number
): PromoDiscountResult {
  let perNightRates = fallbackPerNightRates;

  if (guestNightRates) {
    if (promo.type === "FREE_NIGHTS" && assignedMemberIds && assignedMemberIds.length > 0) {
      perNightRates = guestNightRates
        .filter((guest) => guest.memberId === bookingMemberId)
        .flatMap((guest) => guest.perNightRates);
    } else {
      perNightRates = guestNightRates.flatMap((guest) => guest.perNightRates);
    }
  }

  return calculatePromoDiscount(promo, totalPriceCents, perNightRates, remainingFreeNights);
}

/**
 * Get the total number of free nights a member has already consumed
 * from a specific promo code across all their redemptions.
 */
export async function getMemberFreeNightsUsed(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const result = await prisma.promoRedemption.aggregate({
    where,
    _sum: { freeNightsUsed: true },
  });

  return result._sum.freeNightsUsed ?? 0;
}

export async function getAvailablePromoCodesForMember(
  memberId: string,
  now: Date = new Date()
): Promise<AvailablePromoCode[]> {
  const assignments = await prisma.promoCodeAssignment.findMany({
    where: { memberId },
    include: {
      promoCode: {
        include: {
          redemptions: {
            where: { memberId },
            select: { id: true, freeNightsUsed: true },
          },
        },
      },
    },
  });

  return assignments
    .map((assignment) => assignment.promoCode)
    .filter((promoCode) => {
      if (!promoCode.active || promoCode.archivedAt) return false;
      if (promoCode.validFrom && now < promoCode.validFrom) return false;
      if (promoCode.validUntil && now >= promoCode.validUntil) return false;
      if (
        promoCode.maxRedemptions !== null &&
        promoCode.currentRedemptions >= promoCode.maxRedemptions
      ) {
        return false;
      }
      if (promoCode.singleUse && promoCode.redemptions.length > 0) return false;
      // For FREE_NIGHTS, hide if all free nights have been consumed
      if (promoCode.type === "FREE_NIGHTS" && promoCode.freeNights) {
        const totalUsed = promoCode.redemptions.reduce(
          (sum, r) => sum + (r.freeNightsUsed ?? 0),
          0
        );
        if (totalUsed >= promoCode.freeNights) return false;
      }
      return true;
    })
    .map((promoCode) => ({
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      percentOff: promoCode.percentOff,
      valueCents: promoCode.valueCents,
      freeNights: promoCode.freeNights,
    }));
}

/**
 * Validate a promo code and calculate the discount for a given booking.
 * Returns validation result with discount amount if valid.
 */
export async function validateAndApplyPromoCode(
  code: string,
  bookingDetails: BookingDetailsForPromo
): Promise<PromoValidationResult> {
  const promoCode = await prisma.promoCode.findUnique({
    where: { code: code.toUpperCase().trim() },
  });

  const validationError = validatePromoCodeRules(promoCode, { memberId: bookingDetails.memberId, bookingCheckIn: bookingDetails.bookingCheckIn });
  if (validationError) {
    return { valid: false, error: validationError };
  }

  // At this point promoCode is guaranteed non-null
  const result = calculatePromoDiscountForGuestRates(
    {
      type: promoCode!.type,
      valueCents: promoCode!.valueCents,
      percentOff: promoCode!.percentOff,
      freeNights: promoCode!.freeNights,
    },
    bookingDetails.totalPriceCents,
    bookingDetails.memberId,
    bookingDetails.guestNightRates,
    null,
    bookingDetails.perNightRates
  );

  return {
    valid: true,
    promoCode: {
      id: promoCode!.id,
      code: promoCode!.code,
      description: promoCode!.description,
      type: promoCode!.type,
      valueCents: promoCode!.valueCents,
      percentOff: promoCode!.percentOff,
      freeNights: promoCode!.freeNights,
    },
    discountCents: result.discountCents,
    freeNightsUsed: result.freeNightsUsed,
  };
}

/**
 * Validate promo code rules (pure logic, separated for testing).
 * Returns error message string if invalid, null if valid.
 */
export function validatePromoCodeRules(
  promoCode: {
    id: string;
    active: boolean;
    validFrom: Date | null;
    validUntil: Date | null;
    bookingStartFrom?: Date | null;
    bookingStartUntil?: Date | null;
    maxRedemptions: number | null;
    currentRedemptions: number;
    membersOnly: boolean;
    singleUse: boolean;
    type?: PromoCodeType;
    freeNights?: number | null;
  } | null,
  bookingDetails: { memberId: string; bookingCheckIn?: Date },
  now: Date = new Date(),
  memberRedemptionCount: number = 0,
  assignedMemberIds: string[] | null = null,
  memberFreeNightsUsed: number = 0
): string | null {
  if (!promoCode) {
    return "Promo code not found";
  }

  if (!promoCode.active) {
    return "This promo code is no longer active";
  }

  if (promoCode.validFrom && now < promoCode.validFrom) {
    return "This promo code is not yet valid";
  }

  if (promoCode.validUntil && now >= promoCode.validUntil) {
    return "This promo code has expired";
  }

  // Booking date gating (P5.3): check if the booking check-in date falls within allowed range
  if (bookingDetails.bookingCheckIn) {
    if (promoCode.bookingStartFrom && bookingDetails.bookingCheckIn < promoCode.bookingStartFrom) {
      return "This promo code is not valid for your booking dates";
    }
    if (promoCode.bookingStartUntil && bookingDetails.bookingCheckIn >= promoCode.bookingStartUntil) {
      return "This promo code is not valid for your booking dates";
    }
  }

  if (
    promoCode.maxRedemptions !== null &&
    promoCode.currentRedemptions >= promoCode.maxRedemptions
  ) {
    return "This promo code has reached its maximum number of uses";
  }

  if (promoCode.membersOnly && !bookingDetails.memberId) {
    return "This promo code is only available to members";
  }

  // If code has member assignments, only assigned members can use it
  if (assignedMemberIds !== null && assignedMemberIds.length > 0) {
    if (!bookingDetails.memberId || !assignedMemberIds.includes(bookingDetails.memberId)) {
      return "This promo code is not assigned to you";
    }
  }

  if (promoCode.singleUse && memberRedemptionCount > 0) {
    return "You have already used this promo code";
  }

  // For FREE_NIGHTS promos, check if all free nights have been consumed
  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.freeNights &&
    memberFreeNightsUsed >= promoCode.freeNights
  ) {
    return "You have used all your free nights for this promo code";
  }

  return null;
}

/**
 * Full validation including database lookups for single-use checks
 * and cumulative free-night tracking.
 * Use this in API routes where you need the full validation.
 */
export async function validatePromoCodeFull(
  code: string,
  bookingDetails: BookingDetailsForPromo,
  excludeBookingId?: string
): Promise<PromoValidationResult> {
  const normalizedCode = code.toUpperCase().trim();

  const promoCode = await prisma.promoCode.findUnique({
    where: { code: normalizedCode },
    include: { assignments: { select: { memberId: true } } },
  });

  if (!promoCode) {
    return { valid: false, error: "Promo code not found" };
  }

  // Check single-use: has this member already used this code?
  let memberRedemptionCount = 0;
  if (promoCode.singleUse) {
    const where: { promoCodeId: string; memberId: string; bookingId?: { not: string } } = {
      promoCodeId: promoCode.id,
      memberId: bookingDetails.memberId,
    };
    if (excludeBookingId) {
      where.bookingId = { not: excludeBookingId };
    }
    memberRedemptionCount = await prisma.promoRedemption.count({ where });
  }

  // For FREE_NIGHTS, get cumulative free nights used by this member
  let memberFreeNightsUsed = 0;
  if (promoCode.type === "FREE_NIGHTS" && promoCode.freeNights) {
    memberFreeNightsUsed = await getMemberFreeNightsUsed(
      promoCode.id,
      bookingDetails.memberId,
      excludeBookingId
    );
  }

  const assignedMemberIds = promoCode.assignments.length > 0
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    new Date(),
    memberRedemptionCount,
    assignedMemberIds,
    memberFreeNightsUsed
  );

  if (validationError) {
    return { valid: false, error: validationError };
  }

  // Calculate remaining free nights for this member
  const remainingFreeNights = promoCode.type === "FREE_NIGHTS" && promoCode.freeNights
    ? promoCode.freeNights - memberFreeNightsUsed
    : undefined;

  const result = calculatePromoDiscountForGuestRates(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNights: promoCode.freeNights,
    },
    bookingDetails.totalPriceCents,
    bookingDetails.memberId,
    bookingDetails.guestNightRates,
    assignedMemberIds,
    bookingDetails.perNightRates,
    remainingFreeNights
  );

  return {
    valid: true,
    promoCode: {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNights: promoCode.freeNights,
    },
    discountCents: result.discountCents,
    freeNightsUsed: result.freeNightsUsed,
    remainingFreeNights,
  };
}

/**
 * Create a PromoRedemption record and increment the promo code's currentRedemptions.
 * Should be called within a Prisma transaction.
 */
export async function redeemPromoCode(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  promoCodeId: string,
  bookingId: string,
  memberId: string,
  discountCents: number,
  freeNightsUsed?: number
): Promise<void> {
  await tx.promoRedemption.create({
    data: {
      promoCodeId,
      bookingId,
      memberId,
      discountCents,
      freeNightsUsed: freeNightsUsed ?? null,
    },
  });

  await tx.promoCode.update({
    where: { id: promoCodeId },
    data: {
      currentRedemptions: { increment: 1 },
    },
  });
}
