import { PromoCodeType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { calculatePromoDiscount } from "@/lib/pricing";

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

  const validationError = validatePromoCodeRules(promoCode, bookingDetails);
  if (validationError) {
    return { valid: false, error: validationError };
  }

  // At this point promoCode is guaranteed non-null
  const discountCents = calculatePromoDiscount(
    {
      type: promoCode!.type,
      valueCents: promoCode!.valueCents,
      percentOff: promoCode!.percentOff,
      freeNights: promoCode!.freeNights,
    },
    bookingDetails.totalPriceCents,
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
    maxRedemptions: number | null;
    currentRedemptions: number;
    membersOnly: boolean;
    singleUse: boolean;
  } | null,
  bookingDetails: { memberId: string },
  now: Date = new Date(),
  memberRedemptionCount: number = 0
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

  if (
    promoCode.maxRedemptions !== null &&
    promoCode.currentRedemptions >= promoCode.maxRedemptions
  ) {
    return "This promo code has reached its maximum number of uses";
  }

  if (promoCode.membersOnly && !bookingDetails.memberId) {
    return "This promo code is only available to members";
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

  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    new Date(),
    memberRedemptionCount
  );

  if (validationError) {
    return { valid: false, error: validationError };
  }

  const discountCents = calculatePromoDiscount(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNights: promoCode.freeNights,
    },
    bookingDetails.totalPriceCents,
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
