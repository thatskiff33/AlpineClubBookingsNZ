import { describe, expect, it } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type GuestInput,
  type SeasonRateData,
} from "@/lib/policies/pricing";
import { priceDeferredNonMemberPortion } from "@/lib/policies/booking-route-decisions";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import {
  sumDeferredGuestPortionCents,
  type DeferredGuestPortionGuest,
} from "@/lib/deferred-guest-portion";
import { seasonYearOfStoredDate } from "@/lib/financial-year";

// A minimal membership-type policy db (#1930/#2003): non-members resolve to the
// built-in NON_MEMBER type, memberless members to FULL, and the group discount
// substitutes the FULL rate for non-members on qualifying nights.
function makeFakePolicyDb(types: Array<{ id: string; key: string }>) {
  return {
    member: { findMany: async () => [] },
    seasonalMembershipAssignment: { findMany: async () => [] },
    membershipType: {
      findMany: async (args: { where: { key: { in: string[] } } }) =>
        types.filter((type) => args.where.key.in.includes(type.key)),
    },
  };
}

// #2003 — the deferred non-member "guest portion" figure is shown on two
// surfaces (the wizard review banner and the pay step). These tests pin that a
// SINGLE owner computes it, and that its value equals the server figure the pay
// step shows (the split child's finalPriceCents) for the same composition —
// including a composition where naive dual-sourcing could have drifted.

const MEMBER_TYPE = "member-type";
const NON_MEMBER_TYPE = "non-member-type";

describe("sumDeferredGuestPortionCents (single owner of the figure, #2003)", () => {
  it("sums only the non-member guests' priced totals, in integer cents", () => {
    const guests: DeferredGuestPortionGuest[] = [
      { isMember: true, priceCents: 24000 },
      { isMember: false, priceCents: 12999 },
      { isMember: false, priceCents: 8331 },
    ];
    expect(sumDeferredGuestPortionCents(guests)).toBe(21330);
  });

  it("returns 0 when there are no non-member guests (no split)", () => {
    expect(
      sumDeferredGuestPortionCents([{ isMember: true, priceCents: 24000 }]),
    ).toBe(0);
  });

  it("treats a missing/undefined priceCents as 0 rather than NaN", () => {
    expect(
      sumDeferredGuestPortionCents([
        { isMember: false, priceCents: 12999 },
        { isMember: false } as unknown as DeferredGuestPortionGuest,
      ]),
    ).toBe(12999);
  });
});

describe("review-step figure equals the pay-step (server child) figure (#2003)", () => {
  // Odd per-night rates that do NOT divide evenly across the stay: a naive
  // dual-sourcing that rounded (e.g. nights * average nightly rate) would drift
  // from the true integer per-night sum. Both the review banner and the split
  // child are priced by the same engine, so summing per-night integer cents
  // through one owner is the only way they match to the cent.
  const checkIn = parseDateOnly("2026-07-20");
  const checkOut = parseDateOnly("2026-07-23"); // 3 nights: 20, 21, 22

  const seasons: SeasonRateData[] = [
    {
      seasonId: "season-1",
      startDate: parseDateOnly("2026-07-01"),
      endDate: parseDateOnly("2026-07-31"),
      rates: [
        { membershipTypeId: MEMBER_TYPE, ageTier: "ADULT", pricePerNightCents: 8000 },
        { membershipTypeId: NON_MEMBER_TYPE, ageTier: "ADULT", pricePerNightCents: 4333 },
        { membershipTypeId: NON_MEMBER_TYPE, ageTier: "CHILD", pricePerNightCents: 2777 },
      ],
    },
  ];

  const memberGuest: GuestInput = {
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: MEMBER_TYPE,
  };
  const nonMemberAdult: GuestInput = {
    ageTier: "ADULT",
    isMember: false,
    rateMembershipTypeId: NON_MEMBER_TYPE,
  };
  const nonMemberChild: GuestInput = {
    ageTier: "CHILD",
    isMember: false,
    rateMembershipTypeId: NON_MEMBER_TYPE,
  };

  it("the two independently-sourced 'about $X' figures resolve to the same cents", () => {
    // Review step: the whole party is quoted together; the banner sums the
    // non-member rows of that quote via the single owner (mirrors
    // review-step.tsx consuming priceQuote.guests).
    const fullPartyQuote = calculateBookingPrice(
      checkIn,
      checkOut,
      [memberGuest, nonMemberAdult, nonMemberChild],
      seasons,
    );
    const reviewFigure = sumDeferredGuestPortionCents(fullPartyQuote.guests);

    // Pay step: booking-create prices the non-member subset on its own and
    // stores that total as the split child's finalPriceCents, which the payment
    // route surfaces as deferredGuestAmountCents (getProvisionalNonMemberChildSummary).
    const childPrice = calculateBookingPrice(
      checkIn,
      checkOut,
      [nonMemberAdult, nonMemberChild],
      seasons,
    );
    const payStepFigure = childPrice.totalPriceCents; // == child.finalPriceCents

    // Exact, per-night integer cents — 3 * 4333 + 3 * 2777.
    expect(reviewFigure).toBe(12999 + 8331);
    expect(payStepFigure).toBe(12999 + 8331);
    // The load-bearing assertion: same composition ⇒ same figure on both surfaces.
    expect(reviewFigure).toBe(payStepFigure);
  });
});

