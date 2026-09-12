import { describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import { parseDateOnly } from "@/lib/date-only";
import {
  calculateBookingPrice,
  type GuestInput,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  validateAndCalculatePromoDiscount,
  type BookingDetailsForPromo,
  type PromoApplicationSubject,
} from "@/lib/promo";
import type { PromoUsageClient } from "@/lib/promo-usage-counts";

// `promo.ts` constructs the module-level client at import time. Nothing here
// touches it: every database read goes through the `db` option below.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * #3276 (stage 2 of programme #3272), D3: NO FIGURE A MEMBER SEES CHANGES.
 *
 * Every number below is a LITERAL, worked by hand from the rate table, and this
 * file was committed BEFORE the pricing engine learned to report what each
 * promotion took off each night. It is the proof that recording the build-up
 * moved nothing: the booking total, every guest total, every per-night rate,
 * the promotion's discount and adjustment, the beneficiary allocations and the
 * final price are pinned across all four promotion types and across the
 * scoping rules in `promo-guest-scope.ts` — own-night assignment, booker-picks
 * guests, a group fixed-nightly code — plus a work-party window that covers
 * only some of a non-contiguous stay.
 *
 * If a later change to the engine needs one of these literals to move, that
 * change is charging somebody differently and is out of scope for #3276.
 */

const MEMBER_TYPE = "type-member";
const NONMEMBER_TYPE = "type-nonmember";
const CLUB_TODAY = requireCalendarDate("2026-07-01");
const d = parseDateOnly;

const winter: SeasonRateData = {
  seasonId: "winter-2026",
  startDate: d("2026-06-01"),
  endDate: d("2026-09-30"),
  rates: [
    { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 4500 },
    { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 7000 },
    { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3000 },
    { ageTier: "YOUTH", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 5000 },
  ],
};

const summer: SeasonRateData = {
  seasonId: "summer-2026",
  startDate: d("2026-10-01"),
  endDate: d("2027-05-31"),
  rates: [
    { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3500 },
    { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 5500 },
    { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 2500 },
    { ageTier: "YOUTH", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 4000 },
  ],
};

const seasons = [winter, summer];

// Three nights across the season boundary: two winter, one summer.
const CHECK_IN = d("2026-09-29");
const CHECK_OUT = d("2026-10-02");
const NIGHTS = [d("2026-09-29"), d("2026-09-30"), d("2026-10-01")];

const BOOKER = "member-booker";
const LINKED = "member-linked";

function partyOf(nightsForLinked?: Date[]): GuestInput[] {
  return [
    { ageTier: "ADULT", isMember: true, memberId: BOOKER, rateMembershipTypeId: MEMBER_TYPE },
    {
      ageTier: "YOUTH",
      isMember: true,
      memberId: LINKED,
      rateMembershipTypeId: MEMBER_TYPE,
      ...(nightsForLinked ? { nights: nightsForLinked } : {}),
    },
    { ageTier: "ADULT", isMember: false, memberId: null, rateMembershipTypeId: NONMEMBER_TYPE },
  ];
}

function promoOf(overrides: Partial<PromoApplicationSubject>): PromoApplicationSubject {
  return {
    id: "promo-under-test",
    active: true,
    validFrom: null,
    validUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    membersOnly: false,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    type: "PERCENTAGE",
    valueCents: null,
    percentOff: null,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    ...overrides,
  };
}

/** A database that has never seen this promotion used, and one work-party window. */
function stubDb(workPartyWindow?: { startDate: Date; endDate: Date }): PromoUsageClient {
  return {
    promoRedemptionAllocation: {
      aggregate: async () => ({ _sum: { freeNightsUsed: 0 } }),
      count: async () => 0,
      findMany: async () => [],
    },
    workPartyEvent: {
      findUnique: async () => workPartyWindow ?? null,
    },
  } as unknown as PromoUsageClient;
}

async function apply(
  promo: PromoApplicationSubject,
  options: {
    guests?: GuestInput[];
    assignedMemberIds?: string[] | null;
    selectedGuestIndexes?: number[];
    workPartyWindow?: { startDate: Date; endDate: Date };
  } = {},
) {
  const guests = options.guests ?? partyOf();
  const price = calculateBookingPrice(CHECK_IN, CHECK_OUT, guests, seasons);
  const details: BookingDetailsForPromo = {
    memberId: BOOKER,
    bookingCheckIn: CHECK_IN,
    totalPriceCents: price.totalPriceCents,
    guests: price.guests.map((priced, index) => ({
      memberId: guests[index].memberId ?? null,
      isMember: priced.isMember,
      perNightRates: priced.perNightCents,
      nightDates: priced.nightDates,
      firstNight: CHECK_IN,
    })),
  };
  const application = await validateAndCalculatePromoDiscount(
    promo,
    details,
    options.assignedMemberIds ?? null,
    {
      db: stubDb(options.workPartyWindow),
      todayAtClub: CLUB_TODAY,
      selectedGuestIndexes: options.selectedGuestIndexes,
    },
  );
  expect(application.error, application.error).toBeUndefined();
  const discount = application.discount!;
  return {
    price: {
      totalPriceCents: price.totalPriceCents,
      guests: price.guests.map((g) => ({
        priceCents: g.priceCents,
        perNightCents: g.perNightCents,
        nightDates: g.nightDates.map((night) => night.toISOString().slice(0, 10)),
      })),
    },
    discountCents: discount.discountCents,
    promoAdjustmentCents: discount.priceAdjustmentCents,
    freeNightsUsed: discount.freeNightsUsed,
    eligibleGuestCount: discount.eligibleGuestCount,
    allocations: discount.allocations,
    beneficiaryMemberIds: application.beneficiaryMemberIds,
    selectedGuestIndexes: application.selectedGuestIndexes,
    finalPriceCents: price.totalPriceCents + discount.priceAdjustmentCents,
  };
}

const FULL_PARTY_PRICE = {
  totalPriceCents: 40500,
  guests: [
    { priceCents: 12500, perNightCents: [4500, 4500, 3500], nightDates: ["2026-09-29", "2026-09-30", "2026-10-01"] },
    { priceCents: 8500, perNightCents: [3000, 3000, 2500], nightDates: ["2026-09-29", "2026-09-30", "2026-10-01"] },
    { priceCents: 19500, perNightCents: [7000, 7000, 5500], nightDates: ["2026-09-29", "2026-09-30", "2026-10-01"] },
  ],
};

describe("INV-MONEY-029 / D3: the promotion engine's money is byte-identical across every promo type and scoping", () => {
  it("prices the party itself exactly as pinned (three nights over a season boundary)", () => {
    const price = calculateBookingPrice(CHECK_IN, CHECK_OUT, partyOf(), seasons);
    expect(price.totalPriceCents).toBe(40500);
    expect(price.guests.map((g) => g.perNightCents)).toEqual([
      [4500, 4500, 3500],
      [3000, 3000, 2500],
      [7000, 7000, 5500],
    ]);
    expect(price.guests[1].nightDates).toEqual(NIGHTS);
  });

  it("PERCENTAGE, unassigned: 20% off every night of every guest, booker is the beneficiary", async () => {
    await expect(apply(promoOf({ type: "PERCENTAGE", percentOff: 20 }))).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 8100,
      promoAdjustmentCents: -8100,
      freeNightsUsed: 0,
      eligibleGuestCount: 3,
      allocations: [{ memberId: BOOKER, discountCents: 8100, priceAdjustmentCents: -8100, freeNightsUsed: 0 }],
      beneficiaryMemberIds: [BOOKER],
      selectedGuestIndexes: undefined,
      finalPriceCents: 32400,
    });
  });

  it("PERCENTAGE, assigned to the linked member with own-night scoping: only their three nights are reduced", async () => {
    await expect(
      apply(promoOf({ type: "PERCENTAGE", percentOff: 20, assignedMembersOnlyOwnNights: true }), {
        assignedMemberIds: [LINKED],
      }),
    ).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 1700,
      promoAdjustmentCents: -1700,
      freeNightsUsed: 0,
      eligibleGuestCount: 1,
      allocations: [{ memberId: LINKED, discountCents: 1700, priceAdjustmentCents: -1700, freeNightsUsed: 0 }],
      beneficiaryMemberIds: [LINKED],
      selectedGuestIndexes: undefined,
      finalPriceCents: 38800,
    });
  });

  it("PERCENTAGE, booker picks guests (assigned, own-night scoping off): only the picked non-member is reduced", async () => {
    await expect(
      apply(promoOf({ type: "PERCENTAGE", percentOff: 50, assignedMembersOnlyOwnNights: false }), {
        assignedMemberIds: [BOOKER],
        selectedGuestIndexes: [2],
      }),
    ).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 9750,
      promoAdjustmentCents: -9750,
      freeNightsUsed: 0,
      eligibleGuestCount: 1,
      allocations: [{ memberId: BOOKER, discountCents: 9750, priceAdjustmentCents: -9750, freeNightsUsed: 0 }],
      beneficiaryMemberIds: [BOOKER],
      selectedGuestIndexes: [2],
      finalPriceCents: 30750,
    });
  });

  it("FIXED_AMOUNT, unassigned: the amount per guest, capped at the guest's own total", async () => {
    await expect(apply(promoOf({ type: "FIXED_AMOUNT", valueCents: 10000 }))).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 28500,
      promoAdjustmentCents: -28500,
      freeNightsUsed: 0,
      eligibleGuestCount: 3,
      allocations: [{ memberId: BOOKER, discountCents: 28500, priceAdjustmentCents: -28500, freeNightsUsed: 0 }],
      beneficiaryMemberIds: [BOOKER],
      selectedGuestIndexes: undefined,
      finalPriceCents: 12000,
    });
  });

  it("FREE_NIGHTS, unassigned, one per individual capped at $40 a night: each guest's dearest night", async () => {
    await expect(
      apply(promoOf({ type: "FREE_NIGHTS", freeNightsPerIndividual: 1, maxNightlyValueCents: 4000 })),
    ).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 11000,
      promoAdjustmentCents: -11000,
      freeNightsUsed: 3,
      eligibleGuestCount: 3,
      allocations: [{ memberId: BOOKER, discountCents: 11000, priceAdjustmentCents: -11000, freeNightsUsed: 3 }],
      beneficiaryMemberIds: [BOOKER],
      selectedGuestIndexes: undefined,
      finalPriceCents: 29500,
    });
  });

  it("FREE_NIGHTS, assigned own-night with a lifetime cap of one: one night each for the two members", async () => {
    await expect(
      apply(
        promoOf({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 2,
          lifetimeFreeNightsCap: 1,
          assignedMembersOnlyOwnNights: true,
        }),
        { assignedMemberIds: [BOOKER, LINKED] },
      ),
    ).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 7500,
      promoAdjustmentCents: -7500,
      freeNightsUsed: 2,
      eligibleGuestCount: 2,
      allocations: [
        { memberId: BOOKER, discountCents: 4500, priceAdjustmentCents: -4500, freeNightsUsed: 1 },
        { memberId: LINKED, discountCents: 3000, priceAdjustmentCents: -3000, freeNightsUsed: 1 },
      ],
      beneficiaryMemberIds: [BOOKER, LINKED],
      selectedGuestIndexes: undefined,
      finalPriceCents: 33000,
    });
  });

  it("FIXED_NIGHTLY_PRICE CAP_ONLY as a group code: every night above $40 comes down to it, booker is the beneficiary", async () => {
    await expect(
      apply(
        promoOf({
          type: "FIXED_NIGHTLY_PRICE",
          fixedNightlyPriceCents: 4000,
          fixedNightlyMode: "CAP_ONLY",
          assignedMembersOnlyOwnNights: false,
        }),
        { assignedMemberIds: [BOOKER] },
      ),
    ).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 8500,
      promoAdjustmentCents: -8500,
      freeNightsUsed: 0,
      eligibleGuestCount: 2,
      allocations: [{ memberId: BOOKER, discountCents: 8500, priceAdjustmentCents: -8500, freeNightsUsed: 0 }],
      beneficiaryMemberIds: [BOOKER],
      selectedGuestIndexes: undefined,
      finalPriceCents: 32000,
    });
  });

  it("FIXED_NIGHTLY_PRICE SET_PRICE, assigned own-night: a price that goes UP is recorded as a positive adjustment", async () => {
    await expect(
      apply(
        promoOf({
          type: "FIXED_NIGHTLY_PRICE",
          fixedNightlyPriceCents: 4000,
          fixedNightlyMode: "SET_PRICE",
          assignedMembersOnlyOwnNights: true,
        }),
        { assignedMemberIds: [LINKED] },
      ),
    ).resolves.toEqual({
      price: FULL_PARTY_PRICE,
      discountCents: 0,
      promoAdjustmentCents: 3500,
      freeNightsUsed: 0,
      eligibleGuestCount: 1,
      allocations: [{ memberId: LINKED, discountCents: 0, priceAdjustmentCents: 3500, freeNightsUsed: 0 }],
      beneficiaryMemberIds: [LINKED],
      selectedGuestIndexes: undefined,
      finalPriceCents: 44000,
    });
  });

  it("work party (internal 100%): only nights inside the window count, by DATE, on a non-contiguous stay", async () => {
    await expect(
      apply(promoOf({ type: "PERCENTAGE", percentOff: 100, internal: true }), {
        guests: partyOf([d("2026-09-29"), d("2026-10-01")]),
        workPartyWindow: { startDate: d("2026-09-30"), endDate: d("2026-10-01") },
      }),
    ).resolves.toEqual({
      price: {
        totalPriceCents: 37500,
        guests: [
          { priceCents: 12500, perNightCents: [4500, 4500, 3500], nightDates: ["2026-09-29", "2026-09-30", "2026-10-01"] },
          { priceCents: 5500, perNightCents: [3000, 2500], nightDates: ["2026-09-29", "2026-10-01"] },
          { priceCents: 19500, perNightCents: [7000, 7000, 5500], nightDates: ["2026-09-29", "2026-09-30", "2026-10-01"] },
        ],
      },
      discountCents: 23000,
      promoAdjustmentCents: -23000,
      freeNightsUsed: 0,
      eligibleGuestCount: 3,
      allocations: [{ memberId: BOOKER, discountCents: 23000, priceAdjustmentCents: -23000, freeNightsUsed: 0 }],
      beneficiaryMemberIds: [BOOKER],
      selectedGuestIndexes: undefined,
      finalPriceCents: 14500,
    });
  });
});
