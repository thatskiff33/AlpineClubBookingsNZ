import { Prisma, PromoCodeType, type FixedNightlyMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  calculatePromoDiscount,
  selectPromoDiscountGuests,
  type PromoCodeInput,
  type PromoDiscountAllocation,
  type PromoDiscountGuest,
  type PromoDiscountResult,
} from "@/lib/pricing";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";
import {
  getWorkPartyNightWindowForPromo,
  restrictPerNightRatesToWindow,
} from "@/lib/work-party";

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type PromoUsageClient = typeof prisma | Prisma.TransactionClient;

export interface PromoValidationResult {
  valid: boolean;
  error?: string;
  requiresGuestSelection?: boolean;
  selectableGuestIndexes?: number[];
  selectedGuestIndexes?: number[];
  promoCode?: {
    id: string;
    code: string;
    description: string | null;
    type: PromoCodeType;
    valueCents: number | null;
    percentOff: number | null;
    freeNightsPerIndividual: number | null;
    lifetimeFreeNightsCap: number | null;
    fixedNightlyPriceCents: number | null;
    fixedNightlyMode: FixedNightlyMode | null;
    maxGuestsPerBooking: number | null;
    maxNightlyValueCents: number | null;
    memberGuestsOnly: boolean;
    assignedMembersOnlyOwnNights: boolean;
  };
  discountCents?: number;
  promoAdjustmentCents?: number;
  freeNightsUsed?: number;
  eligibleGuestCount?: number;
  remainingFreeNights?: number;
  allocations?: PromoBeneficiaryAllocation[];
}

export interface PromoBeneficiaryAllocation {
  memberId: string;
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
}

export interface AvailablePromoCode {
  code: string;
  description: string | null;
  type: PromoCodeType;
  percentOff: number | null;
  valueCents: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: FixedNightlyMode | null;
}

export interface AssignedPromoCodeSummary extends AvailablePromoCode {
  id: string;
  assignedAt: Date | null;
  // lifetimeFreeNightsCap is inherited from AvailablePromoCode and represents
  // the maximum free nights this member can ever claim from this code.
  active: boolean;
  archivedAt: Date | null;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom: Date | null;
  bookingStartUntil: Date | null;
  maxRedemptionsTotal: number | null;
  currentRedemptions: number;
  maxUsesPerMember: number | null;
  redemptionCount: number;
  freeNightsUsed: number;
  visibleToMember: boolean;
  statusReason: string;
}

/**
 * PromoDiscountGuest plus the date of perNightRates[0] (the guest's
 * effective stay start when the rates were priced). Required to apply an
 * internal work party promo's night window; without it those guests'
 * nights are excluded from the discount (fail safe, never over-discount).
 */
export interface PromoDiscountGuestWithNights extends PromoDiscountGuest {
  firstNight?: Date | null;
}

export interface BookingDetailsForPromo {
  totalPriceCents: number;
  memberId: string;
  guests: PromoDiscountGuestWithNights[];
  bookingCheckIn?: Date;
}

export interface PromoApplicationSubject extends PromoRuleSubject {
  type: PromoCodeType;
  valueCents: number | null;
  percentOff: number | null;
  freeNightsPerIndividual: number | null;
  lifetimeFreeNightsCap: number | null;
  fixedNightlyPriceCents: number | null;
  fixedNightlyMode: FixedNightlyMode | null;
  maxGuestsPerBooking: number | null;
  maxNightlyValueCents: number | null;
  memberGuestsOnly: boolean;
  assignedMembersOnlyOwnNights?: boolean | null;
  // System-applied promo (work party events). Discount is restricted to the
  // linked event's night window; the code is rejected at manual entry.
  internal?: boolean | null;
}

export interface PromoApplicationResult {
  error?: string;
  requiresGuestSelection?: boolean;
  selectableGuestIndexes?: number[];
  discount?: PromoDiscountResult;
  beneficiaryMemberIds: string[];
  remainingFreeNights?: number;
  remainingFreeNightsByMemberId?: Record<string, number>;
  selectedGuestIndexes?: number[];
}

function hasAssignedMembers(assignedMemberIds: string[] | null | undefined) {
  return Boolean(assignedMemberIds && assignedMemberIds.length > 0);
}

function assignedMembersOnlyOwnNights(
  promoCode: { assignedMembersOnlyOwnNights?: boolean | null }
) {
  return promoCode.assignedMembersOnlyOwnNights ?? true;
}

function scopedAssignmentMemberIds(
  promoCode: { assignedMembersOnlyOwnNights?: boolean | null },
  assignedMemberIds: string[] | null | undefined
) {
  return assignedMembersOnlyOwnNights(promoCode) ? assignedMemberIds : null;
}

