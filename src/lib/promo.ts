import { PromoCodeType, type FixedNightlyMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  calculatePromoDiscount,
  type PromoCodeInput,
  type PromoDiscountAllocation,
  type PromoDiscountGuest,
  type PromoDiscountResult,
} from "@/lib/pricing";
import { formatDateOnly } from "@/lib/date-only";
import {
  clubCalendarDateOf,
  type CalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  getWorkPartyNightWindowForPromo,
  restrictPerNightRatesToWindow,
} from "@/lib/work-party";
import { ApiError } from "@/lib/api-error";
import {
  assignmentRequiresAssignedBooker,
  assignmentRequiresGuestSelection,
  filterGuestsByIndexes,
  getPromoBeneficiaryMemberIds,
  hasAssignedMembers,
  normalizeSelectedGuestIndexes,
  scopedAssignmentMemberIds,
  scopeGuestsForAssignedMembers,
  selectablePromoGuestIndexes,
} from "@/lib/promo-guest-scope";
import {
  BENEFICIAL_PROMO_ALLOCATION_FILTER,
  getBookingBeneficiaryFreeNights,
  getExistingBeneficiaryMemberIds,
  getPromoBeneficiaryUsage,
  getUniqueMemberRedemptionCount,
  isBeneficialPromoAllocation,
  type PromoUsageClient,
} from "@/lib/promo-usage-counts";

export const PROMO_LODGE_RESTRICTION_MESSAGE =
  "This promo code cannot be used at this lodge.";

type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

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
interface PromoDiscountGuestWithNights extends PromoDiscountGuest {
  firstNight?: Date | null;
  // Actual dates of each entry in perNightRates (issue #713), parallel to that
  // array. Used to restrict an internal work-party promo to its night window
  // correctly when the guest stays non-contiguous nights. Falls back to
  // positional dates from firstNight when omitted.
  nightDates?: Date[] | null;
}

export interface BookingDetailsForPromo {
  totalPriceCents: number;
  memberId: string;
  guests: PromoDiscountGuestWithNights[];
  bookingCheckIn?: Date;
}

export interface PromoApplicationSubject extends PromoRuleSubject {
  type: PromoCodeType;
  // Optional per-lodge restriction (see PromoRuleSubject.lodges).
  lodges?: { lodgeId: string }[];
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

/**
 * Who a promotion still covers on a booking, and who it no longer reaches
 * (#2390). Present on a reprice result ONLY when the promotion's usage caps
 * forced somebody out; `undefined` means everybody the code applies to is
 * covered, which keeps "was anyone left out?" a single truthy check.
 *
 * All three lists are member ids in the order the promotion applies to people —
 * most expensive stay first, except that members already holding the discount
 * come first of all (see `selectPromoDiscountGuests`). One consistent order, so
 * the sentence a member reads never reshuffles between surfaces.
 */
export interface PromoCapCoverage {
  coveredMemberIds: string[];
  /**
   * The subset of `coveredMemberIds` who were already benefiting on this
   * booking before the edit — the people the sentence may truthfully describe
   * as having already had the discount. Anyone covered but not listed here was
   * admitted by this edit.
   */
  retainedMemberIds: string[];
  excludedMemberIds: string[];
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
  capCoverage?: PromoCapCoverage;
}

/**
 * THE ONLY WAY A STORED CALENDAR DAY BECOMES A COMPARISON KEY HERE (#3123).
 *
 * Every promo date this file compares is a `@db.Date` column — `validFrom`,
 * `validUntil`, `bookingStartFrom`, `bookingStartUntil`
 * (`prisma/schema.prisma:2955-2958`) and the booking's own `checkIn` (`:1662`).
 * All of them are calendar days encoded as UTC midnight, and a calendar day
 * takes no zone at all (`INV-DATE-019`'s first exact boundary, with
 * `INV-DATE-026`).
 *
 * WHY THIS FUNCTION IS THE RULE RATHER THAN A CONVENIENCE. Until #3123 the
 * booking-date window read one side of its own comparison through this
 * zone-free helper and the OTHER side — the check-in — through a helper that
 * projected it into `APP_TIME_ZONE`. Two frames in one comparison, so for any
 * club behind Greenwich the check-in key was a day early: a booking starting on
 * the promotion's first valid day was refused, and one starting on the excluded
 * upper bound was allowed. Both sides now come from here, which is what makes
 * that class of drift unrepresentable rather than merely fixed.
 */
function storedPromoDateKey(value: Date): string;
function storedPromoDateKey(value: Date | null | undefined): string | null;
function storedPromoDateKey(value: Date | null | undefined): string | null {
  return value ? formatDateOnly(value) : null;
}

/**
 * The club's calendar day right now, as the same `yyyy-MM-dd` key
 * {@link storedPromoDateKey} produces — for the ONE comparison here whose left
 * side is a real instant rather than a stored day.
 *
 * A validity window (`validFrom` / `validUntil`) asks "is the promotion live
 * today", and "today" has no answer until a zone is chosen. `INV-CONFIG-002`
 * says which one: the club's PERSISTED `ClubTimeSettings.timeZone`, never the
 * container's. `nzDateKey` used to answer it from `APP_TIME_ZONE`, which is the
 * container's claim and is what #3123 exists to retire.
 *
 * The zone arrives as a parameter rather than being read here because this
 * module is reached by a `tsx` CLI (`booking-create.ts` from the second-lodge
 * seed) and by `src/instrumentation.node.ts` (`draft-booking-cleanup.ts`), so
 * `@/lib/club-time/server` cannot be imported into it; and because the caller
 * must resolve the zone OUTSIDE any transaction it holds. See
 * `getAssignedPromoCodeSummariesForMember`.
 */
function clubDateKey(value: Date, zone: ClubTimeZone) {
  return clubCalendarDateOf(value, zone);
}

/**
 * Build the allocation rows to persist for a redemption.
 *
 * An allocation row means "this member benefited", which is what every usage
 * cap counts (#2299). Non-beneficial entries are dropped here — the single
 * write-time choke point both `redeemPromoCode` and
 * `replacePromoRedemptionAllocations` go through — so a zero-benefit
 * application can never occupy a per-member, total-redemptions or
 * unique-members slot. The `PromoRedemption` row itself is still written by the
 * caller; it remains the audit and reporting trail.
 */
function normalizeAllocations(
  allocations: PromoDiscountAllocation[] | undefined,
  fallbackMemberId: string,
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed: number
): PromoBeneficiaryAllocation[] {
  const suppliedAllocations = allocations ?? [];

  if (suppliedAllocations.length > 0) {
    // Pricing can emit a deliberately zero entry (a SET_PRICE fixed-nightly
    // guest whose rate already equals the fixed price), so filter here too.
    return suppliedAllocations
      .map((allocation) => ({
        memberId: allocation.memberId,
        discountCents: allocation.discountCents,
        priceAdjustmentCents: allocation.priceAdjustmentCents,
        freeNightsUsed: allocation.freeNightsUsed,
      }))
      .filter(isBeneficialPromoAllocation);
  }

  const fallback = {
    memberId: fallbackMemberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed,
  };
  return isBeneficialPromoAllocation(fallback) ? [fallback] : [];
}

// test seam
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

