import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  SubscriptionLiabilityAgeSource,
  SubscriptionRequiredTypeAgeRule,
  SubscriptionStatus,
} from "@prisma/client";
import type { AdminAccessRequirement } from "@/lib/admin-permissions";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  calendarDateParts,
  compareCalendarDates,
  countClubNights,
  dateOnlyInstantOf,
  type CalendarDate,
} from "@/lib/club-time";
import {
  computeAgeOnCalendarDays,
  computeAgeTierWithSettings,
  getSeasonStartCalendarDate,
  type AgeTierSettingData,
} from "./age-tier";

export function requiresPaidSubscriptionForAgeTier(
  ageTier: AgeTier | null | undefined,
  settings: AgeTierSettingData[]
): boolean {
  if (!ageTier) {
    return true;
  }

  // NOT_APPLICABLE is the organisation/school tier (#1440): it never has a
  // settings row, and without this it would inherit the missing-row default
  // of `true` — imposing an age-based subscription requirement on accounts
  // that have no age.
  if (ageTier === "NOT_APPLICABLE") {
    return false;
  }

  return (
    settings.find((setting) => setting.tier === ageTier)
      ?.subscriptionRequiredForBooking ?? true
  );
}

// ---------------------------------------------------------------------------
// Subscription liability: ONE rule for billing and booking access (#5190,
// INV-CONFIG-009, INV-MONEY-046, INV-LOCKOUT-020).
//
// The club answers two questions on `MembershipLockoutSettings`:
//  - `requiredTypeAgeRule`: does an exempt age tier exempt a member on an
//    always-required (`REQUIRED`) membership type?
//  - `liabilityAgeSource`: which age decides the tier?
// Until BOTH are chosen the club is on `NOT_CHOSEN`, which reproduces the
// pre-#5190 behaviour exactly — and that is the ONLY state in which billing and
// access may answer differently (owner decision, 20 Nov 2026: nothing changes
// silently on upgrade). Once chosen, both sides read the same pair and a
// member's saved `NOT_REQUIRED` season row exempts nobody (Edge 2, owner
// decision 18 Nov 2026: age wins).
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_REQUIRED_TYPE_AGE_RULES = [
  "NOT_CHOSEN",
  "ALWAYS_OWES",
  "AGE_TIER_EXEMPTS",
] as const satisfies readonly SubscriptionRequiredTypeAgeRule[];

export const SUBSCRIPTION_LIABILITY_AGE_SOURCES = [
  "NOT_CHOSEN",
  "SEASON_START",
  "SEASON_END",
  "CURRENT_AGE",
] as const satisfies readonly SubscriptionLiabilityAgeSource[];

/**
 * The age sources a club may choose: every source but `NOT_CHOSEN`.
 * `CURRENT_AGE` (#5190 PR 3, owner decisions 20 and 27 Nov 2026) reads the
 * member's age today and settles a mid-season age-up with a part-season
 * invoice, top-up or credit (`resolveAgeUpPart`, `INV-MONEY-051`).
 */
export const CHOOSABLE_LIABILITY_AGE_SOURCES = [
  "SEASON_START",
  "SEASON_END",
  "CURRENT_AGE",
] as const satisfies readonly SubscriptionLiabilityAgeSource[];

type ChoosableLiabilityAgeSource =
  (typeof CHOOSABLE_LIABILITY_AGE_SOURCES)[number];

export interface SubscriptionLiabilitySettings {
  requiredTypeAgeRule: SubscriptionRequiredTypeAgeRule;
  liabilityAgeSource: SubscriptionLiabilityAgeSource;
}

export const NOT_CHOSEN_LIABILITY_SETTINGS: SubscriptionLiabilitySettings = {
  requiredTypeAgeRule: "NOT_CHOSEN",
  liabilityAgeSource: "NOT_CHOSEN",
};

export function isSubscriptionRequiredTypeAgeRule(
  value: unknown,
): value is SubscriptionRequiredTypeAgeRule {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_REQUIRED_TYPE_AGE_RULES as readonly string[]).includes(value)
  );
}

export function isSubscriptionLiabilityAgeSource(
  value: unknown,
): value is SubscriptionLiabilityAgeSource {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_LIABILITY_AGE_SOURCES as readonly string[]).includes(value)
  );
}