function assignmentRequiresGuestSelection(
  promoCode: { assignedMembersOnlyOwnNights?: boolean | null },
  assignedMemberIds: string[] | null | undefined
) {
  return hasAssignedMembers(assignedMemberIds) && !assignedMembersOnlyOwnNights(promoCode);
}

function storedPromoDateKey(value: Date | null | undefined) {
  return value ? formatDateOnly(value) : null;
}

function nzDateKey(value: Date) {
  return formatDateOnlyForTimeZone(value);
}

function scopeGuestsForAssignedMembers(
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null | undefined
) {
  if (!hasAssignedMembers(assignedMemberIds)) return guests;

  const assigned = new Set(assignedMemberIds);
  return guests.filter((guest) => Boolean(guest.memberId && assigned.has(guest.memberId)));
}

function selectablePromoGuestIndexes(
  promo: { memberGuestsOnly?: boolean | null },
  guests: PromoDiscountGuest[]
) {
  return guests
    .map((guest, index) => ({ guest, index }))
    .filter(({ guest }) => guest.perNightRates.length > 0)
    .filter(({ guest }) => !promo.memberGuestsOnly || guest.isMember)
    .map(({ index }) => index);
}

function normalizeSelectedGuestIndexes(
  selectedGuestIndexes: number[] | undefined,
  guestCount: number
): { indexes: number[]; error?: string } {
  if (!selectedGuestIndexes) {
    return { indexes: [] };
  }

  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const index of selectedGuestIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= guestCount) {
      return { indexes: [], error: "Selected promo guest is not on this booking" };
    }
    if (!seen.has(index)) {
      seen.add(index);
      indexes.push(index);
    }
  }
  indexes.sort((a, b) => a - b);
  return { indexes };
}

function filterGuestsByIndexes(guests: PromoDiscountGuest[], indexes: number[]) {
  return indexes.map((index) => guests[index]).filter(Boolean);
}

function normalizeAllocations(
  allocations: PromoDiscountAllocation[] | undefined,
  fallbackMemberId: string,
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed: number,
  forceFallback = false
): PromoBeneficiaryAllocation[] {
  const meaningfulAllocations = allocations ?? [];

  if (meaningfulAllocations.length > 0) {
    return meaningfulAllocations.map((allocation) => ({
      memberId: allocation.memberId,
      discountCents: allocation.discountCents,
      priceAdjustmentCents: allocation.priceAdjustmentCents,
      freeNightsUsed: allocation.freeNightsUsed,
    }));
  }

  if (
    discountCents <= 0 &&
    freeNightsUsed <= 0 &&
    priceAdjustmentCents === 0 &&
    !forceFallback
  ) return [];

  return [{
    memberId: fallbackMemberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed,
  }];
}

/**
 * Calculate the promo discount for a booking using the per-guest model.
 * When the promo has member assignments, the benefit is restricted to linked
 * guest rows whose memberId is assigned. Unassigned promos keep the existing
 * booking-member beneficiary semantics for usage caps.
 */
export function calculatePromoDiscountForGuestRates(
  promo: PromoCodeInput,
  totalPriceCents: number,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null,
  remainingFreeNights?: number,
  remainingFreeNightsByMemberId?: Record<string, number>
): PromoDiscountResult {
  const assignedScoped = hasAssignedMembers(assignedMemberIds);
  const scopedGuests = scopeGuestsForAssignedMembers(guests, assignedMemberIds);

  const result = calculatePromoDiscount(promo, {
    totalPriceCents,
    guests: scopedGuests,
    remainingFreeNights: assignedScoped && remainingFreeNightsByMemberId
      ? undefined
      : remainingFreeNights,
    remainingFreeNightsByMemberId: assignedScoped
      ? remainingFreeNightsByMemberId
      : undefined,
  });

  if (assignedScoped) {
    return result;
  }

  return {
    ...result,
    allocations: normalizeAllocations(
      [],
      bookingMemberId,
      result.discountCents,
      result.priceAdjustmentCents,
      result.freeNightsUsed,
      result.eligibleGuestCount > 0
    ),
  };
}

function selectPromoBeneficiaryGuests(
  promo: PromoCodeInput,
  guests: PromoDiscountGuest[]
) {
  const selectedGuests = selectPromoDiscountGuests(promo, guests);
  if (promo.type !== "FIXED_NIGHTLY_PRICE") {
    return selectedGuests;
  }

  const fixedNightlyPriceCents = promo.fixedNightlyPriceCents ?? 0;
  if (fixedNightlyPriceCents <= 0) return [];

  if ((promo.fixedNightlyMode ?? "CAP_ONLY") === "CAP_ONLY") {
    return selectedGuests.filter(({ guest }) =>
      guest.perNightRates.some((rate) => rate > fixedNightlyPriceCents)
    );
  }

  return selectedGuests.filter(({ guest }) => guest.perNightRates.length > 0);
}

