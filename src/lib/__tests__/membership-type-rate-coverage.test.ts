import { describe, expect, it } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import {
  computeMembershipTypeRateGaps,
  formatMembershipTypeRateGap,
  isRateBearingMembershipType,
  requiresHutRates,
  seasonRequiresRates,
  selectTypesRequiringHutRates,
} from "@/lib/membership-type-rate-coverage";

/**
 * The one rule about which membership types owe hut rates, and which of those
 * rates are absent (`INV-MOD-007`, #1930 E4, #2933).
 *
 * The gap cases moved here from `setup-readiness.test.ts` with the function
 * itself; the scope cases are new, and they are the ones #2933 is about — the
 * readiness snapshot used to ask the database for `MEMBER_RATE` types alone, so
 * the built-in `NON_MEMBER` type, which prices every non-member guest the club
 * takes, was the one rate-bearing type nobody was warned about.
 */

const FULL = { key: "FULL", bookingBehavior: "MEMBER_RATE", isActive: true };
const NON_MEMBER = {
  key: "NON_MEMBER",
  bookingBehavior: "NON_MEMBER_RATE",
  isActive: true,
};
const ASSOCIATE = {
  key: "ASSOCIATE",
  bookingBehavior: "NON_MEMBER_RATE",
  isActive: true,
};
const ADMIN = { key: "ADMIN", bookingBehavior: "BLOCK_BOOKING", isActive: true };

describe("which membership types carry their own hut rates (INV-MOD-007)", () => {
  it("is every MEMBER_RATE type plus the built-in NON_MEMBER type", () => {
    expect(isRateBearingMembershipType(FULL)).toBe(true);
    // The whole reason the rule is a function: NON_MEMBER's behaviour is
    // NON_MEMBER_RATE like ASSOCIATE's, and it is the one that owns rows.
    expect(isRateBearingMembershipType(NON_MEMBER)).toBe(true);
  });

  it("is NOT any other NON_MEMBER_RATE type, and not a BLOCK_BOOKING type", () => {
    // ASSOCIATE prices from the NON_MEMBER rows; ADMIN does not book at all.
    // Warning about rates for either would be a false positive about rows the
    // resolver never reads.
    expect(isRateBearingMembershipType(ASSOCIATE)).toBe(false);
    expect(isRateBearingMembershipType(ADMIN)).toBe(false);
  });

  it("excludes an archived type, which prices only history", () => {
    expect(requiresHutRates(FULL)).toBe(true);
    expect(requiresHutRates({ ...FULL, isActive: false })).toBe(false);
    expect(requiresHutRates({ ...NON_MEMBER, isActive: false })).toBe(false);
  });

  it("selects exactly the types that owe rates, in the order given", () => {
    expect(
      selectTypesRequiringHutRates([
        ADMIN,
        FULL,
        ASSOCIATE,
        NON_MEMBER,
        { ...FULL, key: "LIFE", isActive: false },
      ]),
    ).toEqual([FULL, NON_MEMBER]);
  });
});

describe("which seasons a missing rate would actually refuse a booking on", () => {
  // The frozen clock puts "today" at 2026-07-01; every edge below is written
  // against that instant, never the real calendar.
  const today = requireCalendarDate("2026-07-01");

  it("includes an active season, and a future one whether active or not", () => {
    expect(
      seasonRequiresRates(
        { active: true, endDate: requireCalendarDate("2026-09-30") },
        today,
      ),
    ).toBe(true);
    expect(
      seasonRequiresRates(
        { active: false, endDate: requireCalendarDate("2026-09-30") },
        today,
      ),
    ).toBe(true);
  });

  it("includes a season ending today — tonight is still bookable", () => {
    expect(
      seasonRequiresRates({ active: false, endDate: today }, today),
    ).toBe(true);
  });

  it("excludes a closed past season, which nobody can act on", () => {
    expect(
      seasonRequiresRates(
        { active: false, endDate: requireCalendarDate("2026-06-30") },
        today,
      ),
    ).toBe(false);
    // Still flagged while it is switched on, because an active season is what
    // the booking engine consults.
    expect(
      seasonRequiresRates(
        { active: true, endDate: requireCalendarDate("2026-06-30") },
        today,
      ),
    ).toBe(true);
  });
});

