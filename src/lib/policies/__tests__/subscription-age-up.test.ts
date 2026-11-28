import type { AgeTier, MembershipTypeSubscriptionBehavior } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { CalendarDate } from "@/lib/club-time";
import { AGE_TIER_DEFAULTS, type AgeTierSettingData } from "@/lib/policies/age-tier";
import {
  liabilityRuleFor,
  prorateAnnualCents,
  remainingSeasonMonthsInclusive,
  resolveAgeUpEvent,
  resolveAgeUpPart,
  type SubscriptionLiabilitySettings,
} from "@/lib/policies/subscription";

// #5190 PR 3: a mid-season age-up under "Age today" (owner decisions 20 and
// 27 Nov 2026). The default financial year starts 1 April, so season 2026 runs
// 2026-04-01 to 2027-03-31 and season 2027 runs 2027-04-01 to 2028-03-31.
const AGE_TODAY: SubscriptionLiabilitySettings = {
  requiredTypeAgeRule: "AGE_TIER_EXEMPTS",
  liabilityAgeSource: "CURRENT_AGE",
};
const rule = liabilityRuleFor("billing", AGE_TODAY);

/** A two-threshold ladder: CHILD 5-9 exempt, YOUTH 10-17 and ADULT 18+ owe. */
const ladder = AGE_TIER_DEFAULTS;

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const day = (value: string) => value as CalendarDate;

function event(input: {
  dateOfBirth: string | null;
  joinedDate?: string | null;
  seasonYear?: number;
  asOf?: string;
  ageTierSettings?: AgeTierSettingData[];
  subscriptionBehavior?: MembershipTypeSubscriptionBehavior;
  settings?: SubscriptionLiabilitySettings;
}) {
  return resolveAgeUpEvent({
    dateOfBirth: input.dateOfBirth ? date(input.dateOfBirth) : null,
    joinedDate: input.joinedDate ? date(input.joinedDate) : null,
    seasonYear: input.seasonYear ?? 2026,
    asOf: day(input.asOf ?? "2027-03-31"),
    rule: liabilityRuleFor("billing", input.settings ?? AGE_TODAY),
    subscriptionBehavior: input.subscriptionBehavior ?? "BASED_ON_AGE_TIER",
    ageTierSettings: input.ageTierSettings ?? ladder,
  });
}

describe("part-season months and cents (#5190 PR 3, INV-MONEY-051)", () => {
  it.each([
    ["2026-04-01", 12],
    ["2026-04-30", 12],
    ["2027-01-01", 3],
    ["2027-01-31", 3],
    ["2027-03-31", 1],
  ] as const)("an age-up on %s covers %i whole months, its own month included", (from, months) => {
    expect(remainingSeasonMonthsInclusive(2026, day(from))).toBe(months);
  });

  it("rounds a part-season amount half-up to the cent", () => {
    // 1002 x 3 / 12 = 250.5 cents.
    expect(prorateAnnualCents(1002, 3)).toBe(251);
    // 1001 x 3 / 12 = 250.25 cents.
    expect(prorateAnnualCents(1001, 3)).toBe(250);
  });
});

