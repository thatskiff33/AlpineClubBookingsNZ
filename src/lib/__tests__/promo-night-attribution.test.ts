import { describe, expect, it, vi } from "vitest";

import { requireCalendarDate } from "@/lib/club-time";
import { parseDateOnly } from "@/lib/date-only";
import { reconcilePromoAdjustmentTargets } from "@/lib/night-adjustment-write";
import {
  calculateBookingPrice,
  calculatePromoDiscount,
  type GuestInput,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  validateAndCalculatePromoDiscount,
  type BookingDetailsForPromo,
  type PromoApplicationSubject,
} from "@/lib/promo";
import type { PromoUsageClient } from "@/lib/promo-usage-counts";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * #3276: WHAT EACH PROMOTION TOOK OFF EACH NIGHT (or guest), at the grain the
 * engine decided it — the acceptance fixtures the issue asks for, across all
 * four promotion types and the scoping rules in `promo-guest-scope.ts`, plus a
 * work-party window on a non-contiguous stay. Every scenario also runs the
 * INV-MONEY-029 reconciliation against the engine's own allocations, so the
 * rows are proved to sum to what is recorded rather than asserted to.
 *
 * The same party and rate table as `promo-money-byte-identical.test.ts`, which
 * pins the TOTALS; this file pins the DECOMPOSITION.
 */

const MEMBER_TYPE = "type-member";
const NONMEMBER_TYPE = "type-nonmember";
const CLUB_TODAY = requireCalendarDate("2026-07-01");
const d = parseDateOnly;
const N1 = d("2026-09-29");
const N2 = d("2026-09-30");
const N3 = d("2026-10-01");

const seasons: SeasonRateData[] = [
  {
    seasonId: "winter-2026",
    startDate: d("2026-06-01"),
    endDate: d("2026-09-30"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 4500 },
      { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 7000 },
      { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3000 },
    ],
  },
  {
    seasonId: "summer-2026",
    startDate: d("2026-10-01"),
    endDate: d("2027-05-31"),
    rates: [
      { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 3500 },
      { ageTier: "ADULT", membershipTypeId: NONMEMBER_TYPE, pricePerNightCents: 5500 },
      { ageTier: "YOUTH", membershipTypeId: MEMBER_TYPE, pricePerNightCents: 2500 },
    ],
  },
];

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

function stubDb(workPartyWindow?: { startDate: Date; endDate: Date }): PromoUsageClient {
  return {
    promoRedemptionAllocation: {
      aggregate: async () => ({ _sum: { freeNightsUsed: 0 } }),
      count: async () => 0,
      findMany: async () => [],
    },
    workPartyEvent: { findUnique: async () => workPartyWindow ?? null },
  } as unknown as PromoUsageClient;
}

