import type { AgeTier, FixedNightlyMode, PromoCodeType, SeasonType } from "@prisma/client";
import {
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
} from "@/lib/club-time";
import { addDaysDateOnly, formatDateOnly, parseDateOnly } from "../date-only";
import {
  countActiveGuestsForNight,
  type GuestNightInput,
} from "@/lib/booking-guest-stay-ranges";

// Which membership type's rate rows a guest resolves to, and why (#1930, E4).
//   OWN_TYPE            — a member priced from their own MEMBER_RATE type.
//   NON_MEMBER_DEFAULT  — a true non-member priced from the built-in
//                         NON_MEMBER type (the only source group discount may
//                         substitute).
//   TYPE_POLICY_FORCED  — a member whose type forces the non-member rate
//                         (bookingBehavior NON_MEMBER_RATE); priced from
//                         NON_MEMBER but excluded from the group discount.
//   OTHER_LODGE_MEMBER  — a guest the club currently charges its NON-MEMBER
//                         rate, whom the booking officer has recognised as a
//                         member of the booking's partner lodge
//                         (BookingGuest.otherLodgeMember); priced from the
//                         built-in FULL type's rows, i.e. the club's own member
//                         rate. #2978: that is NOT the same as "a non-member of
//                         this club" — a member whose membership TYPE prices
//                         them at the non-member rate qualifies too, while a
//                         member repriced by the unpaid-subscription lockout is
//                         excluded. `guestIsOtherLodgeRateEligible` is the rule.
//                         Excluded from the group-discount substitution
//                         for the same reason a member is: the substitution
//                         exists to lift a NON_MEMBER-priced guest UP to the
//                         FULL rate, and this guest is already there.
export type RateSource =
  | "OWN_TYPE"
  | "NON_MEMBER_DEFAULT"
  | "TYPE_POLICY_FORCED"
  | "OTHER_LODGE_MEMBER";

export interface SeasonRateData {
  seasonId: string;
  startDate: Date;
  endDate: Date;
  type?: SeasonType;
  // Rate rows keyed by membership type (#1930, E4). A per-age-tier type has
  // one row per tier; a flat type (ageGroupsApply=false) has a single
  // NULL-ageTier row that applies to every tier.
  rates: {
    membershipTypeId: string;
    ageTier: AgeTier | null;
    pricePerNightCents: number;
  }[];
}

export interface GroupDiscountConfig {
  minGroupSize: number;
  summerOnly: boolean;
  enabled: boolean;
  // The membership type whose rate rows a qualifying discount substitutes for
  // NON_MEMBER_DEFAULT guests (#1930, E4). When null the discount cannot
  // upgrade a rate (defensive; seeded to the built-in FULL type).
  rateMembershipTypeId?: string | null;
}

