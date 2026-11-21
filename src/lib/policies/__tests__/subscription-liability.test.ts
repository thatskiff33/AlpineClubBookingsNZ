import type {
  AgeTier,
  MembershipTypeSubscriptionBehavior,
  SubscriptionStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import { AGE_TIER_DEFAULTS } from "@/lib/policies/age-tier";
import {
  NOT_CHOSEN_LIABILITY_SETTINGS,
  getSeasonEndCalendarDate,
  getSeasonEndDate,
  hasChosenLiabilityRule,
  liabilityRuleFor,
  resolveLiabilityAgeTier,
  resolveMemberSubscriptionLiability,
  type SubscriptionLiabilitySettings,
  type SubscriptionLiabilitySide,
} from "@/lib/policies/subscription";

// #5190: the one liability rule billing and booking access share. Age tiers are
// the platform defaults: INFANT and CHILD exempt, YOUTH and ADULT liable. The
// default financial year starts 1 April, so season 2026 runs 2026-04-01 to
// 2027-03-31.
const tiers = AGE_TIER_DEFAULTS;
const SEASON = 2026;

/** Turns 10 (CHILD → YOUTH) on 15 Jan 2027: a child at season start, a youth at season end. */
const agesUpMidSeason = { dateOfBirth: new Date("2017-01-15T00:00:00.000Z"), ageTier: "CHILD" as AgeTier };
/** 30 all season, but the stored tier still reads CHILD (a stale record). */
const adultStoredAsChild = { dateOfBirth: new Date("1996-06-01T00:00:00.000Z"), ageTier: "CHILD" as AgeTier };
/** 7 all season. */
const child = { dateOfBirth: new Date("2019-06-01T00:00:00.000Z"), ageTier: "CHILD" as AgeTier };
/** No date of birth: the stored tier decides on every source. */
const childNoDob = { dateOfBirth: null, ageTier: "CHILD" as AgeTier };

const settings = (
  requiredTypeAgeRule: SubscriptionLiabilitySettings["requiredTypeAgeRule"],
  liabilityAgeSource: SubscriptionLiabilitySettings["liabilityAgeSource"],
): SubscriptionLiabilitySettings => ({ requiredTypeAgeRule, liabilityAgeSource });

function owes(input: {
  behavior: MembershipTypeSubscriptionBehavior | null;
  member: { dateOfBirth: Date | null; ageTier: AgeTier } | null;
  row?: SubscriptionStatus | null;
  settings: SubscriptionLiabilitySettings;
  side: SubscriptionLiabilitySide;
}): boolean {
  return resolveMemberSubscriptionLiability({
    subscriptionBehavior: input.behavior,
    member: input.member,
    seasonRowStatus: input.row ?? null,
    seasonYear: SEASON,
    rule: liabilityRuleFor(input.side, input.settings),
    ageTierSettings: tiers,
  }).owes;
}

describe("liabilityRuleFor (#5190)", () => {
  it("keeps each side's pre-#5190 rule while the club has not chosen", () => {
    expect(liabilityRuleFor("billing", NOT_CHOSEN_LIABILITY_SETTINGS)).toEqual({
      requiredTypeAgeRule: "ALWAYS_OWES",
      ageSource: "SEASON_START",
      seasonRowExempts: false,
    });
    expect(liabilityRuleFor("access", NOT_CHOSEN_LIABILITY_SETTINGS)).toEqual({
      requiredTypeAgeRule: "AGE_TIER_EXEMPTS",
      ageSource: "STORED_TIER",
      seasonRowExempts: true,
    });
  });

  it.each([
    settings("ALWAYS_OWES", "NOT_CHOSEN"),
    settings("NOT_CHOSEN", "SEASON_END"),
    // Refused by every writer until part-season invoices ship (#5190 PR 3).
    settings("AGE_TIER_EXEMPTS", "CURRENT_AGE"),
  ])("treats a half-made or not-yet-open choice as not chosen: %o", (partial) => {
    expect(hasChosenLiabilityRule(partial)).toBe(false);
    expect(liabilityRuleFor("billing", partial)).toEqual(
      liabilityRuleFor("billing", NOT_CHOSEN_LIABILITY_SETTINGS),
    );
    expect(liabilityRuleFor("access", partial)).toEqual(
      liabilityRuleFor("access", NOT_CHOSEN_LIABILITY_SETTINGS),
    );
  });

  it.each([
    settings("ALWAYS_OWES", "SEASON_START"),
    settings("ALWAYS_OWES", "SEASON_END"),
    settings("AGE_TIER_EXEMPTS", "SEASON_START"),
    settings("AGE_TIER_EXEMPTS", "SEASON_END"),
  ])("gives both sides the identical rule once chosen, and the season row exempts nobody: %o", (chosen) => {
    const billing = liabilityRuleFor("billing", chosen);
    expect(liabilityRuleFor("access", chosen)).toEqual(billing);
    expect(billing).toEqual({
      requiredTypeAgeRule: chosen.requiredTypeAgeRule,
      ageSource: chosen.liabilityAgeSource,
      seasonRowExempts: false,
    });
  });
});

describe("resolveLiabilityAgeTier (#5190)", () => {
  it("ends the season the day before the next one starts", () => {
    expect(getSeasonEndDate(SEASON).toISOString()).toBe("2027-03-31T00:00:00.000Z");
    // The calendar-day form the SQL filter reads is the same day (INV-SSOT).
    expect(getSeasonEndCalendarDate(SEASON)).toBe("2027-03-31");
  });

  it.each([
    ["SEASON_START", "CHILD"],
    ["SEASON_END", "YOUTH"],
    ["STORED_TIER", "CHILD"],
  ] as const)("reads %s as %s for a member who turns 10 mid-season", (source, expected) => {
    expect(resolveLiabilityAgeTier({
      source,
      dateOfBirth: agesUpMidSeason.dateOfBirth,
      storedAgeTier: agesUpMidSeason.ageTier,
      seasonYear: SEASON,
      ageTierSettings: tiers,
    })).toBe(expected);
  });

  it.each(["SEASON_START", "SEASON_END"] as const)(
    "falls back to the stored tier with no date of birth (%s)",
    (source) => {
      expect(resolveLiabilityAgeTier({
        source,
        dateOfBirth: null,
        storedAgeTier: "YOUTH",
        seasonYear: SEASON,
        ageTierSettings: tiers,
      })).toBe("YOUTH");
    },
  );
});

describe("resolveSubscriptionLiability: the rule table (#5190)", () => {
  const NOT_CHOSEN = NOT_CHOSEN_LIABILITY_SETTINGS;
  const owesStart = settings("ALWAYS_OWES", "SEASON_START");
  const owesEnd = settings("ALWAYS_OWES", "SEASON_END");
  const exemptsStart = settings("AGE_TIER_EXEMPTS", "SEASON_START");
  const exemptsEnd = settings("AGE_TIER_EXEMPTS", "SEASON_END");

  // [case, behaviour, member, row, settings, billing owes, access owes]
  const table: Array<[
    string,
    MembershipTypeSubscriptionBehavior | null,
    { dateOfBirth: Date | null; ageTier: AgeTier } | null,
    SubscriptionStatus | null,
    SubscriptionLiabilitySettings,
    boolean,
    boolean,
  ]> = [
    // A NOT_REQUIRED type never owes, under any setting, on either side.
    ["NOT_REQUIRED type, adult", "NOT_REQUIRED", adultStoredAsChild, null, NOT_CHOSEN, false, false],
    ["NOT_REQUIRED type, chosen", "NOT_REQUIRED", adultStoredAsChild, null, owesEnd, false, false],

    // Edge 1: a REQUIRED-type child. NOT_CHOSEN keeps the split: billing charges, access exempts.
    ["Edge 1, not chosen", "REQUIRED", child, null, NOT_CHOSEN, true, false],
    ["Edge 1, always owes", "REQUIRED", child, null, owesStart, true, true],
    ["Edge 1, age tier exempts", "REQUIRED", child, null, exemptsStart, false, false],
    ["Edge 1, age tier exempts, no DOB", "REQUIRED", childNoDob, null, exemptsEnd, false, false],
    ["REQUIRED adult, age tier exempts", "REQUIRED", { ...child, dateOfBirth: adultStoredAsChild.dateOfBirth }, null, exemptsStart, true, true],

    // Edge 2: a BASED_ON_AGE_TIER adult with a saved NOT_REQUIRED row.
    // NOT_CHOSEN: billing ignores the row (and bills by season-start age), access honours it.
    ["Edge 2, not chosen", "BASED_ON_AGE_TIER", { ...adultStoredAsChild, ageTier: "ADULT" }, "NOT_REQUIRED", NOT_CHOSEN, true, false],
    ["Edge 2, chosen: age wins", "BASED_ON_AGE_TIER", { ...adultStoredAsChild, ageTier: "ADULT" }, "NOT_REQUIRED", exemptsStart, true, true],
    ["Edge 2, chosen, always owes: age wins", "BASED_ON_AGE_TIER", { ...adultStoredAsChild, ageTier: "ADULT" }, "NOT_REQUIRED", owesEnd, true, true],
    // The row still never makes a tier-exempt child owe.
    ["exempt child with a NOT_REQUIRED row, chosen", "BASED_ON_AGE_TIER", child, "NOT_REQUIRED", owesStart, false, false],

    // Which age: a BASED_ON_AGE_TIER child who turns 10 (liable) mid-season.
    ["age source, not chosen", "BASED_ON_AGE_TIER", agesUpMidSeason, null, NOT_CHOSEN, false, false],
    ["age source, season start", "BASED_ON_AGE_TIER", agesUpMidSeason, null, exemptsStart, false, false],
    ["age source, season end", "BASED_ON_AGE_TIER", agesUpMidSeason, null, exemptsEnd, true, true],
    // A stale stored tier: billing reads the DOB at season start, access the stored tier, until chosen.
    ["stale stored tier, not chosen", "BASED_ON_AGE_TIER", adultStoredAsChild, null, NOT_CHOSEN, true, false],
    ["stale stored tier, chosen", "BASED_ON_AGE_TIER", adultStoredAsChild, null, exemptsStart, true, true],

    // No Member row, or no membership type: owing, never silently exempt.
    ["no Member row, not chosen", "BASED_ON_AGE_TIER", null, null, NOT_CHOSEN, true, true],
    ["no Member row, chosen", "REQUIRED", null, null, exemptsEnd, true, true],
    ["no type resolved, child, not chosen", null, child, null, NOT_CHOSEN, true, false],
    ["no type resolved, child, age tier exempts", null, child, null, exemptsStart, false, false],
  ];

  it.each(table)("%s", (_case, behavior, member, row, chosen, billingOwes, accessOwes) => {
    expect(owes({ behavior, member, row, settings: chosen, side: "billing" })).toBe(billingOwes);
    expect(owes({ behavior, member, row, settings: chosen, side: "access" })).toBe(accessOwes);
  });

  it("answers identically on both sides for every chosen pair, behaviour, member and row", () => {
    const members = [agesUpMidSeason, adultStoredAsChild, child, childNoDob, null];
    const behaviors: Array<MembershipTypeSubscriptionBehavior | null> = ["REQUIRED", "BASED_ON_AGE_TIER", "NOT_REQUIRED", null];
    const rows: Array<SubscriptionStatus | null> = [null, "NOT_REQUIRED", "NOT_INVOICED", "PAID"];
    for (const chosen of [owesStart, owesEnd, exemptsStart, exemptsEnd]) {
      for (const behavior of behaviors) {
        for (const member of members) {
          for (const row of rows) {
            expect(owes({ behavior, member, row, settings: chosen, side: "billing" }))
              .toBe(owes({ behavior, member, row, settings: chosen, side: "access" }));
          }
        }
      }
    }
  });
});