export function getPromoBeneficiaryMemberIds(
  promo: PromoCodeInput,
  bookingMemberId: string,
  guests: PromoDiscountGuest[],
  assignedMemberIds: string[] | null = null
): string[] {
  const scopedGuests = scopeGuestsForAssignedMembers(guests, assignedMemberIds);
  const selectedGuests = selectPromoBeneficiaryGuests(promo, scopedGuests);
  if (selectedGuests.length === 0) return [];

  if (!hasAssignedMembers(assignedMemberIds)) {
    return [bookingMemberId];
  }

  return [...new Set(
    selectedGuests
      .map(({ guest }) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId))
  )];
}

export function shouldPersistPromoRedemption(result: PromoDiscountResult | null | undefined) {
  return Boolean(
    result &&
      (result.allocations.length > 0 ||
        result.discountCents > 0 ||
        result.priceAdjustmentCents !== 0 ||
        result.freeNightsUsed > 0 ||
        result.eligibleGuestCount > 0)
  );
}

export function formatSignedPromoAdjustmentCents(adjustmentCents: number) {
  if (adjustmentCents === 0) return "$0.00";
  const absolute = Math.abs(adjustmentCents);
  const formatted = `$${(absolute / 100).toFixed(2)}`;
  return adjustmentCents > 0 ? `+${formatted}` : `-${formatted}`;
}

/**
 * Get the total number of free nights a member has already consumed
 * from a specific promo code across all their redemptions.
 */
export async function getMemberFreeNightsUsed(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const result = await db.promoRedemptionAllocation.aggregate({
    where,
    _sum: { freeNightsUsed: true },
  });

  return result._sum.freeNightsUsed ?? 0;
}

/**
 * Count distinct members who have redeemed this promo code.
 * Excludes a specific booking id when updating an existing booking.
 */
export async function getUniqueMemberRedemptionCount(
  promoCodeId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: { promoCodeId: string; bookingId?: { not: string } } = {
    promoCodeId,
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }
  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return rows.length;
}

export async function getMemberPromoRedemptionCount(
  promoCodeId: string,
  memberId: string,
  excludeBookingId?: string,
  db: PromoUsageClient = prisma
): Promise<number> {
  const where: {
    promoCodeId: string;
    memberId: string;
    bookingId?: { not: string };
  } = { promoCodeId, memberId };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  return db.promoRedemptionAllocation.count({ where });
}

async function getPromoBeneficiaryUsage(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
) {
  const usage: Record<string, { redemptionCount: number; freeNightsUsed: number }> = {};
  await Promise.all(
    [...new Set(memberIds)].map(async (memberId) => {
      const [redemptionCount, freeNightsUsed] = await Promise.all([
        getMemberPromoRedemptionCount(promoCodeId, memberId, excludeBookingId, db),
        getMemberFreeNightsUsed(promoCodeId, memberId, excludeBookingId, db),
      ]);
      usage[memberId] = { redemptionCount, freeNightsUsed };
    })
  );
  return usage;
}

async function getExistingBeneficiaryMemberIds(
  promoCodeId: string,
  memberIds: string[],
  excludeBookingId: string | undefined,
  db: PromoUsageClient
): Promise<Set<string>> {
  const uniqueMemberIds = [...new Set(memberIds)];
  if (uniqueMemberIds.length === 0) return new Set();

  const where: {
    promoCodeId: string;
    memberId: { in: string[] };
    bookingId?: { not: string };
  } = {
    promoCodeId,
    memberId: { in: uniqueMemberIds },
  };
  if (excludeBookingId) {
    where.bookingId = { not: excludeBookingId };
  }

  const rows = await db.promoRedemptionAllocation.findMany({
    where,
    select: { memberId: true },
    distinct: ["memberId"],
  });
  return new Set(rows.map((row) => row.memberId));
}

export async function getAvailablePromoCodesForMember(
  memberId: string,
  now: Date = new Date()
): Promise<AvailablePromoCode[]> {
  const assignedPromoCodes = await getAssignedPromoCodeSummariesForMember(memberId, now);

  return assignedPromoCodes
    .filter((promoCode) => promoCode.visibleToMember)
    .map((promoCode) => ({
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      percentOff: promoCode.percentOff,
      valueCents: promoCode.valueCents,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      lifetimeFreeNightsCap: promoCode.lifetimeFreeNightsCap,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
    }));
}