export interface GuestInput {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  /**
   * The reciprocal other-club rate opt-in (Other Lodges epic). A NON-member the
   * booking officer has recognised as a member of the booking's partner lodge,
   * which `resolveGuestRateMembershipTypes` resolves to the built-in FULL type's
   * rate rows. Declared here because it is an input to RATE RESOLUTION, not to
   * the night arithmetic below — nothing in this module reads it.
   */
  otherLodgeMember?: boolean | null;
  // The membership type whose rate rows price this guest, and the reason
  // (#1930, E4). Resolved by resolveGuestRateMembershipTypes before pricing;
  // persisted as the BookingGuest.rateMembershipTypeId snapshot.
  rateMembershipTypeId: string;
  rateSource?: RateSource;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit included nights (issue #713). When present and non-empty, the
  // guest is priced for exactly these nights (which may be non-contiguous);
  // otherwise pricing falls back to the contiguous stayStart/stayEnd envelope.
  nights?: ReadonlyArray<GuestNightInput> | null;
  // Nightly prices locked at booking time (#1036). An entry matching a priced
  // night short-circuits the season-rate lookup for that night, so an edit
  // never reprices a night the guest already bought: only nights without a
  // locked entry — added nights, new guests — price at current season rates.
  // Edit paths pass the guest's stored BookingGuestNight rows here.
  lockedNightPrices?: ReadonlyArray<{
    stayDate: Date | string;
    priceCents: number;
  }> | null;
}

export interface PriceBreakdown {
  guests: {
    ageTier: AgeTier;
    isMember: boolean;
    // The resolved rate-membership-type snapshot for this guest (#1930, E4).
    // Callers persist it as BookingGuest.rateMembershipTypeId; Xero line
    // building reads it to pick the item code. This is the guest's RESOLVED
    // type, NOT any per-night group-discount substitution (which stays
    // internal, mirroring the old boolean flip that never touched storage).
    rateMembershipTypeId: string;
    nights: number;
    priceCents: number;
    perNightCents: number[];
    // The actual nights priced, in chronological order and parallel to
    // perNightCents. Callers use these to persist BookingGuestNight rows, build
    // Xero line items per contiguous run, and date the work-party promo window.
    nightDates: Date[];
  }[];
  totalPriceCents: number;
}

// A guest before the rate resolver has assigned its rate membership type
// (#1930, E4). Callers build these, then resolveGuestRateMembershipTypes turns
// them into fully-rated GuestInputs.
export type UnratedGuestInput = Omit<
  GuestInput,
  "rateMembershipTypeId" | "rateSource"
>;

export interface PromoCodeInput {
  type: PromoCodeType;
  valueCents?: number | null;
  percentOff?: number | null;
  freeNightsPerIndividual?: number | null;
  fixedNightlyPriceCents?: number | null;
  fixedNightlyMode?: FixedNightlyMode | null;
  maxGuestsPerBooking?: number | null;
  maxNightlyValueCents?: number | null;
  memberGuestsOnly?: boolean | null;
}

export interface PromoDiscountGuest {
  memberId: string | null;
  isMember: boolean;
  perNightRates: number[];
}

export interface CalculatePromoDiscountOptions {
  totalPriceCents: number;
  guests: PromoDiscountGuest[];
  // For FREE_NIGHTS: how many free nights remain in the booker's lifetime
  // budget for this code (already-consumed nights subtracted). When undefined,
  // no cap is applied beyond freeNightsPerIndividual.
  remainingFreeNights?: number;
  // For beneficiary-scoped FREE_NIGHTS promos: remaining free nights by member.
  remainingFreeNightsByMemberId?: Record<string, number>;
}

/** The exact span of a UTC day. Unix time has no leap seconds. */
const MS_PER_DAY = 86_400_000;

/**
 * The stored calendar day a booking date carries, re-encoded as the date-only
 * value the rest of this engine compares and iterates.
 *
 * ## THE CONTRACT: EVERY INPUT IS A CALENDAR DAY, NEVER AN INSTANT
 *
 * Every value that reaches here is a lodge calendar day held as the UTC-midnight
 * `Date` a `@db.Date` column round-trips through: `Booking.checkIn`/`checkOut`
 * and `BookingRequest.checkIn`/`checkOut` (`INV-DATE-013`),
 * `BookingGuest.stayStart`/`stayEnd` (`INV-DATE-012`),
 * `BookingGuestNight.stayDate`, `Season.startDate`/`endDate`, and the
 * `parseDateOnly` products the routes build from a `yyyy-MM-dd` night key. There
 * is no `createdAt`, no `Date.now()`, and no club-local wall time on any path
 * into this function — the whole-tree census is in #2870's group-F2 pull
 * request. A caller that acquires a real instant must derive its club calendar
 * day at its own boundary (`clubCalendarDateOf`, `INV-DATE-019`) and hand the
 * day in; widening this helper to guess which kind it was handed is precisely
 * how the two defects below become one function.
 *
 * **AND THE CONTRACT IS ENFORCED, not merely censused.** A census measures the
 * tree on one day; this one is load-bearing, so the guard below REFUSES any value
 * carrying a UTC time of day. Refusing is not the guessing ruled out above: this
 * function never decides which kind it was handed, it declines to answer for
 * anything that is not the one kind it accepts. Without it a caller passing
 * `booking.createdAt` is silently FLOORED to its UTC day — the kernel's own
 * `calendarDateOfDateOnlyInstant` docblock says "hand it a real `DateTime` and
 * you get that column's UTC day, which is the `INV-DATE-019` defect", and it
 * truncates rather than complaining. Under the projection this replaced, that
 * same input was accidentally RIGHT for an NZ club, so removing the projection
 * removed a safety net; this guard is what puts one back.
 * `date-only-encoding-guard.test.ts` cannot cover this site — it classifies by
 * Prisma field access read from `schema.prisma`, and the receiver here is a bare
 * parameter.
 *
 * ## WHAT THIS USED TO DO, AND WHY IT WAS A LIVE DEFECT (CT-4, #2870, finding 5)
 *
 * It read the value through `APP_TIME_ZONE` — the CONTAINER's zone, not even the
 * club's persisted one (`INV-CONFIG-002`). A `@db.Date` value is a calendar day
 * ENCODED at UTC midnight, and `INV-DATE-010` says that pinning "is an internal
 * encoding of the calendar date and nothing more", so projecting it through a
 * zone treats an encoding as a moment. For a club behind Greenwich that moved the day:
 * the stored `2026-07-04T00:00:00.000Z` came back as `2026-07-03`. Measured, not
 * inferred — `America/Denver` shifts it.
 *
 * Reading it in UTC instead is blessed BY NAME, and by a different id than an
 * earlier draft of this docblock claimed. `INV-DATE-019`'s first exact boundary:
 * "Truncating an existing `@db.Date` value the same way is fine — those are
 * already pinned to UTC midnight and encode a calendar day, not an instant. It is
 * not fine for a `DateTime` column." That sentence is also why the contract above
 * has to hold, and `INV-DATE-026` is why these columns qualify as calendar days
 * at all. Do NOT cite `INV-DATE-010` for the decode: its closing clause names
 * those two ids as that authority, and what it forbids is deriving a rule from
 * one of these values read as a MOMENT — not a licence to project. This
 * docblock, two test files and the kernel's own `dateOnlyInstantOf` comment had
 * each attributed the inverse to it (#3076, #3080).
 *
 * Because `getStayNights` is built on this, the whole per-night surface moved
 * with it: the policy-exception proposal's `envelopeNights` froze a party
 * starting the night before the stay did, so the officer reviewed those nights,
 * `recheckCapacity` asserted beds on those nights, and
 * `proposalGuestToCreateInput` executed them (`INV-EXCEPT-016`/`INV-EXCEPT-017`)
 * — while the season lookup priced them and `getMinimumStayViolations` read
 * their weekday. It did not deadlock approval only because the freeze and the
 * replay both came through here and therefore stayed wrong together.
 *
 * `dateOnlyInstantOf(calendarDateOfDateOnlyInstant(...))` is the kernel's
 * decode-then-re-encode pair and reads the value in UTC by definition. For a
 * well-formed `@db.Date` value it is the identity, which is why a club at or
 * ahead of Greenwich sees no change at all. That expression is also the entire
 * body of the `storedDateOnly` helper cloned in six other files
 * (`booking-exception-approval.ts`, `booking-modification-stay-ranges.ts`,
 * `booking-edit-policy.ts` and the change-requests, exception-requests and
 * modify-quote routes), so this function is a seventh instance of it wearing two
 * pre-guards and a different name. Named here because #2870's F3 hoist will
 * search for the spelling `storedDateOnly`, which this one does not carry, and
 * whatever the hoist becomes has to keep the guards (#2870 comment 3).
 *
 * IT ALSO RETIRES #1146's PERFORMANCE CARVE-OUT. That issue added a zone-keyed
 * formatter memo here because pricing normalises once per (guest, night) and
 * constructing an `Intl.DateTimeFormat` per call dominated quote and edit
 * repricing. The decode reads `getUTCFullYear`/`Month`/`Date`, so this path now
 * builds no formatter at all and the memo it needed is gone with it.
 */
function normalizeBookingDate(date: Date): Date {
  // Ahead of the decode, so the message is reachable: the kernel refuses an
  // unrepresentable value first, and `toISOString()` on an Invalid Date throws
  // `RangeError: Invalid time value` rather than formatting one.
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid booking date: Invalid Date");
  }

