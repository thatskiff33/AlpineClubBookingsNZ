import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  SubscriptionLiabilityAgeSource,
  SubscriptionRequiredTypeAgeRule,
  SubscriptionStatus,
} from "@prisma/client";
import {
  addCalendarDays,
  dateOnlyInstantOf,
  type CalendarDate,
} from "@/lib/club-time";
import {
  computeAgeTierWithSettings,
  getSeasonStartCalendarDate,
  getSeasonStartDate,
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
 * The age sources a club may choose today. `CURRENT_AGE` needs part-season
 * invoices for a member who ages up mid-season, which ship in #5190's third
 * pull request; until then every writer refuses it, and a stored value read
 * here counts as not chosen (the pre-#5190 rules — the direction that changes
 * nobody's bill or booking).
 */
export const CHOOSABLE_LIABILITY_AGE_SOURCES = [
  "SEASON_START",
  "SEASON_END",
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

/** The club has chosen its rule: both answers set, to values open for choice. */
export function hasChosenLiabilityRule(
  settings: SubscriptionLiabilitySettings,
): boolean {
  return (
    settings.requiredTypeAgeRule !== "NOT_CHOSEN" &&
    isChoosableLiabilityAgeSource(settings.liabilityAgeSource)
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
  if (hasChosenLiabilityRule(settings)) {
    return {
      requiredTypeAgeRule:
        settings.requiredTypeAgeRule === "AGE_TIER_EXEMPTS"
          ? "AGE_TIER_EXEMPTS"
          : "ALWAYS_OWES",
      ageSource: settings.liabilityAgeSource as ChoosableLiabilityAgeSource,
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
 * The age tier that decides liability for one member and season. A member with
 * no date of birth keeps their stored tier, whatever the source.
 */
export function resolveLiabilityAgeTier(input: {
  source: LiabilityAgeTierSource;
  dateOfBirth: Date | null | undefined;
  storedAgeTier: AgeTier | null | undefined;
  seasonYear: number;
  ageTierSettings: AgeTierSettingData[];
}): AgeTier | null {
  const storedAgeTier = input.storedAgeTier ?? null;
  if (input.source === "STORED_TIER" || !input.dateOfBirth) {
    return storedAgeTier;
  }
  const referenceDate =
    input.source === "SEASON_START"
      ? getSeasonStartDate(input.seasonYear)
      : getSeasonEndDate(input.seasonYear);
  return computeAgeTierWithSettings(
    input.dateOfBirth,
    referenceDate,
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
  rule: SubscriptionLiabilityRule;
  ageTierSettings: AgeTierSettingData[];
}): { owes: boolean; ageTier: AgeTier | null } {
  const ageTier = input.member
    ? resolveLiabilityAgeTier({
        source: input.rule.ageSource,
        dateOfBirth: input.member.dateOfBirth,
        storedAgeTier: input.member.ageTier,
        seasonYear: input.seasonYear,
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