export async function getAssignedPromoCodeSummariesForMember(
  memberId: string,
  now: Date = new Date()
): Promise<AssignedPromoCodeSummary[]> {
  const assignments = await prisma.promoCodeAssignment.findMany({
    where: { memberId, promoCode: { internal: false } },
    include: {
      promoCode: {
        include: {
          allocations: {
            where: { memberId },
            select: { id: true, freeNightsUsed: true },
          },
        },
      },
    },
  });

  return assignments.map((assignment) => {
    const promoCode = assignment.promoCode;
    const freeNightsUsed = promoCode.allocations.reduce(
      (sum, allocation) => sum + allocation.freeNightsUsed,
      0
    );
    const statusReason = getAssignedPromoCodeStatusReason(promoCode, freeNightsUsed, now);

    return {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      percentOff: promoCode.percentOff,
      valueCents: promoCode.valueCents,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      lifetimeFreeNightsCap: promoCode.lifetimeFreeNightsCap,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      assignedAt: assignment.createdAt ?? null,
      active: promoCode.active,
      archivedAt: promoCode.archivedAt,
      validFrom: promoCode.validFrom,
      validUntil: promoCode.validUntil,
      bookingStartFrom: promoCode.bookingStartFrom,
      bookingStartUntil: promoCode.bookingStartUntil,
      assignedMembersOnlyOwnNights: promoCode.assignedMembersOnlyOwnNights,
      maxRedemptionsTotal: promoCode.maxRedemptionsTotal,
      currentRedemptions: promoCode.currentRedemptions,
      maxUsesPerMember: promoCode.maxUsesPerMember,
      redemptionCount: promoCode.allocations.length,
      freeNightsUsed,
      visibleToMember: statusReason === null,
      statusReason: statusReason ?? "Available to member",
    };
  });
}

function getAssignedPromoCodeStatusReason(
  promoCode: {
    active: boolean;
    archivedAt: Date | null;
    validFrom: Date | null;
    validUntil: Date | null;
    maxRedemptionsTotal: number | null;
    currentRedemptions: number;
    maxUsesPerMember: number | null;
    type: PromoCodeType;
    lifetimeFreeNightsCap: number | null;
    allocations: Array<{ id: string; freeNightsUsed: number }>;
  },
  freeNightsUsed: number,
  now: Date
) {
  if (!promoCode.active) return "Inactive";
  if (promoCode.archivedAt) return "Archived";
  const currentDateKey = nzDateKey(now);
  const validFromKey = storedPromoDateKey(promoCode.validFrom);
  const validUntilKey = storedPromoDateKey(promoCode.validUntil);
  if (validFromKey && currentDateKey < validFromKey) return "Not valid yet";
  if (validUntilKey && currentDateKey > validUntilKey) return "Expired";
  if (
    promoCode.maxRedemptionsTotal !== null &&
    promoCode.currentRedemptions >= promoCode.maxRedemptionsTotal
  ) {
    return "Maximum uses reached";
  }
  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.allocations.length >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "Already used by member"
      : "Maximum uses by member reached";
  }
  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap !== null &&
    freeNightsUsed >= promoCode.lifetimeFreeNightsCap
  ) {
    return "Free nights used";
  }
  return null;
}

/**
 * Promo rule shape used by pure validation. Booking-time callers and the
 * validate API both populate this from the locked PromoCode row.
 */
export interface PromoRuleSubject {
  id: string;
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  bookingStartFrom?: Date | null;
  bookingStartUntil?: Date | null;
  maxRedemptionsTotal: number | null;
  currentRedemptions: number;
  membersOnly: boolean;
  maxUsesPerMember: number | null;
  maxUniqueMembersTotal: number | null;
  type?: PromoCodeType;
  freeNightsPerIndividual?: number | null;
  lifetimeFreeNightsCap?: number | null;
  assignedMembersOnlyOwnNights?: boolean | null;
}

export interface PromoRuleCounts {
  memberRedemptionCount?: number;
  memberFreeNightsUsed?: number;
  uniqueMembersUsed?: number;
  memberHasRedeemedBefore?: boolean;
  requestedRedemptionCount?: number;
  requestedNewUniqueMemberCount?: number;
  memberRedemptionCounts?: Record<string, number>;
  memberFreeNightsUsedByMemberId?: Record<string, number>;
  // True for assigned-member promos where every linked member guest is at
  // their per-member cap (redemptions or lifetime free nights). Signals that
  // no beneficiary survives the upstream filter.
  allBeneficiariesExhausted?: boolean;
}

/**
 * Validate promo code rules (pure logic, separated for testing).
 * Returns error message string if invalid, null if valid.
 */