  // The contract above, enforced. Every legal producer of an input here — a
  // `@db.Date` round-trip, `parseDateOnly`, `addDaysDateOnly`, `dateOnlyFromParts`,
  // `dateOnlyInstantOf`, `normalizeDateOnlyForTimeZone` — lands on an exact
  // multiple of a day; a real instant does not. Unix time has no leap seconds, so
  // the modulus is exact, and it builds no formatter and reads no field.
  if (date.getTime() % MS_PER_DAY !== 0) {
    throw new Error(
      "Booking dates are calendar days encoded at UTC midnight, not instants: " +
        `got ${date.toISOString()}. Derive the club calendar day at the caller's ` +
        "own boundary and pass the day in (INV-DATE-019).",
    );
  }

  return dateOnlyInstantOf(calendarDateOfDateOnlyInstant(date));
}

function getBookingDateKey(date: Date): string {
  return formatDateOnly(normalizeBookingDate(date));
}

/**
 * Generate an array of dates for each night of a stay.
 * A stay from checkIn to checkOut charges for each night FROM checkIn UP TO (not including) checkOut.
 */
export function getStayNights(checkIn: Date, checkOut: Date): Date[] {
  const start = normalizeBookingDate(checkIn);
  const exclusiveEnd = normalizeBookingDate(checkOut);

  if (exclusiveEnd <= start) return [];

  const nights: Date[] = [];
  for (let current = start; current < exclusiveEnd; current = addDaysDateOnly(current, 1)) {
    nights.push(current);
  }

  return nights;
}