describe("priceDeferredNonMemberPortion single-sources the deferred figure under group discounts (#2003)", () => {
  // The worked example from the finding: 3 members + 2 non-members, minGroupSize
  // 5, 3 nights. The WHOLE party (5 active) qualifies for the group discount, so
  // the whole-party quote's non-member rows are group-discounted to the FULL
  // rate (3000/night). But a split charges the NON-MEMBER SUBSET alone, and 2 <
  // minGroupSize, so the subset is NOT discounted (4333/night). Summing the
  // whole-party non-member rows therefore UNDER-QUOTES the real deferred charge
  // — the exact divergence the old "agree by construction" claim missed. Both
  // the quote and booking-create call priceDeferredNonMemberPortion, so the
  // banner now shows the subset figure that is actually charged.
  const checkIn = parseDateOnly("2026-07-20");
  const checkOut = parseDateOnly("2026-07-23"); // 3 nights: 20, 21, 22

  const FULL_TYPE = "type-full"; // member rate AND group-discount substitute
  const NON_MEMBER_TYPE_ID = "type-nonmember";

  const seasons: SeasonRateData[] = [
    {
      seasonId: "s1",
      startDate: parseDateOnly("2026-07-01"),
      endDate: parseDateOnly("2026-07-31"),
      rates: [
        { membershipTypeId: FULL_TYPE, ageTier: "ADULT", pricePerNightCents: 3000 },
        { membershipTypeId: NON_MEMBER_TYPE_ID, ageTier: "ADULT", pricePerNightCents: 4333 },
      ],
    },
  ];

  const groupDiscount: GroupDiscountConfig = {
    enabled: true,
    minGroupSize: 5,
    summerOnly: false,
    rateMembershipTypeId: FULL_TYPE,
  };

  const db = makeFakePolicyDb([
    { id: FULL_TYPE, key: "FULL" },
    { id: NON_MEMBER_TYPE_ID, key: "NON_MEMBER" },
  ]);

  const wholeParty = [
    { ageTier: "ADULT" as const, isMember: true },
    { ageTier: "ADULT" as const, isMember: true },
    { ageTier: "ADULT" as const, isMember: true },
    { ageTier: "ADULT" as const, isMember: false },
    { ageTier: "ADULT" as const, isMember: false },
  ];

  const SUBSET_CHARGE_CENTS = 4333 * 3 * 2; // 25998 — undiscounted subset
  const DISCOUNTED_WHOLE_PARTY_NON_MEMBER_CENTS = 3000 * 3 * 2; // 18000

  it("prices the non-member subset (the real charge), which DIVERGES from the discounted whole-party rows", async () => {
    // What booking-create charges the split child: the subset priced alone.
    const deferred = await priceDeferredNonMemberPortion(db, {
      checkIn,
      checkOut,
      guests: wholeParty,
      seasons,
      groupDiscount,
      seasonYear: seasonYearOfStoredDate(checkIn, 3),
      yearEndMonth: 3,
    });
    expect(deferred).not.toBeNull();
    expect(deferred!.totalPriceCents).toBe(SUBSET_CHARGE_CENTS);

    // The whole-party quote the review banner used to sum: its non-member rows
    // ARE group-discounted (5 >= minGroupSize), giving a LOWER figure than the
    // subset that is actually charged.
    const wholePartyQuote = await priceBookingGuestsWithMembershipTypePolicy(db, {
      checkIn,
      checkOut,
      guests: wholeParty,
      seasons,
      groupDiscount,
      seasonYear: seasonYearOfStoredDate(checkIn, 3),
      yearEndMonth: 3,
    });
    const naiveBannerSum = sumDeferredGuestPortionCents(wholePartyQuote.guests);
    expect(naiveBannerSum).toBe(DISCOUNTED_WHOLE_PARTY_NON_MEMBER_CENTS);

    // The finding: the two figures DIVERGE, and the old whole-party sum
    // under-quoted the deferred charge in the surprise direction.
    expect(naiveBannerSum).toBeLessThan(deferred!.totalPriceCents);
    expect(naiveBannerSum).not.toBe(deferred!.totalPriceCents);
  });

  it("equals booking-create's split-child pricing to the cent (same subset, same call shape)", async () => {
    // booking-create prices toGuestPricingInputs(nonMemberGuests) through the
    // same policy pricer; the helper does exactly that, so the quote's
    // deferredGuestPortionCents == the child's finalPriceCents.
    const deferred = await priceDeferredNonMemberPortion(db, {
      checkIn,
      checkOut,
      guests: wholeParty,
      seasons,
      groupDiscount,
      seasonYear: seasonYearOfStoredDate(checkIn, 3),
      yearEndMonth: 3,
    });
    const childStyle = await priceBookingGuestsWithMembershipTypePolicy(db, {
      checkIn,
      checkOut,
      guests: [
        { ageTier: "ADULT", isMember: false },
        { ageTier: "ADULT", isMember: false },
      ],
      seasons,
      groupDiscount,
      seasonYear: seasonYearOfStoredDate(checkIn, 3),
      yearEndMonth: 3,
    });
    expect(deferred!.totalPriceCents).toBe(childStyle.totalPriceCents);
    expect(deferred!.totalPriceCents).toBe(SUBSET_CHARGE_CENTS);
  });

  it("returns null when the party has no non-member guests (nothing is deferred)", async () => {
    const deferred = await priceDeferredNonMemberPortion(db, {
      checkIn,
      checkOut,
      guests: [
        { ageTier: "ADULT", isMember: true },
        { ageTier: "ADULT", isMember: true },
      ],
      seasons,
      groupDiscount,
      seasonYear: seasonYearOfStoredDate(checkIn, 3),
      yearEndMonth: 3,
    });
    expect(deferred).toBeNull();
  });
});