export function validatePromoCodeRules(
  promoCode: PromoRuleSubject | null,
  bookingDetails: { memberId: string; bookingCheckIn?: Date },
  now: Date = new Date(),
  counts: PromoRuleCounts = {},
  assignedMemberIds: string[] | null = null
): string | null {
  if (!promoCode) {
    return "Promo code not found";
  }

  if (!promoCode.active) {
    return "This promo code is no longer active";
  }

  const currentDateKey = nzDateKey(now);
  const validFromKey = storedPromoDateKey(promoCode.validFrom);
  const validUntilKey = storedPromoDateKey(promoCode.validUntil);
  if (validFromKey && currentDateKey < validFromKey) {
    return "This promo code is not yet valid";
  }

  if (validUntilKey && currentDateKey > validUntilKey) {
    return "This promo code has expired";
  }

  if (bookingDetails.bookingCheckIn) {
    const checkInKey = nzDateKey(bookingDetails.bookingCheckIn);
    const bookingStartFromKey = storedPromoDateKey(promoCode.bookingStartFrom);
    const bookingStartUntilKey = storedPromoDateKey(promoCode.bookingStartUntil);
    if (bookingStartFromKey && checkInKey < bookingStartFromKey) {
      return "This promo code is not valid for your booking dates";
    }
    if (bookingStartUntilKey && checkInKey >= bookingStartUntilKey) {
      return "This promo code is not valid for your booking dates";
    }
  }

  if (
    promoCode.maxRedemptionsTotal !== null &&
    promoCode.currentRedemptions + (counts.requestedRedemptionCount ?? 1) >
      promoCode.maxRedemptionsTotal
  ) {
    return "This promo code has reached its maximum number of uses";
  }

  if (promoCode.membersOnly && !bookingDetails.memberId) {
    return "This promo code is only available to members";
  }

  if (assignedMemberIds !== null && assignedMemberIds.length > 0) {
    if (!bookingDetails.memberId || !assignedMemberIds.includes(bookingDetails.memberId)) {
      return "This promo code is not assigned to you";
    }
  }

  // Cap on distinct members. Allow if the booker has already redeemed at
  // least once (they're counted), otherwise reject when the cap is hit.
  if (
    promoCode.maxUniqueMembersTotal !== null &&
    promoCode.maxUniqueMembersTotal !== undefined &&
    counts.requestedNewUniqueMemberCount !== undefined &&
    (counts.uniqueMembersUsed ?? 0) + counts.requestedNewUniqueMemberCount >
      promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  if (
    promoCode.maxUniqueMembersTotal !== null &&
    promoCode.maxUniqueMembersTotal !== undefined &&
    counts.requestedNewUniqueMemberCount === undefined &&
    !counts.memberHasRedeemedBefore &&
    (counts.uniqueMembersUsed ?? 0) >= promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  // For assigned-member promos, exhausted beneficiaries are filtered out
  // upstream in validateAndCalculatePromoDiscount. The .some() rejection here
  // would otherwise block the whole code when one linked guest is at cap,
  // even if others still have allowance. The per-booker fallback below still
  // applies for unassigned promos.

  if (
    promoCode.maxUsesPerMember !== null &&
    promoCode.maxUsesPerMember !== undefined &&
    !counts.memberRedemptionCounts &&
    (counts.memberRedemptionCount ?? 0) >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "You have already used this promo code"
      : "You have reached the maximum uses of this promo code";
  }

  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap &&
    !counts.memberFreeNightsUsedByMemberId &&
    (counts.memberFreeNightsUsed ?? 0) >= promoCode.lifetimeFreeNightsCap
  ) {
    return "You have used all your free nights for this promo code";
  }

  if (counts.allBeneficiariesExhausted) {
    return "All linked member guests have used this promo code";
  }

  return null;
}

export async function validateAndCalculatePromoDiscount(
  promoCode: PromoApplicationSubject | null,
  bookingDetails: BookingDetailsForPromo,
  assignedMemberIds: string[] | null = null,
  options: {
    excludeBookingId?: string;
    db?: PromoUsageClient;
    now?: Date;
    selectedGuestIndexes?: number[];
  } = {}
): Promise<PromoApplicationResult> {
  if (!promoCode) {
    return {
      error: "Promo code not found",
      beneficiaryMemberIds: [],
    };
  }

  const db = options.db ?? prisma;

  // Internal work party promos discount only the nights inside the linked
  // event's window. Restrict each guest's per-night rates up front so all
  // downstream eligibility and discount maths see in-window nights only.
  // Guests without a firstNight cannot be dated, so their nights are
  // excluded entirely (fail safe, never over-discount).
  let detailGuests = bookingDetails.guests;
  if (promoCode.internal) {
    const nightWindow = await getWorkPartyNightWindowForPromo(db, promoCode.id);
    if (nightWindow) {
      detailGuests = bookingDetails.guests.map((guest) => ({
        ...guest,
        perNightRates: guest.firstNight
          ? restrictPerNightRatesToWindow(
              guest.perNightRates,
              guest.firstNight,
              nightWindow
            )
          : [],
      }));
    }
  }

  const requiresGuestSelection = assignmentRequiresGuestSelection(promoCode, assignedMemberIds);
  const selectableGuestIndexes = requiresGuestSelection
    ? selectablePromoGuestIndexes(promoCode, detailGuests)
    : undefined;
  const selectedGuestIndexes = normalizeSelectedGuestIndexes(
    options.selectedGuestIndexes,
    detailGuests.length
  );
  if (selectedGuestIndexes.error) {
    return {
      error: selectedGuestIndexes.error,
      beneficiaryMemberIds: [],
    };
  }
  if (requiresGuestSelection) {
    if (!options.selectedGuestIndexes || selectedGuestIndexes.indexes.length === 0) {
      return {
        error: "Choose which guests should receive this promo code",
        requiresGuestSelection: true,
        selectableGuestIndexes,
        beneficiaryMemberIds: [],
      };
    }
    const selectable = new Set(selectableGuestIndexes ?? []);
    if (selectedGuestIndexes.indexes.some((index) => !selectable.has(index))) {
      return {
        error: "One or more selected guests cannot use this promo code",
        requiresGuestSelection: true,
        selectableGuestIndexes,
        beneficiaryMemberIds: [],
      };
    }
    if (
      promoCode.maxGuestsPerBooking !== null &&
      promoCode.maxGuestsPerBooking !== undefined &&
      selectedGuestIndexes.indexes.length > promoCode.maxGuestsPerBooking
    ) {
      return {
        error: `Choose no more than ${promoCode.maxGuestsPerBooking} guest${promoCode.maxGuestsPerBooking === 1 ? "" : "s"} for this promo code`,
        requiresGuestSelection: true,
        selectableGuestIndexes,
        beneficiaryMemberIds: [],
      };
    }
  }
  const guestsForPromo = requiresGuestSelection
    ? filterGuestsByIndexes(detailGuests, selectedGuestIndexes.indexes)
    : detailGuests;
  const assignedGuestScopeMemberIds = scopedAssignmentMemberIds(
    promoCode,
    assignedMemberIds
  );
  const initialBeneficiaryMemberIds = getPromoBeneficiaryMemberIds(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
    },
    bookingDetails.memberId,
    guestsForPromo,
    assignedGuestScopeMemberIds
  );

  if (hasAssignedMembers(assignedGuestScopeMemberIds) && initialBeneficiaryMemberIds.length === 0) {
    return {
      error: "This promo code only applies when an assigned member is staying on the booking",
      beneficiaryMemberIds: [],
    };
  }

  const beneficiaryUsage = await getPromoBeneficiaryUsage(
    promoCode.id,
    initialBeneficiaryMemberIds,
    options.excludeBookingId,
    db
  );
  const bookerUsage = beneficiaryUsage[bookingDetails.memberId] ?? {
    redemptionCount: 0,
    freeNightsUsed: 0,
  };

  // For assigned-member promos, drop beneficiaries who've already exhausted
  // their per-member caps (redemptions or lifetime free nights). The promo
  // still applies for the remaining beneficiaries; only if every beneficiary
  // is exhausted do we reject the code.
  const assignedScoped = hasAssignedMembers(assignedGuestScopeMemberIds);
  const isMemberExhausted = (memberId: string) => {
    const usage = beneficiaryUsage[memberId] ?? { redemptionCount: 0, freeNightsUsed: 0 };
    if (
      promoCode.maxUsesPerMember !== null &&
      promoCode.maxUsesPerMember !== undefined &&
      usage.redemptionCount >= promoCode.maxUsesPerMember
    ) {
      return true;
    }
    if (
      promoCode.type === "FREE_NIGHTS" &&
      promoCode.lifetimeFreeNightsCap !== null &&
      promoCode.lifetimeFreeNightsCap !== undefined &&
      usage.freeNightsUsed >= promoCode.lifetimeFreeNightsCap
    ) {
      return true;
    }
    return false;
  };

  const beneficiaryMemberIds =
    assignedScoped && initialBeneficiaryMemberIds.length > 0
      ? initialBeneficiaryMemberIds.filter((id) => !isMemberExhausted(id))
      : initialBeneficiaryMemberIds;

  const allBeneficiariesExhausted =
    assignedScoped &&
    initialBeneficiaryMemberIds.length > 0 &&
    beneficiaryMemberIds.length === 0;

  let uniqueMembersUsed = 0;
  let requestedNewUniqueMemberCount: number | undefined;
  if (promoCode.maxUniqueMembersTotal !== null && promoCode.maxUniqueMembersTotal !== undefined) {
    uniqueMembersUsed = await getUniqueMemberRedemptionCount(
      promoCode.id,
      options.excludeBookingId,
      db
    );
    const existingBeneficiaries = await getExistingBeneficiaryMemberIds(
      promoCode.id,
      beneficiaryMemberIds,
      options.excludeBookingId,
      db
    );
    requestedNewUniqueMemberCount = beneficiaryMemberIds.filter(
      (memberId) => !existingBeneficiaries.has(memberId)
    ).length;
  }

  // For assigned-member promos the booker is just another linked member guest
  // and per-member caps are enforced by the upstream filter, so we suppress
  // the booker-scoped fallback checks in the validator.
  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    options.now ?? new Date(),
    {
      memberRedemptionCount: assignedScoped ? undefined : bookerUsage.redemptionCount,
      memberFreeNightsUsed: assignedScoped ? undefined : bookerUsage.freeNightsUsed,
      uniqueMembersUsed,
      memberHasRedeemedBefore: bookerUsage.redemptionCount > 0,
      requestedRedemptionCount: beneficiaryMemberIds.length,
      requestedNewUniqueMemberCount,
      allBeneficiariesExhausted,
    },
    requiresGuestSelection ? assignedMemberIds : null
  );

  if (validationError) {
    return {
      error: validationError,
      beneficiaryMemberIds: initialBeneficiaryMemberIds,
    };
  }

  const remainingFreeNightsByMemberId =
    assignedScoped &&
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap !== null &&
    promoCode.lifetimeFreeNightsCap !== undefined
      ? Object.fromEntries(
          beneficiaryMemberIds.map((memberId) => [
            memberId,
            Math.max(
              0,
              promoCode.lifetimeFreeNightsCap! -
                (beneficiaryUsage[memberId]?.freeNightsUsed ?? 0)
            ),
          ])
        )
      : undefined;
  const remainingFreeNights =
    !assignedScoped &&
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap !== null &&
    promoCode.lifetimeFreeNightsCap !== undefined
      ? Math.max(0, promoCode.lifetimeFreeNightsCap - bookerUsage.freeNightsUsed)
      : undefined;

  // Effective assigned-member list passed to pricing: filtered to those with
  // remaining budget so exhausted members' guest rows are excluded from the
  // discount candidates.
  const effectiveGuestScopeMemberIds = assignedScoped
    ? beneficiaryMemberIds
    : assignedGuestScopeMemberIds;

  const discount = calculatePromoDiscountForGuestRates(
    {
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
    },
    bookingDetails.totalPriceCents,
    bookingDetails.memberId,
    guestsForPromo,
    effectiveGuestScopeMemberIds,
    remainingFreeNights,
    remainingFreeNightsByMemberId
  );

  return {
    discount,
    beneficiaryMemberIds,
    remainingFreeNights,
    remainingFreeNightsByMemberId,
    selectedGuestIndexes: requiresGuestSelection ? selectedGuestIndexes.indexes : undefined,
  };
}