/**
 * Convert one explicit night entry (Date, `yyyy-mm-dd` string, or a
 * BookingGuestNight relation row) into a normalized booking date.
 */
function normalizeNightEntry(entry: GuestNightInput): Date {
  if (typeof entry === "string") {
    return normalizeBookingDate(parseDateOnly(entry));
  }
  if (entry instanceof Date) {
    return normalizeBookingDate(entry);
  }
  return normalizeNightEntry(entry.stayDate);
}

/**
 * The chronological list of nights to price for a guest. When the guest has an
 * explicit night set (issue #713) those nights are used (deduped, sorted),
 * allowing non-contiguous stays; otherwise the contiguous stayStart/stayEnd
 * envelope is expanded into nights exactly as before.
 */
function getGuestPricedNights(
  guest: GuestInput,
  bookingRange: { checkIn: Date; checkOut: Date }
): Date[] {
  if (guest.nights && guest.nights.length > 0) {
    const byKey = new Map<string, Date>();
    for (const entry of guest.nights) {
      const night = normalizeNightEntry(entry);
      byKey.set(formatDateOnly(night), night);
    }
    return [...byKey.values()].sort((a, b) => a.getTime() - b.getTime());
  }

  const guestStayStart = guest.stayStart
    ? normalizeBookingDate(guest.stayStart)
    : bookingRange.checkIn;
  const guestStayEnd = guest.stayEnd
    ? normalizeBookingDate(guest.stayEnd)
    : bookingRange.checkOut;
  return getStayNights(guestStayStart, guestStayEnd);
}

/**
 * Match a rate row within one season for a rate-membership-type + age tier.
 * Prefers an exact per-tier row and falls back to the type's flat
 * (NULL-ageTier) row, so both age-keyed and flat types resolve (#1930, E4).
 */
function matchSeasonRate(
  season: SeasonRateData,
  ageTier: AgeTier,
  rateMembershipTypeId: string
): number | null {
  let flat: number | null = null;
  for (const rate of season.rates) {
    if (rate.membershipTypeId !== rateMembershipTypeId) continue;
    if (rate.ageTier === ageTier) return rate.pricePerNightCents;
    if (rate.ageTier === null) flat = rate.pricePerNightCents;
  }
  return flat;
}

// test seam
/**
 * Find the rate for a specific night, guest tier, and rate membership type.
 */
export function findRateForNight(
  date: Date,
  ageTier: AgeTier,
  rateMembershipTypeId: string,
  seasons: SeasonRateData[]
): number | null {
  const dateKey = getBookingDateKey(date);

  for (const season of seasons) {
    const startKey = getBookingDateKey(season.startDate);
    const endKey = getBookingDateKey(season.endDate);
    if (dateKey >= startKey && dateKey <= endKey) {
      return matchSeasonRate(season, ageTier, rateMembershipTypeId);
    }
  }
  return null;
}

// test seam
/**
 * Find the season that contains a given date.
 * Returns null if no season covers that date.
 */
export function findSeasonForDate(
  date: Date,
  seasons: SeasonRateData[]
): SeasonRateData | null {
  const dateKey = getBookingDateKey(date);

  for (const season of seasons) {
    const startKey = getBookingDateKey(season.startDate);
    const endKey = getBookingDateKey(season.endDate);
    if (dateKey >= startKey && dateKey <= endKey) {
      return season;
    }
  }
  return null;
}

// test seam
/**
 * Get the nightly rate for a specific guest on a specific date.
 * Returns the price in cents, or null if no rate is found.
 */
export function getNightlyRate(
  date: Date,
  ageTier: AgeTier,
  rateMembershipTypeId: string,
  seasons: SeasonRateData[]
): { priceCents: number; seasonId: string } | null {
  const season = findSeasonForDate(date, seasons);
  if (!season) return null;

  const priceCents = matchSeasonRate(season, ageTier, rateMembershipTypeId);
  if (priceCents === null) return null;

  return {
    priceCents,
    seasonId: season.seasonId,
  };
}

/**
 * Check if a group discount applies for a given night.
 * Returns true if the group discount should override isMember to true.
 */
export function isGroupDiscountApplicable(
  guestCount: number,
  night: Date,
  seasons: SeasonRateData[],
  groupDiscount?: GroupDiscountConfig
): boolean {
  if (!groupDiscount || !groupDiscount.enabled) return false;
  if (guestCount < groupDiscount.minGroupSize) return false;
  if (!groupDiscount.summerOnly) return true;

  const season = findSeasonForDate(night, seasons);
  return season?.type === "SUMMER";
}