describe("tier-aware membership-type rate gaps (#1930, E4 review F7)", () => {
  const FOUR_TIERS = ["INFANT", "CHILD", "YOUTH", "ADULT"] as const;
  const seasons = [{ id: "s-1", name: "Winter 2026" }];

  it("scopes coverage to the club's configured tier subset (#2009)", () => {
    const types = [{ id: "type-full", name: "Full Member", ageGroupsApply: true }];
    // A CHILD + ADULT club that has priced BOTH its present tiers has no gap,
    // even though INFANT and YOUTH have no rows (no guest ever classifies into
    // them). Without the subset scoping this would falsely report a gap.
    const rateRows = [
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "CHILD" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "ADULT" },
    ];
    expect(
      computeMembershipTypeRateGaps({
        types,
        seasons,
        rateRows,
        bookableAgeTiers: ["CHILD", "ADULT"],
      }),
    ).toEqual([]);
    // Against the full four it WOULD flag the absent tiers, proving the scoping
    // is what suppresses the false positive.
    expect(
      computeMembershipTypeRateGaps({
        types,
        seasons,
        rateRows,
        bookableAgeTiers: FOUR_TIERS,
      }).map(formatMembershipTypeRateGap),
    ).toEqual(["Full Member — Winter 2026 (missing INFANT, YOUTH)"]);
  });

  it("reads partial tiers, the flat fallback, and the flat-type shape anomaly", () => {
    const types = [
      { id: "type-full", name: "Full Member", ageGroupsApply: true },
      { id: "type-club", name: "Club", ageGroupsApply: true },
      { id: "type-flat-covered", name: "Flat Fallback", ageGroupsApply: true },
      { id: "type-school", name: "School Group", ageGroupsApply: false },
      { id: "type-school-bad", name: "School (misconfigured)", ageGroupsApply: false },
    ];
    const rateRows = [
      // Full: complete per-tier coverage — no gap.
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "INFANT" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "CHILD" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "YOUTH" },
      { seasonId: "s-1", membershipTypeId: "type-full", ageTier: "ADULT" },
      // Club: PARTIAL tier coverage, no flat row — a booking for a missing
      // tier hard-throws, so this is a gap (the pre-fix pair-existence check
      // missed exactly this case).
      { seasonId: "s-1", membershipTypeId: "type-club", ageTier: "ADULT" },
      { seasonId: "s-1", membershipTypeId: "type-club", ageTier: "YOUTH" },
      // Flat Fallback: age-keyed type covered entirely by its flat row (the
      // engine falls back exact-tier -> flat) — no gap.
      { seasonId: "s-1", membershipTypeId: "type-flat-covered", ageTier: null },
      // School Group: flat type with its flat row — no gap.
      { seasonId: "s-1", membershipTypeId: "type-school", ageTier: null },
      // School (misconfigured): flat type with ONLY tier rows — shape anomaly,
      // flagged as missing its flat rate.
      { seasonId: "s-1", membershipTypeId: "type-school-bad", ageTier: "ADULT" },
    ];

    const gaps = computeMembershipTypeRateGaps({
      types,
      seasons,
      rateRows,
      bookableAgeTiers: FOUR_TIERS,
    });
    expect(gaps.map(formatMembershipTypeRateGap)).toEqual([
      "Club — Winter 2026 (missing INFANT, CHILD)",
      "School (misconfigured) — Winter 2026 (missing flat all-ages rate)",
    ]);
    // The structured shape is what the admin screen renders from; the string
    // above is what the readiness step lists. Both come from this one result.
    expect(gaps[0]).toEqual({
      membershipTypeId: "type-club",
      membershipTypeName: "Club",
      seasonId: "s-1",
      seasonName: "Winter 2026",
      missing: { kind: "tiers", tiers: ["INFANT", "CHILD"] },
    });
    expect(gaps[1]?.missing).toEqual({ kind: "flat" });
  });

  it("reports a type with no rows at all as missing every bookable tier", () => {
    expect(
      computeMembershipTypeRateGaps({
        types: [{ id: "type-new", name: "New Type", ageGroupsApply: true }],
        seasons,
        rateRows: [],
        bookableAgeTiers: FOUR_TIERS,
      }).map(formatMembershipTypeRateGap),
    ).toEqual(["New Type — Winter 2026 (missing INFANT, CHILD, YOUTH, ADULT)"]);
  });

  it("never invents a rate: a zero-cent row is configuration, not a gap", () => {
    // The amount is not read here at all — only the row's key. A club that
    // genuinely prices a tier at $0.00 has configured it, and must not be told
    // it is missing; equally, a gap is never closed by assuming zero.
    expect(
      computeMembershipTypeRateGaps({
        types: [{ id: "type-flat", name: "Flat", ageGroupsApply: false }],
        seasons,
        rateRows: [
          { seasonId: "s-1", membershipTypeId: "type-flat", ageTier: null },
        ],
        bookableAgeTiers: FOUR_TIERS,
      }),
    ).toEqual([]);
  });

  it("does not let one season's rows cover another season", () => {
    expect(
      computeMembershipTypeRateGaps({
        types: [{ id: "type-flat", name: "Flat", ageGroupsApply: false }],
        seasons: [...seasons, { id: "s-2", name: "Summer 2026" }],
        rateRows: [
          { seasonId: "s-1", membershipTypeId: "type-flat", ageTier: null },
        ],
        bookableAgeTiers: FOUR_TIERS,
      }).map(formatMembershipTypeRateGap),
    ).toEqual(["Flat — Summer 2026 (missing flat all-ages rate)"]);
  });
});