describe("resolveAgeUpEvent (#5190 PR 3)", () => {
  it("finds a birthday on the first of a month", () => {
    expect(event({ dateOfBirth: "2017-01-01" })).toEqual({
      ageUpDate: "2027-01-01",
      fromTier: "CHILD",
      toTier: "YOUTH",
      fromOwes: false,
      toOwes: true,
    });
  });

  it("finds a birthday on the last day of a month", () => {
    expect(event({ dateOfBirth: "2016-10-31" })?.ageUpDate).toBe("2026-10-31");
  });

  it("finds a birthday on the season's last day", () => {
    expect(event({ dateOfBirth: "2017-03-31" })?.ageUpDate).toBe("2027-03-31");
  });

  it("has no age-up for a birthday on the season's first day: the member is already that age all season", () => {
    expect(event({ dateOfBirth: "2016-04-01" })).toBeNull();
    // ...and turns 10 on the NEXT season's first day.
    expect(event({ dateOfBirth: "2017-04-01" })).toBeNull();
  });

  it("puts a 29 February birthday on 1 March in a season with no 29 February", () => {
    // Season 2025 runs 2025-04-01 to 2026-03-31; 2026 has no 29 February.
    expect(event({ dateOfBirth: "2016-02-29", seasonYear: 2025, asOf: "2026-03-31" })?.ageUpDate).toBe("2026-03-01");
  });

  it("keeps a 29 February birthday on 29 February in a leap season", () => {
    // Season 2027 runs 2027-04-01 to 2028-03-31; the member turns 16 on 2028-02-29.
    const adultAt16 = AGE_TIER_DEFAULTS.map((tier) =>
      tier.tier === "YOUTH" ? { ...tier, maxAge: 15 } : tier.tier === "ADULT" ? { ...tier, minAge: 16 } : tier);
    expect(event({ dateOfBirth: "2012-02-29", seasonYear: 2027, asOf: "2028-03-31", ageTierSettings: adultAt16 }))
      .toMatchObject({ ageUpDate: "2028-02-29", fromTier: "YOUTH", toTier: "ADULT" });
  });

  it("has no age-up without a date of birth", () => {
    expect(event({ dateOfBirth: null })).toBeNull();
  });

  it("has none under any other age source", () => {
    for (const liabilityAgeSource of ["SEASON_START", "SEASON_END", "NOT_CHOSEN"] as const) {
      expect(event({ dateOfBirth: "2017-01-01", settings: { ...AGE_TODAY, liabilityAgeSource } })).toBeNull();
    }
  });

  it("has not happened before the decision day, and has on it", () => {
    expect(event({ dateOfBirth: "2017-01-15", asOf: "2027-01-14" })).toBeNull();
    expect(event({ dateOfBirth: "2017-01-15", asOf: "2027-01-15" })?.ageUpDate).toBe("2027-01-15");
  });

  it("ages a member who joined after their birthday up on the day they joined", () => {
    expect(event({ dateOfBirth: "2017-01-15", joinedDate: "2027-02-10" })?.ageUpDate).toBe("2027-02-10");
    // A join before the birthday, or outside the season, changes nothing.
    expect(event({ dateOfBirth: "2017-01-15", joinedDate: "2026-12-01" })?.ageUpDate).toBe("2027-01-15");
    expect(event({ dateOfBirth: "2017-01-15", joinedDate: "2020-05-01" })?.ageUpDate).toBe("2027-01-15");
  });

  describe("a two-threshold ladder crosses only one threshold in a season", () => {
    it("CHILD to YOUTH: from not owing to owing", () => {
      expect(event({ dateOfBirth: "2016-09-10" })).toMatchObject({ fromTier: "CHILD", toTier: "YOUTH", fromOwes: false, toOwes: true });
    });

    it("YOUTH to ADULT: owing at both tiers", () => {
      expect(event({ dateOfBirth: "2008-09-10" })).toMatchObject({ fromTier: "YOUTH", toTier: "ADULT", fromOwes: true, toOwes: true });
    });

    it("a birthday inside one tier is no age-up", () => {
      expect(event({ dateOfBirth: "2012-09-10" })).toBeNull();
    });

    it("INFANT to CHILD: neither tier owes, so nothing to settle", () => {
      expect(event({ dateOfBirth: "2021-09-10" })).toBeNull();
    });
  });

  it("follows the club's required-type rule: a REQUIRED type always owing has no liability change", () => {
    expect(event({
      dateOfBirth: "2016-09-10",
      subscriptionBehavior: "REQUIRED",
      settings: { requiredTypeAgeRule: "ALWAYS_OWES", liabilityAgeSource: "CURRENT_AGE" },
    })).toMatchObject({ fromOwes: true, toOwes: true });
  });
});

describe("resolveAgeUpPart (#5190 PR 3)", () => {
  const fees: Partial<Record<AgeTier, number>> = { YOUTH: 12_000, ADULT: 24_000 };
  const part = (dateOfBirth: string, annual: Partial<Record<AgeTier, number>> = fees, settings = ladder) =>
    resolveAgeUpPart({
      dateOfBirth: date(dateOfBirth),
      joinedDate: null,
      seasonYear: 2026,
      asOf: day("2027-03-31"),
      rule,
      subscriptionBehavior: "BASED_ON_AGE_TIER",
      ageTierSettings: settings,
      annualCentsFor: (tier) => annual[tier] ?? 0,
    });

  it("bills a member who ages into owing the new tier's fee for the months left", () => {
    // Turns 10 on 2027-01-01: January to March, 3 months of 12 000.
    expect(part("2017-01-01")).toMatchObject({ coveredMonths: 3, fromAnnualCents: 0, toAnnualCents: 12_000, signedDifferenceCents: 3_000 });
  });

  it("tops up a move to a dearer tier by the difference for the months left", () => {
    // Turns 18 on 2026-10-31: October to March, 6 months of (24 000 - 12 000).
    expect(part("2008-10-31")).toMatchObject({ coveredMonths: 6, signedDifferenceCents: 6_000 });
  });

  it("credits a move to a cheaper tier, rounding the size half-up and keeping the sign", () => {
    // ADULT dearer than... a cheaper ADULT fee: 1 002 less over 3 months is 250.5 cents.
    expect(part("2009-01-01", { YOUTH: 2_004, ADULT: 1_002 })).toMatchObject({ coveredMonths: 3, signedDifferenceCents: -251 });
    expect(part("2009-01-01", { YOUTH: 1_002, ADULT: 2_004 })).toMatchObject({ signedDifferenceCents: 251 });
  });

  it("credits a move to a tier that owes nothing, for the from tier's whole fee", () => {
    const youthExempt = ladder.map((tier) => tier.tier === "ADULT" ? { ...tier, subscriptionRequiredForBooking: false } : tier);
    expect(part("2009-01-01", fees, youthExempt)).toMatchObject({ toOwes: false, toAnnualCents: 0, signedDifferenceCents: -3_000 });
  });

  it("is null when the two tiers cost the same", () => {
    expect(part("2009-01-01", { YOUTH: 12_000, ADULT: 12_000 })).toBeNull();
  });
});