// test seam
export function isGroupDiscountAppliedToStay(
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  seasons: SeasonRateData[],
  groupDiscount?: GroupDiscountConfig
): boolean {
  return getStayNights(checkIn, checkOut).some((night) =>
    isGroupDiscountApplicable(guestCount, night, seasons, groupDiscount)
  );
}

/**
 * Calculate the total price for a booking.
 * Guests stay from checkIn night to checkOut-1 night.
 */
export function calculateBookingPrice(
  checkIn: Date,
  checkOut: Date,
  guests: GuestInput[],
  seasons: SeasonRateData[],
  groupDiscount?: GroupDiscountConfig
): PriceBreakdown {
  const bookingRange = {
    checkIn: normalizeBookingDate(checkIn),
    checkOut: normalizeBookingDate(checkOut),
  };

  const guestBreakdowns = guests.map((guest) => {
    const nights = getGuestPricedNights(guest, bookingRange);
    const lockedByKey = new Map<string, number>();
    for (const entry of guest.lockedNightPrices ?? []) {
      lockedByKey.set(
        formatDateOnly(normalizeNightEntry(entry.stayDate)),
        entry.priceCents
      );
    }
    const perNightCents: number[] = [];
    let guestTotal = 0;

    for (const night of nights) {
      // A night the guest already bought keeps its locked price (#1036) —
      // no season-rate lookup, no group-discount recomputation, and no
      // "no rate found" failure for a night that was purchasable when booked.
      const lockedRate = lockedByKey.get(formatDateOnly(night));
      if (lockedRate !== undefined) {
        perNightCents.push(lockedRate);
        guestTotal += lockedRate;
        continue;
      }

      const activeGuestCount = countActiveGuestsForNight(guests, night, bookingRange);
      // Group discount (#1930, E4): substitutes the configured rate membership
      // type ONLY for true non-members (rateSource NON_MEMBER_DEFAULT). Members
      // keep their own type's rate (OWN_TYPE) and TYPE_POLICY_FORCED members
      // are excluded — exactly the two behaviours the old boolean flip
      // preserved. The substitution is per-night and internal; the persisted
      // snapshot stays the guest's resolved rateMembershipTypeId.
      const effectiveRateTypeId =
        guest.rateSource === "NON_MEMBER_DEFAULT" &&
        groupDiscount?.rateMembershipTypeId &&
        isGroupDiscountApplicable(activeGuestCount, night, seasons, groupDiscount)
          ? groupDiscount.rateMembershipTypeId
          : guest.rateMembershipTypeId;

      const rate = findRateForNight(night, guest.ageTier, effectiveRateTypeId, seasons);
      if (rate === null) {
        throw new Error(
          `No rate found for ${guest.ageTier} (rate type: ${effectiveRateTypeId}) on ${formatDateOnly(night)}`
        );
      }
      perNightCents.push(rate);
      guestTotal += rate;
    }

    return {
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId,
      nights: nights.length,
      priceCents: guestTotal,
      perNightCents,
      nightDates: nights,
    };
  });

  const totalPriceCents = guestBreakdowns.reduce((sum, g) => sum + g.priceCents, 0);

  return {
    guests: guestBreakdowns,
    totalPriceCents,
  };
}

/**
 * One season's flat whole-lodge nightly rate window (#2338). `startDate`/
 * `endDate` are the season's inclusive @db.Date bounds; `flatWholeLodgeNightCents`
 * is the per-night whole-lodge charge in integer cents, or null when the season
 * has no flat rate set.
 */
export interface WholeLodgeFlatSeason {
  startDate: Date;
  endDate: Date;
  flatWholeLodgeNightCents: number | null;
}

/**
 * Price a whole-lodge stay at the per-season flat nightly rate, ignoring
 * headcount entirely (#2338, D1 deferral of #2263). Each night is charged its
 * OWN covering season's flat rate, so a stay that crosses a season boundary
 * sums winter nights at the winter flat rate and summer nights at the summer
 * one.
 *
 * Returns null — meaning "cannot flat-price this stay, fall back to per-guest" —
 * when the stay has no nights, when no active season covers some night, or when
 * a covering season carries no flat rate. The all-or-nothing rule is deliberate:
 * a partially-covered stay has no single defensible whole-lodge figure, so the
 * caller reverts to per-guest pricing (which itself falls back to the officer's
 * mandatory manual override) rather than silently charging for only some nights.
 */
