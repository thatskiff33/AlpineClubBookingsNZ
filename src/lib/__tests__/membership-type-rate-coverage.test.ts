import { describe, expect, it } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import {
  computeMembershipTypeRateGaps,
  formatMembershipTypeRateGap,
  holdsHutRateRows,
  isKeyResolvedRateHolder,
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

  it("excludes an archived ordinary type, which prices only history", () => {
    // A club's own retired MEMBER_RATE type is reached only through a member's
    // assignment. Sending an officer to price it on every future season would
    // be work they cannot act on.
    const RETIRED = { key: "STUDENT", bookingBehavior: "MEMBER_RATE", isActive: false };
    expect(requiresHutRates({ ...RETIRED, isActive: true })).toBe(true);
    expect(requiresHutRates(RETIRED)).toBe(false);
  });

  it("still asks for rates on an ARCHIVED key-resolved holder, which still prices", () => {
    /*
      Archiving is one click and is offered for every membership type — the
      built-in guard on the membership-type route covers deletion only. But the
      engine resolves these two BY KEY with no active filter, so archiving does
      not take them out of pricing: `NON_MEMBER` still prices every non-member
      guest the club takes, and `FULL` still prices any member the engine cannot
      place plus every other-lodge guest.

      Before this, archiving `NON_MEMBER` dropped it out of the fee grid (which
      filters on this rule), so the officer could not set a rate, no new season
      got rows for it, NOTHING warned, and the first public booking in that
      season threw. The rule follows what prices.
    */
    expect(requiresHutRates({ ...NON_MEMBER, isActive: false })).toBe(true);
    expect(requiresHutRates({ ...FULL, isActive: false })).toBe(true);
    // Being key-resolved does not make a non-rate-bearing type owe rows.
    expect(isKeyResolvedRateHolder(ASSOCIATE)).toBe(false);
    expect(requiresHutRates({ ...ADMIN, isActive: false })).toBe(false);
  });

  it("still asks for rates on a key-resolved holder whose BEHAVIOUR was edited", () => {
    /*
      The other half of the same door, and the one that is easier to walk
      through by accident. `NON_MEMBER` holds its place in the rule by KEY, so
      an edit to its booking behaviour changes nothing here. `FULL` does not:
      before the two tests below were reordered it qualified solely through
      `bookingBehavior === "MEMBER_RATE"`, and that field is editable on a
      built-in type — the route's built-in guard covers deletion only, and the
      membership-types screen renders the behaviour selector for every type
      with the labels "Member rate" / "Non-member rate", which read like a
      pricing preference rather than a structural fact.

      Pick either other value for the built-in `FULL` and pricing is unchanged:
      `fullTypeId()` resolves it by key for an unplaceable member and for an
      other-lodge guest, and asks nothing about the row it found. But `FULL`
      would have dropped out of the coverage rule — out of the fee grid, out of
      any season created from it, out of the panel and out of readiness — while
      still throwing at pricing time. Exactly the #2933 defect, moved from the
      active flag onto the behaviour field.
    */
    for (const behavior of ["NON_MEMBER_RATE", "BLOCK_BOOKING"]) {
      expect(requiresHutRates({ ...FULL, bookingBehavior: behavior })).toBe(true);
      expect(requiresHutRates({ ...NON_MEMBER, bookingBehavior: behavior })).toBe(
        true,
      );
      // Archived AND re-behavioured: still priced by key, so still owed.
      expect(
        requiresHutRates({ ...FULL, bookingBehavior: behavior, isActive: false }),
      ).toBe(true);
    }
    // And the reorder did not make the behaviour test vacuous for everyone
    // else: an ordinary type re-labelled away from MEMBER_RATE stops owing.
    expect(
      requiresHutRates({
        key: "STUDENT",
        bookingBehavior: "NON_MEMBER_RATE",
        isActive: true,
      }),
    ).toBe(false);
  });

  it("lets the write surfaces save every row the warning asks for", () => {
    /*
      The read side (`requiresHutRates`) and the write side
      (`holdsHutRateRows`) must agree about the key-resolved pair, or the
      product contradicts itself: the Hut Fees panel names a missing rate and
      the season save — which validates through `holdsHutRateRows` in
      `season-rate-editor.ts`, as do the Xero item-code route and both
      config-transfer importers — refuses to store it, blocking the whole
      season save while the engine is at that moment pricing from that type.

      So: everything the read side asks for, the write side accepts.
    */
    const everyShape = ["MEMBER_RATE", "NON_MEMBER_RATE", "BLOCK_BOOKING"].flatMap(
      (bookingBehavior) =>
        [true, false].flatMap((isActive) =>
          ["FULL", "NON_MEMBER", "ASSOCIATE", "ADMIN", "STUDENT"].map((key) => ({
            key,
            bookingBehavior,
            isActive,
          })),
        ),
    );
    for (const type of everyShape) {
      if (requiresHutRates(type)) {
        expect(holdsHutRateRows(type), `${type.key}/${type.bookingBehavior}`).toBe(
          true,
        );
      }
    }

    // The write side is deliberately WIDER in exactly one direction: activity
    // is a read-side scoping question and has never gated a write, so an
    // archived MEMBER_RATE type's rows stay savable pricing history.
    const RETIRED = { key: "STUDENT", bookingBehavior: "MEMBER_RATE", isActive: false };
    expect(requiresHutRates(RETIRED)).toBe(false);
    expect(holdsHutRateRows(RETIRED)).toBe(true);

    // And it is not wider than that: a type whose rows nothing reads still
    // cannot have any saved.
    expect(holdsHutRateRows(ASSOCIATE)).toBe(false);
    expect(holdsHutRateRows(ADMIN)).toBe(false);
  });

  it("selects exactly the types that owe rates, in the order given", () => {
    expect(
      selectTypesRequiringHutRates([
        ADMIN,
        FULL,
        ASSOCIATE,
        NON_MEMBER,
        // A club's own retired type: not key-resolved, so it is left out.
        { key: "STUDENT", bookingBehavior: "MEMBER_RATE", isActive: false },
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

  it("reads a row's key and never its amount, so a $0.00 rate is covered", () => {
    /*
      Coverage is presence, not price. A club that genuinely charges a tier
      $0.00 has configured that tier and must not be told it is missing;
      equally, a gap is never closed by assuming zero.

      The row below CARRIES an amount of zero, which is what makes this
      discriminating rather than a restatement of the type: a coverage rule that
      grew an amount test and read `0` as "not really set" fails here. The
      complementary half — that nothing manufactures a zero-cent row nobody
      typed — is the form's, and is pinned in
      `hut-fees-missing-rates.test.tsx`.
    */
    const zeroCentRow = {
      seasonId: "s-1",
      membershipTypeId: "type-flat",
      ageTier: null,
      pricePerNightCents: 0,
    };
    expect(
      computeMembershipTypeRateGaps({
        types: [{ id: "type-flat", name: "Flat", ageGroupsApply: false }],
        seasons,
        rateRows: [zeroCentRow],
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