  // Unassigned promos attribute the whole benefit to the booker. Before #2299
  // this fallback row was FORCED whenever any guest was eligible, so a promo
  // that produced no discount at all still manufactured an allocation row and
  // burned the member's single permitted use — a percentage or fixed-amount
  // code over nights that were already free (20% of $0 is $0, and there is
  // nothing to take a fixed amount off), or a SET_PRICE fixed-nightly code
  // whose price already equals what the guest pays. It is now written only when
  // there is something to attribute.
  //
  // A CAP_ONLY fixed-nightly code that never bites is NOT one of these cases:
  // pricing counts no eligible guest for it at all, so it produced neither an
  // allocation nor a redemption row before this change either.
  return {
    ...result,
    allocations: normalizeAllocations(
      [],
      bookingMemberId,
      result.discountCents,
      result.priceAdjustmentCents,
      result.freeNightsUsed
    ),
  };
}

/**
 * Whether to write a `PromoRedemption` row for this application.
 *
 * Deliberately WIDER than the benefit test — `isBeneficialPromoAllocation` in
 * `@/lib/promo-usage-counts`, which said "above" until #3128 moved it there,
 * and whose own docblock carries the narrower rule this one is contrasted
 * with: a promo that had eligible
 * guests but delivered nothing still records its redemption, because that row
 * is the audit and reporting trail an operator needs to see that a code is
 * misconfigured (#2299, owner decision 3). What changed is that such a
 * redemption now carries no allocation rows, so it counts toward no cap.
 */
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

/**
 * Decide who a promotion covers when a booking edit would push it past a usage
 * cap (#2390, owner decision 31 Jul 2026).
 *
 * The rule, in one sentence: **the edit always succeeds, everyone already
 * benefiting keeps their discount, and newly-added people are simply priced
 * normally.** A member changing their dates is never blocked by somebody else's
 * consumption of a promotion, and nothing they were already promised is taken
 * back.
 *
 * Three deliberate choices live here.
 *
 * 1. **Pre-existing beneficiaries are kept even when they alone exceed a cap.**
 *    That happens through legacy data, or through an admin lowering a cap after
 *    bookings were made. Honouring the promise is the whole point of the
 *    decision, so the alternative — quietly billing a member for a discount the
 *    club already gave them — is rejected outright. The consequence is that a
 *    lowered cap can read as over-subscribed until those bookings pass; that is
 *    visible to an admin on the promo card, which is the right place for it. The
 *    overage can only ever shrink: no NEW person is admitted while over cap,
 *    because the loop below counts the protected members against the allowance
 *    before it considers a single candidate.
 * 2. **Protected members are counted first**, so a newcomer can never take the
 *    slot of somebody who already holds it just by appearing earlier in the
 *    list.
 * 3. **Everyone else is admitted in the order the promotion applies to them** —
 *    the order `selectPromoDiscountGuests` produced, which is the most expensive
 *    stay first. That spends a scarce allowance where it is worth the most, and
 *    it depends only on the guests' own rates: nothing here turns on a query
 *    plan or a hash order.
 *
 * Pure and exported so both the arithmetic and each guard can be tested and
 * mutated without a database.
 */