export function priceWholeLodgeFlat(
  checkIn: Date,
  checkOut: Date,
  seasons: WholeLodgeFlatSeason[]
): number | null {
  const nights = getStayNights(checkIn, checkOut);
  if (nights.length === 0) return null;

  let total = 0;
  for (const night of nights) {
    const dateKey = getBookingDateKey(night);
    let rate: number | null = null;
    for (const season of seasons) {
      const startKey = getBookingDateKey(season.startDate);
      const endKey = getBookingDateKey(season.endDate);
      if (dateKey >= startKey && dateKey <= endKey) {
        rate = season.flatWholeLodgeNightCents;
        break;
      }
    }
    if (rate == null) return null;
    total += rate;
  }
  return total;
}

export interface PromoDiscountResult {
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
  eligibleGuestCount: number;
  allocations: PromoDiscountAllocation[];
}

export interface PromoDiscountAllocation {
  memberId: string;
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number;
}

/**
 * Which guests a promotion applies to, in the order it applies to them.
 *
 * The order is **most expensive stay first**, so a `maxGuestsPerBooking` cap
 * spends its slots where they are worth the most. It is deterministic — it
 * depends only on the guests' own rates, never on a query plan or a hash order.
 *
 * `protectedMemberIds` (#2390) is the one thing that outranks cost: a member who
 * is ALREADY benefiting from this promotion on the booking being repriced keeps
 * their slot even when a newly-added guest has a more expensive stay. Without
 * that, adding an expensive guest would evict somebody who already held the
 * discount — the club would bill them back for a promise it already made, which
 * is precisely what the owner decision of 31 Jul 2026 rules out. It is empty on
 * every path except a reprice, so booking creation is untouched.
 */
export function selectPromoDiscountGuests(
  promo: PromoCodeInput,
  guests: PromoDiscountGuest[],
  protectedMemberIds?: ReadonlySet<string> | null,
) {
  const eligibleAll = promo.memberGuestsOnly
    ? guests.filter((g) => g.isMember)
    : guests;

  const isProtected = (guest: PromoDiscountGuest) =>
    Boolean(
      protectedMemberIds &&
        protectedMemberIds.size > 0 &&
        guest.memberId &&
        protectedMemberIds.has(guest.memberId)
    );

  const withTotals = eligibleAll.map((g, idx) => ({
    guest: g,
    idx,
    total: g.perNightRates.reduce((sum, r) => sum + r, 0),
  }));
  withTotals.sort((a, b) => {
    const aProtected = isProtected(a.guest);
    const bProtected = isProtected(b.guest);
    if (aProtected !== bProtected) return aProtected ? -1 : 1;
    return b.total - a.total;
  });
  const guestCap = promo.maxGuestsPerBooking ?? withTotals.length;
  return withTotals.slice(0, Math.max(0, guestCap));
}

function addPromoAllocation(
  allocations: Map<string, PromoDiscountAllocation>,
  memberId: string | null,
  discountCents: number,
  priceAdjustmentCents: number,
  freeNightsUsed: number,
  includeWhenZero = false,
) {
  if (
    !memberId ||
    (discountCents <= 0 && freeNightsUsed <= 0 && priceAdjustmentCents === 0 && !includeWhenZero)
  ) return;

  const existing = allocations.get(memberId);
  if (existing) {
    existing.discountCents += discountCents;
    existing.priceAdjustmentCents += priceAdjustmentCents;
    existing.freeNightsUsed += freeNightsUsed;
    return;
  }

  allocations.set(memberId, {
    memberId,
    discountCents,
    priceAdjustmentCents,
    freeNightsUsed,
  });
}

/**
 * Cap the total promo discount at totalPriceCents and, when the cap binds, rescale each member's
 * discountCents proportionally (largest-remainder, integer cents) so the per-member allocations sum
 * exactly to the capped total. Keeps priceAdjustmentCents = -discountCents in lockstep. Defensive:
 * only binds when the uncapped discount exceeds the booking total (needs percentOff > 100 to survive
 * validation). (#1206)
 */