/**
 * Full validation including database lookups for caps and cumulative
 * free-night tracking. Use this in API routes where you need the full
 * validation and discount calculation.
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

  // Internal promos (work party events) are system-applied only; treat a
  // manually entered internal code exactly like a nonexistent one.
  if (!promoCode || promoCode.internal) {
    return { valid: false, error: "Promo code not found" };
  }

  const assignedMemberIds = promoCode.assignments.length > 0
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  const application = await validateAndCalculatePromoDiscount(
    promoCode,
    bookingDetails,
    assignedMemberIds,
    { excludeBookingId }
  );

  if (application.error || !application.discount) {
    return { valid: false, error: application.error ?? "Promo code could not be applied" };
  }

  const result = application.discount;

  return {
    valid: true,
    promoCode: {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      valueCents: promoCode.valueCents,
      percentOff: promoCode.percentOff,
      freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
      lifetimeFreeNightsCap: promoCode.lifetimeFreeNightsCap,
      fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
      fixedNightlyMode: promoCode.fixedNightlyMode,
      maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
      maxNightlyValueCents: promoCode.maxNightlyValueCents,
      memberGuestsOnly: promoCode.memberGuestsOnly,
      assignedMembersOnlyOwnNights: promoCode.assignedMembersOnlyOwnNights,
    },
    discountCents: result.discountCents,
    promoAdjustmentCents: result.priceAdjustmentCents,
    freeNightsUsed: result.freeNightsUsed,
    eligibleGuestCount: result.eligibleGuestCount,
    remainingFreeNights: application.remainingFreeNights,
    allocations: result.allocations,
    selectedGuestIndexes: application.selectedGuestIndexes,
  };
}

/**
 * Create a PromoRedemption record and increment the promo code's currentRedemptions.
 * Should be called within a Prisma transaction.
 */