export function trimPromoBeneficiariesToCaps(input: {
  /** Beneficiaries the recalculated booking would have, in the order above. */
  beneficiaryMemberIds: string[];
  /** Members already benefiting on THIS booking. Never excluded. */
  protectedMemberIds: ReadonlySet<string>;
  /**
   * Members who have personally used up this promotion — their per-member
   * redemption cap, or their lifetime free-nights budget. Passed in rather than
   * recomputed here because `validateAndCalculatePromoDiscount` already decides
   * it (both caps, one predicate), and a second expression of the same rule
   * would be one more thing to keep in step. Protection still wins: an admin
   * lowering a cap does not reach back into a discount already given.
   */
  exhaustedMemberIds: ReadonlySet<string>;
  /** Members who already benefit from this code on some OTHER booking. */
  existingUniqueBeneficiaryMemberIds: ReadonlySet<string>;
  /** Allocation rows held by every booking except this one. */
  redemptionsHeldElsewhere: number;
  maxRedemptionsTotal: number | null | undefined;
  /** Distinct benefiting members across every booking except this one. */
  uniqueMembersUsed: number;
  maxUniqueMembersTotal: number | null | undefined;
}): PromoCapCoverage {
  const {
    beneficiaryMemberIds,
    protectedMemberIds,
    exhaustedMemberIds,
    existingUniqueBeneficiaryMemberIds,
    redemptionsHeldElsewhere,
    maxRedemptionsTotal,
    uniqueMembersUsed,
    maxUniqueMembersTotal,
  } = input;

  const covered = new Set<string>();
  const excluded = new Set<string>();
  let slotsTaken = 0;
  let newUniqueTaken = 0;

  const admit = (memberId: string) => {
    covered.add(memberId);
    slotsTaken += 1;
    if (!existingUniqueBeneficiaryMemberIds.has(memberId)) {
      newUniqueTaken += 1;
    }
  };

  // Choice 2: the people who already hold the discount are counted first, and
  // unconditionally (choice 1).
  for (const memberId of beneficiaryMemberIds) {
    if (protectedMemberIds.has(memberId) && !covered.has(memberId)) {
      admit(memberId);
    }
  }

  // Choice 3: everyone else, in the order the promotion applies to them.
  for (const memberId of beneficiaryMemberIds) {
    if (covered.has(memberId) || excluded.has(memberId)) continue;

    if (exhaustedMemberIds.has(memberId)) {
      excluded.add(memberId);
      continue;
    }
    if (
      maxRedemptionsTotal !== null &&
      maxRedemptionsTotal !== undefined &&
      redemptionsHeldElsewhere + slotsTaken + 1 > maxRedemptionsTotal
    ) {
      excluded.add(memberId);
      continue;
    }
    if (
      maxUniqueMembersTotal !== null &&
      maxUniqueMembersTotal !== undefined &&
      !existingUniqueBeneficiaryMemberIds.has(memberId) &&
      uniqueMembersUsed + newUniqueTaken + 1 > maxUniqueMembersTotal
    ) {
      excluded.add(memberId);
      continue;
    }
    admit(memberId);
  }

  // Emitted in the input's own order, so the sentence a member reads names
  // people in one consistent order rather than in the order the two passes above
  // happened to admit them.
  return {
    coveredMemberIds: beneficiaryMemberIds.filter((memberId) => covered.has(memberId)),
    // Who among the covered already had the discount before this edit. The
    // member-facing sentence needs the two groups apart: telling somebody the
    // code "stays with Ann and Bob, who already had it" when Bob was added in
    // this very edit is simply untrue.
    retainedMemberIds: beneficiaryMemberIds.filter(
      (memberId) => covered.has(memberId) && protectedMemberIds.has(memberId)
    ),
    excludedMemberIds: beneficiaryMemberIds.filter((memberId) => excluded.has(memberId)),
  };
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
  /**
   * Resolved ONCE, here, and threaded into every row below (#3123). This is the
   * boundary: the reader is asynchronous, this function is, and the status
   * helper it feeds is not. Doing it per row would ask the same question of the
   * database once per assignment and could answer differently across club
   * midnight, so one member's list would report two different todays.
   *
   * `readClubTimeZoneOutsideRequest` rather than `clubTime()` because this
   * module is reached by a `tsx` CLI and by `src/instrumentation.node.ts`, and
   * `@/lib/club-time/server` is a bare throw outside the `react-server`
   * condition. This call is outside every transaction — nothing here opens one.
   */
  const clubZone = await readClubTimeZoneOutsideRequest();
  const assignments = await prisma.promoCodeAssignment.findMany({
    where: { memberId, promoCode: { internal: false } },
    include: {
      promoCode: {
        include: {
          // Beneficial allocations only (#2299): this list drives both the
          // uses-per-member count and the member-facing "Already used by
          // member" status, and neither may be tripped by an application that
          // gave the member nothing. The lifetime free-nights sum below is
          // unaffected by the filter — every excluded row carries
          // freeNightsUsed = 0 by definition.
          allocations: {
            where: { memberId, ...BENEFICIAL_PROMO_ALLOCATION_FILTER },
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
    const statusReason = getAssignedPromoCodeStatusReason(
      promoCode,
      freeNightsUsed,
      now,
      clubZone
    );

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
      // Beneficial uses by this member (#2299), matching what the
      // uses-per-member cap actually enforces.
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
  now: Date,
  /**
   * The club's persisted timezone, resolved ONCE by the async caller and
   * threaded in (#3123). Required rather than defaulted: this function is
   * synchronous and cannot read the setting, and a default would put the
   * container's zone back in the one place this parameter exists to remove it
   * from.
   */
  clubZone: ClubTimeZone
) {
  if (!promoCode.active) return "Inactive";
  if (promoCode.archivedAt) return "Archived";
  const currentDateKey = clubDateKey(now, clubZone);
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
  // Optional per-lodge restriction (multi-lodge phase 6, ADR-001 resolved
  // question 4). No rows = redeemable at every lodge; rows present = only
  // the listed lodges. Omitted entirely by callers that never restrict.
  lodges?: { lodgeId: string }[];
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
  /**
   * Allocation rows the booking being re-validated ALREADY holds against this
   * code, to be discounted from `promoCode.currentRedemptions` before the
   * total-redemptions cap is applied (#2299).
   *
   * `currentRedemptions` is the denormalised count of every allocation row for
   * the code, including the rows the excluded booking holds right now. Every
   * other cap honours `excludeBookingId` by filtering the allocation table;
   * this counter cannot be filtered, so the caller measures the excluded
   * booking's own rows and passes them here instead. Without it a booking
   * holding the code's last slot fails its OWN reprice ("maximum number of
   * uses"), loses its discount, and the member is billed the discount back for
   * a date shift.
   *
   * Counted RAW (no benefit filter) on purpose, so it is measured in exactly
   * the units `currentRedemptions` is kept in.
   */
  excludedBookingRedemptionCount?: number;
  // True for assigned-member promos where every linked member guest is at
  // their per-member cap (redemptions or lifetime free nights). Signals that
  // no beneficiary survives the upstream filter.
  allBeneficiariesExhausted?: boolean;
  /**
   * #2390 — the beneficiary set handed to this validator has already been
   * trimmed to what the caps allow by `trimPromoBeneficiariesToCaps`, and
   * people who were already benefiting on this booking were deliberately kept
   * even where they exceed a cap.
   *
   * So the four "the code is full, refuse the whole thing" rejections below
   * must not run. Left in, they would either re-reject a set the trim has
   * already made fit, or — the case that actually costs a member money — strip
   * the discount from somebody who already had it because an admin lowered the
   * cap afterwards. Refusing is exactly what the owner decision rules out: the
   * edit always succeeds and only NEW people are left out.
   *
   * Set ONLY by the reprice paths (`capOverflow: "coverExisting"`). Booking
   * creation and applying a new code still refuse, because there nobody is
   * being taken anything away from.
   */
  capsResolvedByBeneficiaryTrim?: boolean;
}

// test seam
/**
 * Validate promo code rules (pure logic, separated for testing).
 * Returns error message string if invalid, null if valid.
 *
 * ## `todayAtClub` is REQUIRED, and that is what closed the last
 * environment-zone read in this file (#3123)
 *
 * This function is SYNCHRONOUS, PURE and TRANSACTION-BOUND, which is the whole
 * problem: it cannot resolve the club's timezone itself, and its async boundary
 * `validateAndCalculatePromoDiscount` is called from inside an open interactive
 * transaction by four of its callers — `booking-create-promo.ts`,
 * `booking-date-modification-service.ts`, `booking-guest-removal-service.ts`
 * and `api/bookings/[id]/guests/route.ts`. `INV-LOCK-004` names the club
 * timezone as one of only two reads that cannot take a transaction client, so a
 * read down here would have taken a second pooled connection under
 * `pg_advisory_xact_lock(1)` and the per-lodge capacity key AND escaped the
 * transaction's own client — the four-way mistake
 * `diagnostics/tools/packs/booking-evidence.ts` records, and the reason
 * `booking-create.ts` says in as many words "Read outside every transaction."
 *
 * So the day is resolved by whichever caller owns the transaction, before it
 * opens it, and threaded in. It used to be `now: Date = new Date()`, projected
 * through `APP_TIME_ZONE`, so a promotion's start and end were judged in the
 * CONTAINER's day rather than the club's (`INV-CONFIG-002`) — wrong by up to one
 * day at each edge of the validity window for any deployment whose configured
 * zone differs from its container's, on a comparison that decides whether a
 * member gets a discount.
 *
 * It is a `CalendarDate` rather than an instant because a validity window asks
 * "is the promotion live today" and an instant has no calendar day until a zone
 * is chosen. Taking a `Date` is what forced the choice down here in the first
 * place; the type now makes that unrepresentable, and puts BOTH sides of every
 * comparison below on a zone-free calendar day.
 */
export function validatePromoCodeRules(
  promoCode: PromoRuleSubject | null,
  bookingDetails: { memberId: string; bookingCheckIn?: Date },
  todayAtClub: CalendarDate,
  counts: PromoRuleCounts = {},
  assignedMemberIds: string[] | null = null,
  lodgeId: string | null = null
): string | null {
  if (!promoCode) {
    return "Promo code not found";
  }

  if (!promoCode.active) {
    return "This promo code is no longer active";
  }

  if (
    promoCode.lodges &&
    promoCode.lodges.length > 0 &&
    (!lodgeId || !promoCode.lodges.some((row) => row.lodgeId === lodgeId))
  ) {
    return PROMO_LODGE_RESTRICTION_MESSAGE;
  }

  // BOTH SIDES OF THIS COMPARISON ARE ZONE-FREE CALENDAR DAYS (#3123).
  // `validFrom` / `validUntil` are `@db.Date` columns
  // (`prisma/schema.prisma:2955-2956`) read through `storedPromoDateKey`, and
  // `todayAtClub` is the club's own day, already resolved by the caller. Until
  // #3123 this side was `formatDateOnlyForTimeZone(now)` — the container's
  // projection of an instant — which is a second frame in a one-frame
  // comparison.
  const currentDateKey: string = todayAtClub;
  const validFromKey = storedPromoDateKey(promoCode.validFrom);
  const validUntilKey = storedPromoDateKey(promoCode.validUntil);
  if (validFromKey && currentDateKey < validFromKey) {
    return "This promo code is not yet valid";
  }

  if (validUntilKey && currentDateKey > validUntilKey) {
    return "This promo code has expired";
  }

  if (bookingDetails.bookingCheckIn) {
    // BOTH SIDES OF THIS COMPARISON COME FROM ONE HELPER, and until #3123 they
    // did not. `Booking.checkIn` is `@db.Date` (`prisma/schema.prisma:1662`), as
    // are the two window columns, so all three are calendar days and none of
    // them takes a zone. Projecting the check-in through `APP_TIME_ZONE` made
    // the key a day early for every club behind Greenwich, which refused a
    // booking on the promotion's first valid day and admitted one on the
    // excluded upper bound.
    const checkInKey = storedPromoDateKey(bookingDetails.bookingCheckIn);
    const bookingStartFromKey = storedPromoDateKey(promoCode.bookingStartFrom);
    const bookingStartUntilKey = storedPromoDateKey(promoCode.bookingStartUntil);
    if (bookingStartFromKey && checkInKey < bookingStartFromKey) {
      return "This promo code is not valid for your booking dates";
    }
    if (bookingStartUntilKey && checkInKey >= bookingStartUntilKey) {
      return "This promo code is not valid for your booking dates";
    }
  }

  if (promoCode.maxRedemptionsTotal !== null && !counts.capsResolvedByBeneficiaryTrim) {
    // Slots held by OTHER bookings. The excluded booking's own rows are about
    // to be replaced by this very application, so counting them would make a
    // booking fail its own reprice (#2299). Floored at zero so a counter that
    // has drifted low can never turn into a negative allowance.
    const redemptionsHeldElsewhere = Math.max(
      0,
      promoCode.currentRedemptions - (counts.excludedBookingRedemptionCount ?? 0)
    );
    if (
      redemptionsHeldElsewhere + (counts.requestedRedemptionCount ?? 1) >
      promoCode.maxRedemptionsTotal
    ) {
      return "This promo code has reached its maximum number of uses";
    }
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
    !counts.capsResolvedByBeneficiaryTrim &&
    counts.requestedNewUniqueMemberCount !== undefined &&
    (counts.uniqueMembersUsed ?? 0) + counts.requestedNewUniqueMemberCount >
      promoCode.maxUniqueMembersTotal
  ) {
    return "This promo code has reached its maximum number of unique members";
  }

  if (
    promoCode.maxUniqueMembersTotal !== null &&
    promoCode.maxUniqueMembersTotal !== undefined &&
    !counts.capsResolvedByBeneficiaryTrim &&
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
    !counts.capsResolvedByBeneficiaryTrim &&
    !counts.memberRedemptionCounts &&
    (counts.memberRedemptionCount ?? 0) >= promoCode.maxUsesPerMember
  ) {
    return promoCode.maxUsesPerMember === 1
      ? "You have already used this promo code"
      : "You have reached the maximum uses of this promo code";
  }

  // The lifetime free-nights cap is a per-night BUDGET, not a count of
  // beneficiaries, so the trim above cannot resolve it by leaving somebody out.
  // Under a reprice it is suppressed all the same (#2390): refusing here strips
  // the code from the whole booking, and the budget arithmetic downstream
  // already awards only the nights that remain — which for a member with none
  // left is zero, so the application simply carries no benefit and consumes no
  // slot (#2299), keeping the redemption's audit row instead of deleting it.
  if (
    promoCode.type === "FREE_NIGHTS" &&
    promoCode.lifetimeFreeNightsCap &&
    !counts.capsResolvedByBeneficiaryTrim &&
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

/**
 * `options` is REQUIRED because `options.todayAtClub` is (#3123).
 *
 * Four of this function's callers invoke it with `{ db: tx }` from inside an
 * open interactive transaction, so the club's day cannot be resolved here or
 * below — `INV-LOCK-004`, and the full reasoning is on
 * {@link validatePromoCodeRules}. Making the whole options object required is
 * what makes the typechecker enumerate every call site rather than letting one
 * silently keep the container's answer.
 */
export async function validateAndCalculatePromoDiscount(
  promoCode: PromoApplicationSubject | null,
  bookingDetails: BookingDetailsForPromo,
  assignedMemberIds: string[] | null = null,
  options: {
    excludeBookingId?: string;
    db?: PromoUsageClient;
    /**
     * The club's own calendar day (`INV-CONFIG-002`), resolved by this caller
     * BEFORE it opened any transaction. Feeds the promotion's validity window
     * in {@link validatePromoCodeRules}.
     */
    todayAtClub: CalendarDate;
    selectedGuestIndexes?: number[];
    // The booking's/quote's lodge. Required to enforce an optional per-lodge
    // promo restriction (PromoCodeLodge junction, ADR-001 resolved question
    // 4); omitted only by callers that cannot yet resolve a lodge (fail-open
    // to unrestricted, matching "no rows = every lodge").
    lodgeId?: string | null;
    /**
     * What to do when the recalculated booking would push the promotion past a
     * usage cap (#2390).
     *
     * - `"reject"` (default) refuses the whole application. Right for booking
     *   creation and for applying a code the member has just typed: nobody is
     *   holding a discount yet, so "sorry, this code is full" is the honest
     *   answer and the member can choose something else.
     * - `"coverExisting"` is the reprice answer, and requires
     *   `excludeBookingId`. The edit is never refused: everyone already
     *   benefiting on that booking keeps their discount, and only the
     *   newly-added people are left out and priced normally. The result then
     *   carries `capCoverage` so the caller can say who is covered and who is
     *   not, at the moment of the edit.
     */
    capOverflow?: "reject" | "coverExisting";
  }
): Promise<PromoApplicationResult> {
  if (!promoCode) {
    return {
      error: "Promo code not found",
      beneficiaryMemberIds: [],
    };
  }

  // Optional per-lodge restriction (PromoCodeLodge junction, ADR-001 resolved
  // question 4): no rows means redeemable at every lodge; rows present
  // restrict redemption to the listed lodges. Checked up front, before any
  // usage lookups, so a lodge-restricted code fails fast.
  if (
    promoCode.lodges &&
    promoCode.lodges.length > 0 &&
    (!options.lodgeId || !promoCode.lodges.some((row) => row.lodgeId === options.lodgeId))
  ) {
    return {
      error: PROMO_LODGE_RESTRICTION_MESSAGE,
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
              nightWindow,
              guest.nightDates
            )
          : [],
      }));
    }
  }

  const requiresGuestSelection = assignmentRequiresGuestSelection(promoCode, assignedMemberIds);
  const requiresAssignedBooker = assignmentRequiresAssignedBooker(promoCode, assignedMemberIds);
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
  // #2390. On a reprice the cap question stops being "may this booking use the
  // code?" and becomes "who does it still cover?". `excludeBookingId` is what
  // makes "this booking" answerable, so without it we stay on the refusing
  // path rather than guess.
  const trimBeneficiariesToCaps =
    options.capOverflow === "coverExisting" && Boolean(options.excludeBookingId);
  // Read BEFORE the beneficiary list is built, not after. `maxGuestsPerBooking`
  // is applied while that list is built, so a protected member the guest cap
  // cut would be invisible to every later protection check — the edit would
  // then see them as "no longer a beneficiary" and bill back a discount they
  // already held (#2390).
  const bookingBeneficiaryFreeNights = trimBeneficiariesToCaps
    ? await getBookingBeneficiaryFreeNights(promoCode.id, options.excludeBookingId!, db)
    : new Map<string, number>();
  const protectedMemberIds: ReadonlySet<string> = new Set(
    bookingBeneficiaryFreeNights.keys()
  );

  const promoPricingInput: PromoCodeInput = {
    type: promoCode.type,
    valueCents: promoCode.valueCents,
    percentOff: promoCode.percentOff,
    freeNightsPerIndividual: promoCode.freeNightsPerIndividual,
    fixedNightlyPriceCents: promoCode.fixedNightlyPriceCents,
    fixedNightlyMode: promoCode.fixedNightlyMode,
    maxGuestsPerBooking: promoCode.maxGuestsPerBooking,
    maxNightlyValueCents: promoCode.maxNightlyValueCents,
    memberGuestsOnly: promoCode.memberGuestsOnly,
  };
  const initialBeneficiaryMemberIds = getPromoBeneficiaryMemberIds(
    promoPricingInput,
    bookingDetails.memberId,
    guestsForPromo,
    assignedGuestScopeMemberIds,
    protectedMemberIds
  );

  // Who the `maxGuestsPerBooking` cut would have covered had nobody been
  // protected — i.e. the people a protected member kept their slot ahead of.
  // They are priced normally, so they belong in the sentence the member reads;
  // without this they would be left out AND unmentioned, which is the "found
  // out later" outcome the owner decision rules out. Empty unless protection
  // actually displaced somebody, so an unchanged booking gains no new notice.
  const guestCapDisplacedMemberIds =
    trimBeneficiariesToCaps &&
    protectedMemberIds.size > 0 &&
    promoCode.maxGuestsPerBooking !== null &&
    promoCode.maxGuestsPerBooking !== undefined
      ? getPromoBeneficiaryMemberIds(
          promoPricingInput,
          bookingDetails.memberId,
          guestsForPromo,
          assignedGuestScopeMemberIds
        ).filter((memberId) => !initialBeneficiaryMemberIds.includes(memberId))
      : [];

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

  const exhaustedMemberIds: ReadonlySet<string> = new Set(
    assignedScoped ? initialBeneficiaryMemberIds.filter(isMemberExhausted) : []
  );

  // On a reprice, an exhausted member is NOT dropped here (#2390). Dropping
  // them silently is what let a newly-added guest who had used the code up be
  // priced at the normal rate with nobody told why: gone before the trim ran,
  // they never reached the excluded list, so the sentence the member reads
  // never mentioned them. The trim below leaves them out AND names them.
  // Protection wins there as it does here: an admin lowering a cap afterwards
  // must not reach back and take away a discount the club already gave.
  const beneficiaryMemberIds =
    assignedScoped && initialBeneficiaryMemberIds.length > 0 && !trimBeneficiariesToCaps
      ? initialBeneficiaryMemberIds.filter((id) => !exhaustedMemberIds.has(id))
      : initialBeneficiaryMemberIds;

  const allBeneficiariesExhausted =
    assignedScoped &&
    initialBeneficiaryMemberIds.length > 0 &&
    beneficiaryMemberIds.length === 0;

  // Slots the booking being repriced already holds against this code, so the
  // total-redemptions cap can discount them (#2299). Only fetched when that cap
  // is actually set, so no path that cannot be affected pays for a query.
  let excludedBookingRedemptionCount = 0;
  if (
    options.excludeBookingId &&
    promoCode.maxRedemptionsTotal !== null &&
    promoCode.maxRedemptionsTotal !== undefined
  ) {
    excludedBookingRedemptionCount = await db.promoRedemptionAllocation.count({
      where: { promoCodeId: promoCode.id, bookingId: options.excludeBookingId },
    });
  }

  let uniqueMembersUsed = 0;
  let requestedNewUniqueMemberCount: number | undefined;
  let existingBeneficiaries: Set<string> = new Set();
  if (promoCode.maxUniqueMembersTotal !== null && promoCode.maxUniqueMembersTotal !== undefined) {
    uniqueMembersUsed = await getUniqueMemberRedemptionCount(
      promoCode.id,
      options.excludeBookingId,
      db
    );
    existingBeneficiaries = await getExistingBeneficiaryMemberIds(
      promoCode.id,
      beneficiaryMemberIds,
      options.excludeBookingId,
      db
    );
    requestedNewUniqueMemberCount = beneficiaryMemberIds.filter(
      (memberId) => !existingBeneficiaries.has(memberId)
    ).length;
  }

  // #2390 — on a reprice, decide WHO the code still covers instead of refusing
  // the edit. Runs after every cap input above has been read (all of them
  // inside this transaction, off the row-locked promo), so the numbers it
  // divides up are the same numbers the write below consumes.
  let coveredBeneficiaryMemberIds = beneficiaryMemberIds;
  let capCoverage: PromoCapCoverage | undefined;
  if (trimBeneficiariesToCaps && beneficiaryMemberIds.length > 0) {
    const trimmed = trimPromoBeneficiariesToCaps({
      beneficiaryMemberIds,
      protectedMemberIds,
      exhaustedMemberIds,
      existingUniqueBeneficiaryMemberIds: existingBeneficiaries,
      // Counted RAW against `currentRedemptions`, which is itself a raw row
      // count, so the two are in the same units (#2299). A legacy all-zero row
      // this booking holds is therefore subtracted here while buying nobody
      // protection above — correct, because this very reprice deletes it: the
      // slot it occupied is genuinely released in the same transaction.
      redemptionsHeldElsewhere: Math.max(
        0,
        promoCode.currentRedemptions - excludedBookingRedemptionCount
      ),
      maxRedemptionsTotal: promoCode.maxRedemptionsTotal,
      uniqueMembersUsed,
      maxUniqueMembersTotal: promoCode.maxUniqueMembersTotal,
    });
    const coverage: PromoCapCoverage = {
      ...trimmed,
      excludedMemberIds: [...trimmed.excludedMemberIds, ...guestCapDisplacedMemberIds],
    };

    if (coverage.coveredMemberIds.length === 0) {
      // Nobody on the booking can be covered. That can only happen when the
      // booking had no beneficiaries left to protect — anyone already
      // benefiting is kept unconditionally — so this takes nothing away from
      // anyone who is still on the booking, and the caller drops the code as
      // it always has. Guarded explicitly because an empty beneficiary list
      // reads as "unassigned promo" downstream, which would price the code for
      // every guest.
      return {
        error: coverage.excludedMemberIds.every((id) => exhaustedMemberIds.has(id))
          ? "All linked member guests have used this promo code"
          : "This promo code has reached its maximum number of uses",
        beneficiaryMemberIds: initialBeneficiaryMemberIds,
      };
    }

    coveredBeneficiaryMemberIds = coverage.coveredMemberIds;
    if (coverage.excludedMemberIds.length > 0) {
      capCoverage = coverage;
    }
    if (requestedNewUniqueMemberCount !== undefined) {
      requestedNewUniqueMemberCount = coveredBeneficiaryMemberIds.filter(
        (memberId) => !existingBeneficiaries.has(memberId)
      ).length;
    }
  }

  // For assigned-member promos the booker is just another linked member guest
  // and per-member caps are enforced by the upstream filter, so we suppress
  // the booker-scoped fallback checks in the validator.
  const validationError = validatePromoCodeRules(
    promoCode,
    bookingDetails,
    options.todayAtClub,
    {
      memberRedemptionCount: assignedScoped ? undefined : bookerUsage.redemptionCount,
      memberFreeNightsUsed: assignedScoped ? undefined : bookerUsage.freeNightsUsed,
      uniqueMembersUsed,
      memberHasRedeemedBefore: bookerUsage.redemptionCount > 0,
      requestedRedemptionCount: coveredBeneficiaryMemberIds.length,
      requestedNewUniqueMemberCount,
      excludedBookingRedemptionCount,
      allBeneficiariesExhausted,
      capsResolvedByBeneficiaryTrim: trimBeneficiariesToCaps,
    },
    requiresAssignedBooker ? assignedMemberIds : null,
    options.lodgeId ?? null
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
          coveredBeneficiaryMemberIds.map((memberId) => [
            memberId,
            Math.max(
              0,
              promoCode.lifetimeFreeNightsCap! -
                (beneficiaryUsage[memberId]?.freeNightsUsed ?? 0),
              // #2390: the lifetime cap is a BUDGET, not a slot, so keeping a
              // protected member in the beneficiary list is not enough — an
              // admin who lowered the cap under them would leave the budget at
              // zero and the member would silently lose free nights this
              // booking had already given them, with no notice anywhere because
              // they were "covered". Floored at what this booking's own
              // allocation rows already granted, which is what "everyone
              // already benefiting keeps their discount" means for a budget.
              // It can only hold them level: the floor is what they already
              // had, never more, and it is 0 for anyone not already benefiting
              // here.
              bookingBeneficiaryFreeNights.get(memberId) ?? 0
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
  // discount candidates, and (#2390) to those the caps still cover, so a guest
  // the code no longer reaches is priced at the normal rate. This is the single
  // point where "who is covered" becomes "what is charged", which is why the
  // notice, the invoice, the email and the booking summary cannot disagree:
  // they all read the one price this produces.
  const effectiveGuestScopeMemberIds = assignedScoped
    ? coveredBeneficiaryMemberIds
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

  // `selectedGuestIndexes` is returned UNTRIMMED on purpose (#2390). It is the
  // booker's chosen beneficiaries, which is what the stored guest-target rows
  // mean; who actually benefited is the allocation rows, which the trim above
  // does govern. Keeping the two separate means a slot freed by another booking
  // restores the guest at the next reprice, instead of the choice being quietly
  // rewritten by a cap that has since moved. (In practice a guest-targeted code
  // scopes its cap to the booker, so this branch and the trim rarely meet.)
  return {
    discount,
    beneficiaryMemberIds: coveredBeneficiaryMemberIds,
    remainingFreeNights,
    remainingFreeNightsByMemberId,
    selectedGuestIndexes: requiresGuestSelection ? selectedGuestIndexes.indexes : undefined,
    capCoverage,
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
  /**
   * The club's own calendar day (#3123), resolved by the caller.
   *
   * THIRD AND REQUIRED, ahead of the two optional positionals it now precedes,
   * so the typechecker enumerates every call site instead of letting one keep
   * the container's day. That is the shape #2870 used for
   * `enqueueHostingCoverageReevaluationForMember`'s `today`, and the reasoning
   * is on {@link validatePromoCodeRules}.
   */
  todayAtClub: CalendarDate,
  excludeBookingId?: string,
  lodgeId?: string | null,
  // #2266: guest-targeted codes (assigned + not-own-nights-only) need the
  // caller's chosen beneficiary indexes, exactly as /api/promo-codes/validate
  // and the create/modify apply paths pass them. Optional so every existing
  // caller keeps its behaviour byte-for-byte.
  options?: { selectedGuestIndexes?: number[] }
): Promise<PromoValidationResult> {
  const normalizedCode = code.toUpperCase().trim();

  const promoCode = await prisma.promoCode.findUnique({
    where: { code: normalizedCode },
    include: {
      assignments: { select: { memberId: true } },
      lodges: { select: { lodgeId: true } },
    },
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
    {
      excludeBookingId,
      lodgeId,
      selectedGuestIndexes: options?.selectedGuestIndexes,
      todayAtClub,
    }
  );

  if (application.error || !application.discount) {
    // A guest-targeted code that needed a selection reports its plain error
    // text; guest selection itself lives with /api/promo-codes/validate and
    // PromoCodeInput, not with this validator's callers (#2266, INFO-9).
    return {
      valid: false,
      error: application.error ?? "Promo code could not be applied",
    };
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
 * Take a `FOR UPDATE` row lock on every promo code this transaction is about to
 * charge or refund a use against, BEFORE any cap is read and before any
 * `currentRedemptions` write.
 *
 * Without it a cap check and the redemption that consumes it are two separate
 * statements, so two concurrent modifications of different bookings can both
 * read "one use left" and both take it. Booking creation has taken a `FOR
 * UPDATE` lock on its promo row since the per-individual redesign
 * (`booking-create-promo.ts`, docs/CONCURRENCY_AND_LOCKING.md → "Narrow row-
 * and table-lock protocols"), and since #2289 it takes it the same way this
 * helper does — `$executeRaw` over a constant — so it has property 2 below too.
 * It used to `SELECT *` and read the raw row, and that unchecked cast is what
 * silently disabled a redemption cap and a FREE_NIGHTS discount. The two are
 * still not interchangeable: booking creation keys on the promo `code` (and so
 * must also check the affected-row count — see the zero-match note there),
 * while this helper is the id-keyed, lock-only form used by the four
 * modification paths, which matters more now that a reprice can RELEASE a slot
 * as well as take one.
 *
 * Every path that may write `currentRedemptions` for an existing booking takes
 * it: the batch modification path (`booking-modify-plan.ts`), adding guests
 * (`/api/bookings/[id]/guests`), a date change
 * (`booking-date-modification-service.ts`) and removing guests
 * (`booking-guest-removal-service.ts`). The last three reach it through
 * `lockAndRefreshPromoCodeUsage` below; the batch path calls this multi-id form
 * directly (it is the only one that can touch TWO codes, in a swap) and then
 * ALSO calls the wrapper on its no-swap reprice branch, where re-locking a row
 * it already holds is a no-op and the point is the refreshed counter.
 *
 * Two properties keep it safe:
 *
 * 1. **No lock-order cycle.** Ids are sorted and locked one statement at a
 *    time, so every caller takes promo row locks in the same global order —
 *    including a swap that touches the outgoing code and the incoming code in
 *    the same transaction. Sorting in the application rather than relying on
 *    `ORDER BY ... FOR UPDATE` keeps the ordering independent of the query
 *    plan. Callers already hold the per-lodge capacity lock, so the order stays
 *    lodge -> promo row, as documented.
 * 2. **No dependence on the raw result shape.** A constant is selected through
 *    `$executeRaw` and the result is discarded; the statement exists purely for
 *    its lock, so it cannot repeat the raw-SQL shape trap of #2289.
 *
 * A missing id simply locks nothing — the caller's own lookup reports "Promo
 * code not found".
 */
export async function lockPromoCodeRowsForUpdate(
  tx: PrismaTx,
  promoCodeIds: (string | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(promoCodeIds.filter((id): id is string => Boolean(id)))].sort();
  for (const id of ids) {
    // `$executeRaw` on a CONSTANT, not `$queryRaw` on a column (#2289): the
    // statement exists only for its lock, so saying so in the call is what keeps
    // it from ever being mistaken for a read whose shape somebody trusts.
    await tx.$executeRaw`SELECT 1 FROM "PromoCode" WHERE "id" = ${id} FOR UPDATE`;
  }
}

/**
 * The reprice form of the protocol above, for the four call sites that hold an
 * existing redemption and re-price it in place: adding guests, changing dates,
 * removing guests, and the batch-modification path's own reprice branch (the
 * branch that leaves the promo code as it is — see `booking-modify-plan.ts`,
 * where the swap branch instead takes the multi-id lock above and re-reads the
 * whole promo row under it; on the reprice branch the lock is already held, so
 * this call is here for the refreshed counter and its re-lock is a no-op).
 *
 * They each carry a `PromoCode` snapshot loaded with the booking, BEFORE the
 * transaction's locks were taken, so its `currentRedemptions` may already be
 * stale by the time the caps are checked. Locking without refreshing would be
 * theatre: the transaction would serialise correctly and then decide against a
 * number it read outside the lock. So this both takes the row lock and returns
 * the snapshot with the counter as it stands UNDER that lock.
 *
 * Callers MUST validate against the RETURNED object. Calling this and then
 * passing the snapshot that went in reopens exactly the race it closes, and
 * would look correct in review, so the source contract in
 * `src/lib/__tests__/promo-reprice-cap-exclusion.test.ts` pins the threading at
 * every call site.
 *
 * Only `currentRedemptions` is refreshed, deliberately. It is the one cap input
 * a concurrent booking flow mutates; the cap ceilings themselves
 * (`maxRedemptionsTotal`, `maxUsesPerMember`, …) are admin edits, and every
 * allocation-derived count is already read inside the transaction by
 * `validateAndCalculatePromoDiscount`.
 *
 * A code deleted between the two reads keeps the snapshot's value; the reprice
 * then fails on its own foreign keys rather than on a wrong number.
 */
export async function lockAndRefreshPromoCodeUsage<
  T extends { id: string; currentRedemptions: number },
>(tx: PrismaTx, promoCode: T): Promise<T> {
  await lockPromoCodeRowsForUpdate(tx, [promoCode.id]);
  const fresh = await tx.promoCode.findUnique({
    where: { id: promoCode.id },
    select: { currentRedemptions: true },
  });
  return fresh ? { ...promoCode, currentRedemptions: fresh.currentRedemptions } : promoCode;
}

/**
 * Re-check the promo's optional per-lodge restriction against the booking's
 * lodge, inside the same transaction that creates the redemption row. Belt
 * and braces alongside the upstream validateAndCalculatePromoDiscount check:
 * quotes and redemption can race an admin edit to a promo's lodge list, so
 * this closes that window rather than trusting the earlier read.
 */
async function assertPromoRedeemableAtLodge(
  tx: PrismaTx,
  promoCodeId: string,
  lodgeId: string | null | undefined
): Promise<void> {
  const restrictionRows = await tx.promoCodeLodge.findMany({
    where: { promoCodeId },
    select: { lodgeId: true },
  });
  if (restrictionRows.length === 0) return;
  if (!lodgeId || !restrictionRows.some((row) => row.lodgeId === lodgeId)) {
    throw new ApiError(PROMO_LODGE_RESTRICTION_MESSAGE, 400);
  }
}

/**
 * Create a PromoRedemption record and increment the promo code's
 * currentRedemptions by the number of BENEFICIAL allocation rows written —
 * zero when the application delivered nothing (#2299).
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
  targetBookingGuestIds?: string[],
  lodgeId?: string | null
): Promise<void> {
  await assertPromoRedeemableAtLodge(tx, promoCodeId, lodgeId);
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
  // LOAD-BEARING, not housekeeping: the `PromoRedemption_sync_allocation_insert`
  // trigger (20260527120000_add_promo_redemption_allocations) fires on the
  // create above and upserts a booker allocation row from the redemption's own
  // scalars — it exists so an old blue/green colour that writes only
  // PromoRedemption still gets an allocation. For a zero-benefit application
  // that row is all-zero, so without this delete the database would put back
  // exactly the row #2299 removes, and the member would burn their use again.
  // Must stay AFTER the redemption write.
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

  // Guarded like both siblings (`replacePromoRedemptionAllocations`,
  // `deletePromoRedemptionAndAdjustCount`): an application that consumed
  // nothing must not touch the promo code row at all, because writing it would
  // bump `updatedAt` and make a benefit-free application look like an admin
  // edit of the code. The repair migration avoids `updatedAt` for the same
  // reason.
  if (allocationData.length > 0) {
    await tx.promoCode.update({
      where: { id: promoCodeId },
      data: {
        currentRedemptions: { increment: allocationData.length },
      },
    });
  }
}

/**
 * Reprice an existing redemption in place.
 *
 * When a repriced booking loses all its promo benefit (its guests are removed,
 * its nights shrink below a fixed-nightly cap, its rates fall to zero) the new
 * allocation set is empty and the cap slot it held is released in the same
 * transaction that removes the benefit. That is deliberate and cannot
 * double-spend: at every instant the member holds exactly as many slots as they
 * hold benefits (#2299).
 */
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
  // Counted RAW (no benefit filter) on purpose: `currentRedemptions` is the
  // denormalised count of allocation ROWS, so the delta must be measured
  // against however many rows are actually there. Counting only beneficial rows
  // here would leave the counter high by one for every legacy all-zero row this
  // reprice deletes.
  //
  // Must also stay BEFORE the redemption update below: that update fires the
  // `PromoRedemption_sync_allocation_update` trigger, which upserts a booker
  // allocation row. Counting afterwards would see the trigger's transient row
  // and skew the delta.
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

  // Same load-bearing delete as `redeemPromoCode`, for the same reason: the
  // update above fired `PromoRedemption_sync_allocation_update`, which upserted
  // a booker allocation row from the redemption's scalars. Must stay AFTER the
  // redemption write, or a reprice that removes all benefit would leave the
  // trigger's all-zero row holding a cap slot.
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
  // Raw row count, for the same symmetry reason as
  // `replacePromoRedemptionAllocations`: give back exactly what was taken.
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