function capPromoDiscountAcrossAllocations(
  allocations: Map<string, PromoDiscountAllocation>,
  uncappedDiscountCents: number,
  totalPriceCents: number
): number {
  const cappedCents = Math.min(uncappedDiscountCents, totalPriceCents);
  if (uncappedDiscountCents <= 0 || cappedCents >= uncappedDiscountCents) {
    return cappedCents; // no binding cap → allocations already sum to the total
  }
  // Largest-remainder rescale so Σ round-down + distributed remainder === cappedCents.
  const entries = [...allocations.values()].filter((a) => a.discountCents > 0);
  const floored = entries.map((a) => {
    const exact = (a.discountCents * cappedCents) / uncappedDiscountCents;
    const floor = Math.floor(exact);
    return { alloc: a, floor, frac: exact - floor };
  });
  let remainder = cappedCents - floored.reduce((s, f) => s + f.floor, 0);
  floored.sort((x, y) => y.frac - x.frac);
  for (const f of floored) {
    const add = remainder > 0 ? 1 : 0;
    remainder -= add;
    const newDiscount = f.floor + add;
    f.alloc.discountCents = newDiscount;
    f.alloc.priceAdjustmentCents = -newDiscount;
  }
  return cappedCents;
}

/**
 * Apply a promo code discount to a booking. All promo types are applied
 * per eligible guest.
 *
 * Eligibility (see `selectPromoDiscountGuests` for the full ordering rule,
 * including the #2390 protection that outranks cost on a reprice):
 *   - If promo.memberGuestsOnly is true, only guests with isMember=true count.
 *   - Eligible guests are then sorted by total stay cost descending.
 *   - If promo.maxGuestsPerBooking is set, only the top N count.
 *
 * Per-type behaviour applied to each selected guest:
 *   - PERCENTAGE: percentOff% off each of the guest's nights. If
 *     maxNightlyValueCents is set, the discount per night is capped at it.
 *   - FIXED_AMOUNT: valueCents off each selected guest, capped at the
 *     guest's stay total.
 *   - FREE_NIGHTS: discount the guest's most expensive freeNightsPerIndividual
 *     nights. The lifetime cap (remainingFreeNights) is a single pool the
 *     booker draws on across selected guests, applied to the most expensive
 *     nights first. maxNightlyValueCents (if set) caps each freed night,
 *     turning full coverage into a partial subsidy.
 */