export async function redeemPromoCode(
  tx: PrismaTx,
  promoCodeId: string,
  bookingId: string,
  memberId: string,
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed?: number,
  eligibleGuestCount?: number,
  allocations?: PromoBeneficiaryAllocation[],
  targetBookingGuestIds?: string[]
): Promise<void> {
  const redemption = await tx.promoRedemption.create({
    data: {
      promoCodeId,
      bookingId,
      memberId,
      discountCents,
      priceAdjustmentCents,
      freeNightsUsed: freeNightsUsed ?? null,
      eligibleGuestCount: eligibleGuestCount ?? null,
    },
  });

  const allocationData = normalizeAllocations(
    allocations,
    memberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed ?? 0
  );
  await tx.promoRedemptionAllocation.deleteMany({
    where: { promoRedemptionId: redemption.id },
  });
  if (allocationData.length > 0) {
    await tx.promoRedemptionAllocation.createMany({
      data: allocationData.map((allocation) => ({
        promoRedemptionId: redemption.id,
        promoCodeId,
        bookingId,
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        priceAdjustmentCents: allocation.priceAdjustmentCents,
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    });
  }
  if (targetBookingGuestIds && targetBookingGuestIds.length > 0) {
    await tx.promoRedemptionGuestTarget.createMany({
      data: [...new Set(targetBookingGuestIds)].map((bookingGuestId) => ({
        promoRedemptionId: redemption.id,
        bookingId,
        bookingGuestId,
      })),
    });
  }

  await tx.promoCode.update({
    where: { id: promoCodeId },
    data: {
      currentRedemptions: { increment: allocationData.length },
    },
  });
}

export async function replacePromoRedemptionAllocations(
  tx: PrismaTx,
  redemption: { id: string; promoCodeId: string; bookingId: string; memberId: string },
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed?: number,
  eligibleGuestCount?: number,
  allocations?: PromoBeneficiaryAllocation[],
  targetBookingGuestIds?: string[]
): Promise<void> {
  const existingAllocationCount = await tx.promoRedemptionAllocation.count({
    where: { promoRedemptionId: redemption.id },
  });
  await tx.promoRedemption.update({
    where: { id: redemption.id },
    data: {
      discountCents,
      priceAdjustmentCents,
      freeNightsUsed: freeNightsUsed || null,
      eligibleGuestCount: eligibleGuestCount || null,
    },
  });

  const allocationData = normalizeAllocations(
    allocations,
    redemption.memberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed ?? 0
  );

  await tx.promoRedemptionAllocation.deleteMany({
    where: { promoRedemptionId: redemption.id },
  });
  if (allocationData.length > 0) {
    await tx.promoRedemptionAllocation.createMany({
      data: allocationData.map((allocation) => ({
        promoRedemptionId: redemption.id,
        promoCodeId: redemption.promoCodeId,
        bookingId: redemption.bookingId,
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        priceAdjustmentCents: allocation.priceAdjustmentCents,
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    });
  }
  if (targetBookingGuestIds !== undefined) {
    await tx.promoRedemptionGuestTarget.deleteMany({
      where: { promoRedemptionId: redemption.id },
    });
    if (targetBookingGuestIds.length > 0) {
      await tx.promoRedemptionGuestTarget.createMany({
        data: [...new Set(targetBookingGuestIds)].map((bookingGuestId) => ({
          promoRedemptionId: redemption.id,
          bookingId: redemption.bookingId,
          bookingGuestId,
        })),
      });
    }
  }

  const delta = allocationData.length - existingAllocationCount;
  if (delta !== 0) {
    await tx.promoCode.update({
      where: { id: redemption.promoCodeId },
      data: {
        currentRedemptions: delta > 0
          ? { increment: delta }
          : { decrement: Math.abs(delta) },
      },
    });
  }
}

export async function deletePromoRedemptionAndAdjustCount(
  tx: PrismaTx,
  redemption: { id: string; promoCodeId: string }
): Promise<void> {
  const allocationCount = await tx.promoRedemptionAllocation.count({
    where: { promoRedemptionId: redemption.id },
  });
  await tx.promoRedemption.delete({ where: { id: redemption.id } });

  if (allocationCount > 0) {
    await tx.promoCode.update({
      where: { id: redemption.promoCodeId },
      data: { currentRedemptions: { decrement: allocationCount } },
    });
  }
}