export function isChoosableLiabilityAgeSource(
  value: unknown,
): value is ChoosableLiabilityAgeSource {
  return (
    typeof value === "string" &&
    (CHOOSABLE_LIABILITY_AGE_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Who may choose or change the liability rule (#5190, owner decision 23 Nov
 * 2026,
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5190#issuecomment-7088835754):
 * membership edit AND finance edit, because the choice changes who the billing
 * run invoices. The settings `PUT` enforces it and the admin section gates its
 * editor on the same list; other lockout settings keep membership edit alone.
 */
export const LIABILITY_RULE_CHOICE_PERMISSIONS = [
  { area: "membership", level: "edit" },
  { area: "finance", level: "edit" },
] as const satisfies readonly AdminAccessRequirement[];

/**
 * The chosen age source, or null for `NOT_CHOSEN`. Exhaustive, so a new enum
 * value is a compile error here rather than a silent cast (#5190 PR 3).
 */
function chosenAgeSource(
  source: SubscriptionLiabilityAgeSource,
): ChoosableLiabilityAgeSource | null {
  switch (source) {
    case "SEASON_START":
    case "SEASON_END":
    case "CURRENT_AGE":
      return source;
    case "NOT_CHOSEN":
      return null;
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}

/** The club has chosen its rule: both answers set, to values open for choice. */
export function hasChosenLiabilityRule(
  settings: SubscriptionLiabilitySettings,
): boolean {
  return (
    settings.requiredTypeAgeRule !== "NOT_CHOSEN" &&
    chosenAgeSource(settings.liabilityAgeSource) !== null
  );
}

/** Who is asking: the subscription billing run, or a booking-access gate. */
export type SubscriptionLiabilitySide = "billing" | "access";

/**
 * The side the admin members list, its CSV export and the subscriptions list
 * show (owner decision Q2 on #5190, 22 Nov 2026): billing. While the club is
 * `NOT_CHOSEN` the lists say who the billing run charges, so an organisation or
 * school account (`NOT_APPLICABLE` tier) on a `REQUIRED` type shows as owing even
 * though booking access lets it book. Once the club has chosen, both sides are
 * the same rule. The display flag and its SQL filter both read this, so they
 * cannot pick different sides.
 */
export const ADMIN_LIST_LIABILITY_SIDE: SubscriptionLiabilitySide = "billing";

/** Which age a side reads: a DOB-derived tier on a fixed day, or the stored one. */
export type LiabilityAgeTierSource = ChoosableLiabilityAgeSource | "STORED_TIER";

/** One side's resolved rule. Build it with {@link liabilityRuleFor}. */
export interface SubscriptionLiabilityRule {
  /** Whether an exempt age tier exempts a member on a `REQUIRED` type. */
  requiredTypeAgeRule: "ALWAYS_OWES" | "AGE_TIER_EXEMPTS";
  ageSource: LiabilityAgeTierSource;
  /**
   * Whether a saved `NOT_REQUIRED` season row exempts a member on a
   * `BASED_ON_AGE_TIER` type. Only booking access, and only while the club is
   * `NOT_CHOSEN` (#2041 decision Q4, kept until the club opts in).
   */
  seasonRowExempts: boolean;
}

/**
 * The rule one side applies. Once the club has chosen, both sides get the
 * identical rule; while it has not, each side keeps its pre-#5190 rule.
 */
export function liabilityRuleFor(
  side: SubscriptionLiabilitySide,
  settings: SubscriptionLiabilitySettings,
): SubscriptionLiabilityRule {
  const ageSource = chosenAgeSource(settings.liabilityAgeSource);
  if (settings.requiredTypeAgeRule !== "NOT_CHOSEN" && ageSource !== null) {
    return {
      requiredTypeAgeRule: settings.requiredTypeAgeRule,
      ageSource,
      seasonRowExempts: false,
    };
  }
  return side === "billing"
    ? { requiredTypeAgeRule: "ALWAYS_OWES", ageSource: "SEASON_START", seasonRowExempts: false }
    : { requiredTypeAgeRule: "AGE_TIER_EXEMPTS", ageSource: "STORED_TIER", seasonRowExempts: true };
}

/**
 * The last day of a season year, as a calendar day: the day before the next
 * season starts. For the default 31 March year-end, season 2026 ends on
 * 2027-03-31. The one definition the TS rule and the SQL filter
 * (`subscription-liability-where.ts`) both read (`INV-SSOT`).
 */
export function getSeasonEndCalendarDate(seasonYear: number): CalendarDate {
  return addCalendarDays(getSeasonStartCalendarDate(seasonYear + 1), -1);
}

/** {@link getSeasonEndCalendarDate} as a stored date-only instant. */
export function getSeasonEndDate(seasonYear: number): Date {
  return dateOnlyInstantOf(getSeasonEndCalendarDate(seasonYear));
}

/**
 * The day a DOB-derived source reads the age on: the season's first or last
 * day, or `asOf` (the club's today) for `CURRENT_AGE`. The one definition the
 * TS rule and the SQL filter (`subscription-liability-where.ts`) both read.
 */
export function liabilityReferenceDate(
  source: ChoosableLiabilityAgeSource,
  seasonYear: number,
  asOf: CalendarDate,
): CalendarDate {
  switch (source) {
    case "SEASON_START":
      return getSeasonStartCalendarDate(seasonYear);
    case "SEASON_END":
      return getSeasonEndCalendarDate(seasonYear);
    case "CURRENT_AGE":
      return asOf;
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}

/**
 * The age tier that decides liability for one member and season. A member with
 * no date of birth keeps their stored tier, whatever the source. `asOf` is the
 * club's today: the day `CURRENT_AGE` reads the age on (owner decision, 20 Nov
 * 2026); the season sources ignore it.
 */
export function resolveLiabilityAgeTier(input: {
  source: LiabilityAgeTierSource;
  dateOfBirth: Date | null | undefined;
  storedAgeTier: AgeTier | null | undefined;
  seasonYear: number;
  asOf: CalendarDate;
  ageTierSettings: AgeTierSettingData[];
}): AgeTier | null {
  const storedAgeTier = input.storedAgeTier ?? null;
  if (input.source === "STORED_TIER" || !input.dateOfBirth) {
    return storedAgeTier;
  }
  return computeAgeTierWithSettings(
    input.dateOfBirth,
    dateOnlyInstantOf(liabilityReferenceDate(input.source, input.seasonYear, input.asOf)),
    input.ageTierSettings,
  );
}

/**
 * THE liability rule: does this member owe a subscription for the season?
 *
 * Billing, booking access and every display surface call this (directly or
 * through {@link resolveMemberSubscriptionLiability}) and never keep a copy.
 * `ageTier` is the tier the side's `ageSource` resolved; null means owing — an
 * unresolved member must never silently book at member rates.
 */
export function resolveSubscriptionLiability(input: {
  /** Null when no membership type resolved: judged like a `REQUIRED` type. */
  subscriptionBehavior: MembershipTypeSubscriptionBehavior | null | undefined;
  ageTier: AgeTier | null | undefined;
  /** The member's saved season row status, if a row exists. */
  seasonRowStatus: SubscriptionStatus | null | undefined;
  rule: SubscriptionLiabilityRule;
  ageTierSettings: AgeTierSettingData[];
}): boolean {
  if (input.subscriptionBehavior === "NOT_REQUIRED") return false;
  if (input.subscriptionBehavior === "BASED_ON_AGE_TIER") {
    if (input.rule.seasonRowExempts && input.seasonRowStatus === "NOT_REQUIRED") {
      return false;
    }
  } else if (input.rule.requiredTypeAgeRule === "ALWAYS_OWES") {
    return true;
  }
  return requiresPaidSubscriptionForAgeTier(input.ageTier, input.ageTierSettings);
}

/**
 * {@link resolveLiabilityAgeTier} then {@link resolveSubscriptionLiability}, for
 * a caller holding the member's row. Returns the tier too, which billing prices
 * a `BASED_ON_AGE_TIER` fee from and shows in its exempt list.
 */
export function resolveMemberSubscriptionLiability(input: {
  subscriptionBehavior: MembershipTypeSubscriptionBehavior | null | undefined;
  /** Null when no Member row resolved: owing. */
  member: { dateOfBirth: Date | null; ageTier: AgeTier } | null | undefined;
  seasonRowStatus: SubscriptionStatus | null | undefined;
  seasonYear: number;
  /** The club's today; the day `CURRENT_AGE` reads the age on. */
  asOf: CalendarDate;
  rule: SubscriptionLiabilityRule;
  ageTierSettings: AgeTierSettingData[];
}): { owes: boolean; ageTier: AgeTier | null } {
  const ageTier = input.member
    ? resolveLiabilityAgeTier({
        source: input.rule.ageSource,
        dateOfBirth: input.member.dateOfBirth,
        storedAgeTier: input.member.ageTier,
        seasonYear: input.seasonYear,
        asOf: input.asOf,
        ageTierSettings: input.ageTierSettings,
      })
    : null;
  return {
    owes: resolveSubscriptionLiability({
      subscriptionBehavior: input.subscriptionBehavior,
      ageTier,
      seasonRowStatus: input.seasonRowStatus,
      rule: input.rule,
      ageTierSettings: input.ageTierSettings,
    }),
    ageTier,
  };
}

// ---------------------------------------------------------------------------
// Part-season proration, shared by the season charge and the age-up parts
// (#5190 PR 3, `INV-MONEY-051`). One definition, so a part-season invoice, a
// top-up and a credit count months and round cents exactly as a mid-season
// joiner's prorated charge does (`calculateMembershipCharge`).
// ---------------------------------------------------------------------------

/**
 * Whole months from `from`'s month to the season's last month, both counted:
 * a 15 January age-up in a 1 April to 31 March season covers January, February
 * and March, 3 months (owner decision, 20 Nov 2026).
 */
export function remainingSeasonMonthsInclusive(seasonYear: number, from: CalendarDate): number {
  const end = calendarDateParts(getSeasonEndCalendarDate(seasonYear));
  const start = calendarDateParts(from);
  return (end.year - start.year) * 12 + end.month - start.month + 1;
}

/**
 * `annualCents` over `months` twelfths, rounded half-up to the cent with
 * integer arithmetic. Fee schedules are Int32, so this stays far below the
 * safe-integer ceiling.
 */
export function prorateAnnualCents(annualCents: number, months: number): number {
  return Math.floor((annualCents * months + 6) / 12);
}

// ---------------------------------------------------------------------------
// Age-up under "Age today" (#5190 PR 3; owner decisions 20 and 27 Nov 2026).
//
// The season charge is billed at the season-start tier. A member whose age
// moves them to another tier during the season then settles the difference
// for the whole months left, the birthday month included:
//  - not owing -> owing: a part-season invoice at the new tier;
//  - owing -> owing at a dearer tier: a part-season top-up for the difference;
//  - owing -> owing at a cheaper tier, or -> not owing: a part-season credit.
// An age rises by exactly one year inside a twelve-month season, so a member
// has at most one age-up a season; a ladder with several thresholds still
// moves them across only one of them.
// ---------------------------------------------------------------------------

/** One member's mid-season tier change, before it is priced. */
export interface AgeUpEvent {
  /** The first season day the new tier applies from. */
  ageUpDate: CalendarDate;
  fromTier: AgeTier;
  toTier: AgeTier;
  fromOwes: boolean;
  toOwes: boolean;
}

/** {@link AgeUpEvent} priced: what is owed, or credited, for the months left. */
export interface AgeUpPart extends AgeUpEvent {
  coveredMonths: number;
  /** The from tier's annual fee, 0 when that tier owes nothing. */
  fromAnnualCents: number;
  /** The to tier's annual fee, 0 when that tier owes nothing. */
  toAnnualCents: number;
  /** Positive: owed by the member. Negative: credited to them. Never 0. */
  signedDifferenceCents: number;
}

export interface AgeUpInput {
  dateOfBirth: Date | null | undefined;
  /** `Member.joinedDate`: a member who joined after the birthday ages up on joining. */
  joinedDate: Date | null | undefined;
  seasonYear: number;
  /** The club's today, or the billing run's decision date: an age-up after it has not happened yet. */
  asOf: CalendarDate;
  rule: SubscriptionLiabilityRule;
  subscriptionBehavior: MembershipTypeSubscriptionBehavior | null | undefined;
  ageTierSettings: AgeTierSettingData[];
}

/**
 * The first day in `(start, end]` on which the member's age passes its
 * season-start value, or null when it never does in this season. Binary search
 * over `computeAgeOnCalendarDays`, which only ever rises, so a 29 February
 * birthday lands on 1 March in a season with no 29 February (that function's
 * own convention, `INV-DATE`).
 */
function birthdayCrossing(dateOfBirth: CalendarDate, seasonYear: number): CalendarDate | null {
  const start = getSeasonStartCalendarDate(seasonYear);
  const startAge = computeAgeOnCalendarDays(dateOfBirth, start);
  const seasonDays = countClubNights(start, getSeasonEndCalendarDate(seasonYear));
  if (computeAgeOnCalendarDays(dateOfBirth, addCalendarDays(start, seasonDays)) === startAge) {
    return null;
  }
  // Invariant: the age at `low` is the season-start age; at `high` it is not.
  let low = 0;
  let high = seasonDays;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (computeAgeOnCalendarDays(dateOfBirth, addCalendarDays(start, middle)) === startAge) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return addCalendarDays(start, high);
}

/**
 * The member's age-up this season, if the club reads "Age today", the member
 * has a date of birth, their tier changes during the season and that day has
 * come by `asOf`. Null otherwise, and when neither tier owes anything.
 */
export function resolveAgeUpEvent(input: AgeUpInput): AgeUpEvent | null {
  if (input.rule.ageSource !== "CURRENT_AGE" || !input.dateOfBirth) return null;
  const dateOfBirth = calendarDateOfDateOnlyInstant(input.dateOfBirth);
  const crossing = birthdayCrossing(dateOfBirth, input.seasonYear);
  if (!crossing) return null;
  const tierOn = (day: CalendarDate) =>
    computeAgeTierWithSettings(input.dateOfBirth!, dateOnlyInstantOf(day), input.ageTierSettings);
  const fromTier = tierOn(getSeasonStartCalendarDate(input.seasonYear));
  const toTier = tierOn(crossing);
  if (fromTier === toTier) return null;
  // A member who joined in the season after their birthday was never billed
  // at the old tier for the months before they joined.
  const joined = input.joinedDate ? calendarDateOfDateOnlyInstant(input.joinedDate) : null;
  const ageUpDate =
    joined &&
    compareCalendarDates(joined, crossing) > 0 &&
    compareCalendarDates(joined, getSeasonEndCalendarDate(input.seasonYear)) <= 0
      ? joined
      : crossing;
  if (compareCalendarDates(ageUpDate, input.asOf) > 0) return null;
  const owesAt = (ageTier: AgeTier) =>
    resolveSubscriptionLiability({
      subscriptionBehavior: input.subscriptionBehavior,
      ageTier,
      seasonRowStatus: null,
      rule: input.rule,
      ageTierSettings: input.ageTierSettings,
    });
  const fromOwes = owesAt(fromTier);
  const toOwes = owesAt(toTier);
  if (!fromOwes && !toOwes) return null;
  return { ageUpDate, fromTier, toTier, fromOwes, toOwes };
}

/**
 * {@link resolveAgeUpEvent} priced. The difference is the to tier's annual fee
 * less the from tier's (0 for a tier that owes nothing), over the whole months
 * from the age-up month to season end; half-up rounding is applied to its size
 * and the sign put back, so a top-up and the mirror-image credit are the same
 * number of cents. Null when there is no event or the difference is 0.
 * `annualCentsFor` is only asked about a tier that owes.
 */
export function resolveAgeUpPart(
  input: AgeUpInput & { annualCentsFor: (ageTier: AgeTier) => number },
): AgeUpPart | null {
  const event = resolveAgeUpEvent(input);
  if (!event) return null;
  return priceAgeUpEvent(event, input.seasonYear, input.annualCentsFor);
}

/** The pricing half of {@link resolveAgeUpPart}, for a caller holding the event. */
export function priceAgeUpEvent(
  event: AgeUpEvent,
  seasonYear: number,
  annualCentsFor: (ageTier: AgeTier) => number,
): AgeUpPart | null {
  const fromAnnualCents = event.fromOwes ? annualCentsFor(event.fromTier) : 0;
  const toAnnualCents = event.toOwes ? annualCentsFor(event.toTier) : 0;
  const coveredMonths = remainingSeasonMonthsInclusive(seasonYear, event.ageUpDate);
  const annualDifference = toAnnualCents - fromAnnualCents;
  if (annualDifference === 0) return null;
  const size = prorateAnnualCents(Math.abs(annualDifference), coveredMonths);
  if (size === 0) return null;
  return {
    ...event,
    coveredMonths,
    fromAnnualCents,
    toAnnualCents,
    signedDifferenceCents: annualDifference > 0 ? size : -size,
  };
}