export function calculatePromoDiscount(
  promo: PromoCodeInput,
  opts: CalculatePromoDiscountOptions,
): PromoDiscountResult {
  const {
    totalPriceCents,
    guests,
    remainingFreeNights,
    remainingFreeNightsByMemberId,
  } = opts;
  const empty: PromoDiscountResult = {
    discountCents: 0,
    priceAdjustmentCents: 0,
    freeNightsUsed: 0,
    eligibleGuestCount: 0,
    allocations: [],
  };

  const selected = selectPromoDiscountGuests(promo, guests);
  if (selected.length === 0) return empty;

  switch (promo.type) {
    case "PERCENTAGE": {
      const pct = promo.percentOff ?? 0;
      if (pct <= 0) return empty;
      let discount = 0;
      const allocations = new Map<string, PromoDiscountAllocation>();
      for (const { guest } of selected) {
        let guestDiscount = 0;
        for (const rate of guest.perNightRates) {
          const raw = Math.round((rate * pct) / 100);
          const capped = promo.maxNightlyValueCents != null
            ? Math.min(raw, promo.maxNightlyValueCents)
            : raw;
          guestDiscount += capped;
        }
        discount += guestDiscount;
        addPromoAllocation(allocations, guest.memberId, guestDiscount, -guestDiscount, 0);
      }
      // Cap at total booking price as a safety rail.
      const discountCents = capPromoDiscountAcrossAllocations(allocations, discount, totalPriceCents);
      return {
        discountCents,
        priceAdjustmentCents: -discountCents,
        freeNightsUsed: 0,
        eligibleGuestCount: selected.length,
        allocations: [...allocations.values()],
      };
    }

    case "FIXED_AMOUNT": {
      const perGuest = promo.valueCents ?? 0;
      if (perGuest <= 0) return empty;
      let discount = 0;
      const allocations = new Map<string, PromoDiscountAllocation>();
      for (const { guest } of selected) {
        const guestTotal = guest.perNightRates.reduce((s, r) => s + r, 0);
        const guestDiscount = Math.min(perGuest, guestTotal);
        discount += guestDiscount;
        addPromoAllocation(allocations, guest.memberId, guestDiscount, -guestDiscount, 0);
      }
      const discountCents = capPromoDiscountAcrossAllocations(allocations, discount, totalPriceCents);
      return {
        discountCents,
        priceAdjustmentCents: -discountCents,
        freeNightsUsed: 0,
        eligibleGuestCount: selected.length,
        allocations: [...allocations.values()],
      };
    }

    case "FREE_NIGHTS": {
      const perIndividual = promo.freeNightsPerIndividual ?? 0;
      if (perIndividual <= 0) return empty;

      // Apply the lifetime cap as a single pool the booker draws on across
      // selected guests, allocated to the most expensive remaining nights.
      const lifetimeCap = remainingFreeNights !== undefined
        ? Math.max(0, remainingFreeNights)
        : Number.POSITIVE_INFINITY;
      if (!remainingFreeNightsByMemberId && lifetimeCap <= 0) return empty;

      // Collect candidate nights from each selected guest: each guest contributes
      // up to perIndividual of their most expensive nights.
      const candidates: { rate: number; memberId: string | null }[] = [];
      for (const { guest } of selected) {
        const sortedDesc = [...guest.perNightRates].sort((a, b) => b - a);
        for (const rate of sortedDesc.slice(0, perIndividual)) {
          candidates.push({ rate, memberId: guest.memberId });
        }
      }
      if (candidates.length === 0) return empty;

      // Of those candidates, pick the most expensive up to the lifetime cap.
      candidates.sort((a, b) => b.rate - a.rate);
      const usedCount = remainingFreeNightsByMemberId
        ? candidates.length
        : Math.min(candidates.length, Math.floor(Math.min(lifetimeCap, candidates.length)));
      let discount = 0;
      let freeNightsUsed = 0;
      const usedByMemberId = new Map<string, number>();
      const allocations = new Map<string, PromoDiscountAllocation>();
      for (let i = 0; i < usedCount; i++) {
        const { rate, memberId } = candidates[i];

        if (remainingFreeNightsByMemberId) {
          if (!memberId) continue;
          const memberCap = Math.max(
            0,
            Math.floor(remainingFreeNightsByMemberId[memberId] ?? perIndividual)
          );
          const memberUsed = usedByMemberId.get(memberId) ?? 0;
          if (memberUsed >= memberCap) continue;
          usedByMemberId.set(memberId, memberUsed + 1);
        }

        const capped = promo.maxNightlyValueCents != null
          ? Math.min(rate, promo.maxNightlyValueCents)
          : rate;
        discount += capped;
        freeNightsUsed += 1;
        addPromoAllocation(allocations, memberId, capped, -capped, 1);
      }
      const discountCents = capPromoDiscountAcrossAllocations(allocations, discount, totalPriceCents);
      return {
        discountCents,
        priceAdjustmentCents: -discountCents,
        freeNightsUsed,
        eligibleGuestCount: selected.length,
        allocations: [...allocations.values()],
      };
    }

    case "FIXED_NIGHTLY_PRICE": {
      const fixedNightlyPriceCents = promo.fixedNightlyPriceCents ?? 0;
      if (fixedNightlyPriceCents <= 0) return empty;

      const mode = promo.fixedNightlyMode ?? "CAP_ONLY";
      let totalAdjustment = 0;
      let effectiveGuestCount = 0;
      const allocations = new Map<string, PromoDiscountAllocation>();

      for (const { guest } of selected) {
        let guestAdjustment = 0;
        let cappedNightCount = 0;

        for (const rate of guest.perNightRates) {
          if (mode === "CAP_ONLY") {
            if (rate <= fixedNightlyPriceCents) continue;
            guestAdjustment += fixedNightlyPriceCents - rate;
            cappedNightCount += 1;
          } else {
            guestAdjustment += fixedNightlyPriceCents - rate;
          }
        }

        const countsAsBeneficiary =
          mode === "SET_PRICE"
            ? guest.perNightRates.length > 0
            : cappedNightCount > 0;
        if (!countsAsBeneficiary) continue;

        // `includeWhenZero` below keeps a SET_PRICE guest in the in-memory
        // allocation list even when their nights net to no change, so
        // eligibleGuestCount and this list agree about who was re-priced. It no
        // longer decides whether a usage cap is consumed: since #2299 an entry
        // that moved no money is dropped at WRITE time by normalizeAllocations,
        // because the member's total is identical with and without the code.
        // See docs/DOMAIN_INVARIANTS.md → Money.

        totalAdjustment += guestAdjustment;
        effectiveGuestCount += 1;
        addPromoAllocation(
          allocations,
          guest.memberId,
          Math.max(0, -guestAdjustment),
          guestAdjustment,
          0,
          mode === "SET_PRICE"
        );
      }

      return {
        discountCents: Math.max(0, -totalAdjustment),
        priceAdjustmentCents: totalAdjustment,
        freeNightsUsed: 0,
        eligibleGuestCount: effectiveGuestCount,
        allocations: [...allocations.values()],
      };
    }

    default:
      return empty;
  }
}
