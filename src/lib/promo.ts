import { PromoCodeType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { calculatePromoDiscount, type PromoCodeInput } from "@/lib/pricing";

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
  fallbackPerNightRates?: number[]
): number {
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

  return calculatePromoDiscount(promo, totalPriceCents, perNightRates);
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
  const discountCents = calculatePromoDiscountForGuestRates(
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
    discountCents,
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
  } | null,
  bookingDetails: { memberId: string; bookingCheckIn?: Date },
  now: Date = new Date(),
  memberRedemptionCount: number = 0,
  assignedMemberIds: string[] | null = null
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

  return null;
}

/**
 * Full validation including database lookups for single-use checks.
 * Use this in API routes where you need the full validation.
 */
export async function validatePromoCodeFull(
  code: string,
  bookingDetails: BookingDetailsForPromo
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
    memberRedemptionCount = await prisma.promoRedemption.count({
      where: {
        promoCodeId: promoCode.id,
        memberId: bookingDetails.memberId,
      },
    });
  }

  const assignedMemberIds = promoCode.assignments.length > 0
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    new Date(),
    memberRedemptionCount,
    assignedMemberIds
  );

  if (validationError) {
    return { valid: false, error: validationError };
  }

  const discountCents = calculatePromoDiscountForGuestRates(
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
    bookingDetails.perNightRates
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
    discountCents,
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
  discountCents: number
): Promise<void> {
  await tx.promoRedemption.create({
    data: {
      promoCodeId,
      bookingId,
      memberId,
      discountCents,
    },
  });

  await tx.promoCode.update({
    where: { id: promoCodeId },
    data: {
      currentRedemptions: { increment: 1 },
    },
  });
}