async function attribute(
  promo: PromoApplicationSubject,
  options: {
    guests?: GuestInput[];
    assignedMemberIds?: string[] | null;
    selectedGuestIndexes?: number[];
    workPartyWindow?: { startDate: Date; endDate: Date };
  } = {},
) {
  const guests = options.guests ?? partyOf();
  const price = calculateBookingPrice(d("2026-09-29"), d("2026-10-02"), guests, seasons);
  const details: BookingDetailsForPromo = {
    memberId: BOOKER,
    bookingCheckIn: d("2026-09-29"),
    totalPriceCents: price.totalPriceCents,
    guests: price.guests.map((priced, index) => ({
      memberId: guests[index].memberId ?? null,
      isMember: priced.isMember,
      perNightRates: priced.perNightCents,
      nightDates: priced.nightDates,
      firstNight: d("2026-09-29"),
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
  const targets = application.adjustmentTargets!;
  // Every row reconciles to what would be recorded (INV-MONEY-029), and every
  // night-scope row knows its night by DATE.
  reconcilePromoAdjustmentTargets({
    targets,
    allocations: discount.allocations,
    priceAdjustmentCents: discount.priceAdjustmentCents,
    context: "attribution fixture",
  });
  for (const target of targets) {
    if (target.scope === "night") expect(target.stayDate).toBeInstanceOf(Date);
    else expect(target.stayDate).toBeNull();
  }
  return targets.map((target) => ({
    guestIndex: target.guestIndex,
    scope: target.scope,
    stayDate: target.stayDate ? target.stayDate.toISOString().slice(0, 10) : null,
    beneficiaryMemberId: target.beneficiaryMemberId,
    amountCents: target.amountCents,
  }));
}

const night = (guestIndex: number, stayDate: string, beneficiaryMemberId: string, amountCents: number) => ({
  guestIndex,
  scope: "night" as const,
  stayDate,
  beneficiaryMemberId,
  amountCents,
});

describe("INV-MONEY-029: what each promotion took off each night or guest (#3276)", () => {
  it("PERCENTAGE, unassigned: one row per night of every guest, all for the booker", async () => {
    await expect(attribute(promoOf({ type: "PERCENTAGE", percentOff: 20 }))).resolves.toEqual([
      night(2, "2026-09-29", BOOKER, -1400),
      night(2, "2026-09-30", BOOKER, -1400),
      night(2, "2026-10-01", BOOKER, -1100),
      night(0, "2026-09-29", BOOKER, -900),
      night(0, "2026-09-30", BOOKER, -900),
      night(0, "2026-10-01", BOOKER, -700),
      night(1, "2026-09-29", BOOKER, -600),
      night(1, "2026-09-30", BOOKER, -600),
      night(1, "2026-10-01", BOOKER, -500),
    ]);
  });

  it("PERCENTAGE, assigned own-night: rows only on the linked member's own nights, for that member", async () => {
    await expect(
      attribute(promoOf({ type: "PERCENTAGE", percentOff: 20, assignedMembersOnlyOwnNights: true }), {
        assignedMemberIds: [LINKED],
      }),
    ).resolves.toEqual([
      night(1, "2026-09-29", LINKED, -600),
      night(1, "2026-09-30", LINKED, -600),
      night(1, "2026-10-01", LINKED, -500),
    ]);
  });

  it("PERCENTAGE, booker picks guests: rows only on the picked guest, for the booker", async () => {
    await expect(
      attribute(promoOf({ type: "PERCENTAGE", percentOff: 50, assignedMembersOnlyOwnNights: false }), {
        assignedMemberIds: [BOOKER],
        selectedGuestIndexes: [2],
      }),
    ).resolves.toEqual([
      night(2, "2026-09-29", BOOKER, -3500),
      night(2, "2026-09-30", BOOKER, -3500),
      night(2, "2026-10-01", BOOKER, -2750),
    ]);
  });

  it("FIXED_AMOUNT: one GUEST-scope row per guest, capped at the guest's total, no night rule", async () => {
    await expect(attribute(promoOf({ type: "FIXED_AMOUNT", valueCents: 10000 }))).resolves.toEqual([
      { guestIndex: 2, scope: "guest", stayDate: null, beneficiaryMemberId: BOOKER, amountCents: -10000 },
      { guestIndex: 0, scope: "guest", stayDate: null, beneficiaryMemberId: BOOKER, amountCents: -10000 },
      { guestIndex: 1, scope: "guest", stayDate: null, beneficiaryMemberId: BOOKER, amountCents: -8500 },
    ]);
  });

  it("FREE_NIGHTS, unassigned: the dearest night of each guest, capped, dearest first", async () => {
    await expect(
      attribute(promoOf({ type: "FREE_NIGHTS", freeNightsPerIndividual: 1, maxNightlyValueCents: 4000 })),
    ).resolves.toEqual([
      night(2, "2026-09-29", BOOKER, -4000),
      night(0, "2026-09-29", BOOKER, -4000),
      night(1, "2026-09-29", BOOKER, -3000),
    ]);
  });

  it("FREE_NIGHTS, assigned own-night with a lifetime cap of one: one night each, to its own member", async () => {
    await expect(
      attribute(
        promoOf({
          type: "FREE_NIGHTS",
          freeNightsPerIndividual: 2,
          lifetimeFreeNightsCap: 1,
          assignedMembersOnlyOwnNights: true,
        }),
        { assignedMemberIds: [BOOKER, LINKED] },
      ),
    ).resolves.toEqual([night(0, "2026-09-29", BOOKER, -4500), night(1, "2026-09-29", LINKED, -3000)]);
  });

  it("FIXED_NIGHTLY_PRICE CAP_ONLY as a group code: only the nights above the cap, for the booker", async () => {
    await expect(
      attribute(
        promoOf({
          type: "FIXED_NIGHTLY_PRICE",
          fixedNightlyPriceCents: 4000,
          fixedNightlyMode: "CAP_ONLY",
          assignedMembersOnlyOwnNights: false,
        }),
        { assignedMemberIds: [BOOKER] },
      ),
    ).resolves.toEqual([
      night(2, "2026-09-29", BOOKER, -3000),
      night(2, "2026-09-30", BOOKER, -3000),
      night(2, "2026-10-01", BOOKER, -1500),
      night(0, "2026-09-29", BOOKER, -500),
      night(0, "2026-09-30", BOOKER, -500),
    ]);
  });

  it("FIXED_NIGHTLY_PRICE SET_PRICE, assigned own-night: every night, positive where the price went up", async () => {
    await expect(
      attribute(
        promoOf({
          type: "FIXED_NIGHTLY_PRICE",
          fixedNightlyPriceCents: 4000,
          fixedNightlyMode: "SET_PRICE",
          assignedMembersOnlyOwnNights: true,
        }),
        { assignedMemberIds: [LINKED] },
      ),
    ).resolves.toEqual([
      night(1, "2026-09-29", LINKED, 1000),
      night(1, "2026-09-30", LINKED, 1000),
      night(1, "2026-10-01", LINKED, 1500),
    ]);
  });

  it("SET_PRICE records a night set to exactly its rate as a real zero row", () => {
    const guest = { memberId: "m", isMember: true, perNightRates: [4000, 3000], nightDates: [N1, N2] };
    const result = calculatePromoDiscount(
      { type: "FIXED_NIGHTLY_PRICE", fixedNightlyPriceCents: 4000, fixedNightlyMode: "SET_PRICE" },
      { totalPriceCents: 7000, guests: [guest] },
    );
    expect(result.targets.map((t) => t.amountCents)).toEqual([0, 1000]);
  });

  it("work party: rows only on the nights inside the window, attributed by DATE on a non-contiguous stay", async () => {
    await expect(
      attribute(promoOf({ type: "PERCENTAGE", percentOff: 100, internal: true }), {
        guests: partyOf([N1, N3]),
        workPartyWindow: { startDate: N2, endDate: N3 },
      }),
    ).resolves.toEqual([
      night(2, "2026-09-30", BOOKER, -7000),
      night(2, "2026-10-01", BOOKER, -5500),
      night(0, "2026-09-30", BOOKER, -4500),
      night(0, "2026-10-01", BOOKER, -3500),
      // The linked member stays the 29th and the 1st only; the 29th is outside
      // the window, so exactly one row, dated the 1st — not "the second night".
      night(1, "2026-10-01", BOOKER, -2500),
    ]);
  });

  it("the safety-cap rescale makes every row NOT KNOWN rather than inventing a per-night split", () => {
    const guest = { memberId: "m", isMember: true, perNightRates: [1000, 1000], nightDates: [N1, N2] };
    const result = calculatePromoDiscount(
      { type: "PERCENTAGE", percentOff: 150 },
      { totalPriceCents: 2000, guests: [guest] },
    );
    expect(result.discountCents).toBe(2000);
    expect(result.targets).toHaveLength(2);
    expect(result.targets.every((t) => t.amountCents === null)).toBe(true);
    // And the reconciliation guard treats them as unknown, never as zero.
    expect(() =>
      reconcilePromoAdjustmentTargets({
        targets: result.targets.map((t) => ({
          guestIndex: 0,
          scope: t.scope,
          stayDate: t.scope === "night" ? t.stayDate : null,
          beneficiaryMemberId: "m",
          amountCents: t.amountCents,
        })),
        allocations: result.allocations,
        priceAdjustmentCents: result.priceAdjustmentCents,
        context: "cap fixture",
      }),
    ).not.toThrow();
  });

  it("a guest priced without dates yields undated night rows the writer will refuse", () => {
    const result = calculatePromoDiscount(
      { type: "PERCENTAGE", percentOff: 10 },
      { totalPriceCents: 1000, guests: [{ memberId: "m", isMember: true, perNightRates: [1000] }] },
    );
    expect(result.targets).toEqual([
      expect.objectContaining({ scope: "night", nightIndex: 0, stayDate: null, amountCents: -100 }),
    ]);
  });
});
