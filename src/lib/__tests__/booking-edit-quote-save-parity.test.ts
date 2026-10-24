import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const h = vi.hoisted(() => ({
  checkCapacityForGuestRanges: vi.fn(),
  checkCapacityForPartnerSharedAdmission: vi.fn(),
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");
  return {
    ...actual,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
    checkCapacityForPartnerSharedAdmission:
      h.checkCapacityForPartnerSharedAdmission,
  };
});
vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed: vi.fn().mockResolvedValue(undefined),
  resolveGuestRateMembershipTypes: vi
    .fn()
    .mockImplementation((_tx: unknown, { guests }: { guests: unknown[] }) =>
      Promise.resolve(guests),
    ),
  MembershipTypeBookingPolicyError: class extends Error {},
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  buildInProgressGuestRangePlan,
  type BuildInProgressGuestRangePlanInput,
} from "@/lib/booking-edit-guest-ranges";
import {
  calculateModifiedPricing,
  editedGuestPricingLocks,
} from "@/lib/booking-modify-plan";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import { calculateBookingPrice, type SeasonRateData } from "@/lib/pricing";
import {
  NegativeEditedHeadlineError,
  NegativeStoredGuestTotalError,
} from "@/lib/edit-night-valuation";

/**
 * THE PREVIEW AND THE SAVE PRICE ONE EDIT IDENTICALLY (#3031; #4317, epic #4302).
 *
 * The member reads a price from `POST /api/bookings/[id]/modify-quote` and then
 * saves through `PUT /api/bookings/[id]/modify`. For a stay already under way
 * the quote calls `buildInProgressGuestRangePlan` directly and the save calls it
 * through `calculateModifiedPricing`. Before #4317 the two had to agree on
 * whether an edit was priceable at all; since #4317 every edit prices
 * (`INV-MOD-028`), so what they must agree on is the AMOUNT, cent for cent, on
 * every shape of stored history the valuation reads — exact rows, no rows, rows
 * without a price, partly priced rows, rows that do not add up, and a negative
 * stored total (D11).
 *
 * The matrix below runs every shape through three edits (extend, shorten,
 * remove) on both paths and pins the dollar answer to a hand-computed table, so
 * the two cannot drift together to a wrong figure either.
 */

const D = (value: string) => new Date(`${value}T00:00:00.000Z`);

const MEMBER_TYPE = "type-member";
const RATE = 5000;

const SEASONS: SeasonRateData[] = [
  {
    seasonId: "s1",
    startDate: D("2026-08-01"),
    endDate: D("2026-08-31"),
    rates: [
      {
        ageTier: "ADULT",
        membershipTypeId: MEMBER_TYPE,
        pricePerNightCents: RATE,
      },
    ],
  },
];

const HELD = ["2026-08-20", "2026-08-21", "2026-08-22"];

/** A club that has not switched the group discount on. */
const NO_DISCOUNT_TX = {
  groupDiscountSetting: { findUnique: async () => null },
} as never;

type Night = {
  stayDate: Date;
  priceCents?: number | null;
  priceSource: "SOLD" | "UNKNOWN";
};

function guest(id: string, memberId: string, nights: Night[], priceCents: number) {
  return {
    id,
    firstName: "Guest",
    lastName: id,
    ageTier: "ADULT" as const,
    isMember: true,
    memberId,
    rateMembershipTypeId: MEMBER_TYPE,
    rateSource: "OWN_TYPE" as const,
    stayStart: D(HELD[0]),
    stayEnd: D("2026-08-23"),
    nights,
    priceCents,
  };
}

const sold = (cents: Array<number | null>): Night[] =>
  HELD.map((night, index) => ({
    stayDate: D(night),
    priceCents: cents[index],
    priceSource: cents[index] === null ? "UNKNOWN" : "SOLD",
  }));

/** The companion every case carries, so a removal never empties the booking. */
const COMPANION = guest("g2", "m2", sold([RATE, RATE, RATE]), 3 * RATE);

/**
 * The shapes of stored history, each with what INV-MOD-028 values its three
 * nights at — the figure a night given back is credited at.
 */
const SHAPES = {
  "exact rows": { nights: sold([RATE, RATE, RATE]), total: 15000, values: [5000, 5000, 5000] },
  // R2 over the envelope: $120 / 3.
  "no rows": { nights: [] as Night[], total: 12000, values: [4000, 4000, 4000] },
  // R2: rows with no price, $90 / 3.
  "unpriced rows": { nights: sold([null, null, null]), total: 9000, values: [3000, 3000, 3000] },
  // R2: the blank takes what $156 leaves after two $50 rows.
  "partly priced": { nights: sold([RATE, RATE, null]), total: 15600, values: [5000, 5000, 5600] },
  // R3: rows do not add up to $151.01, so the total is split, extra cents first.
  "rows do not add up": { nights: sold([RATE, RATE, RATE]), total: 15101, values: [5034, 5034, 5033] },
} as const;

/**
 * How far the stored headline sits from its guests' stored totals: none, as
 * every writer stores them, and a $100 a parked edit froze into it (#4317
 * review H1). The edit's own difference must be the same either way - the gap
 * is carried forward for the review, never settled by the edit.
 */
const HEADLINE_GAPS = [0, 10_000] as const;

const EDITS = {
  // Buys the 23rd and 24th for each guest at today's $50.
  extend: { newCheckOut: "2026-08-25" },
  // Each guest gives back the 22nd.
  shorten: { newCheckOut: "2026-08-22" },
  // g1 gives back the 21st and 22nd; the 20th is already slept.
  remove: { newCheckOut: "2026-08-23", removeGuestIds: ["g1"] },
} as const;

/** The edit's price difference, worked by hand from the values above. */
function expectedDiff(shape: keyof typeof SHAPES, edit: keyof typeof EDITS): number {
  const [, v21, v22] = SHAPES[shape].values;
  switch (edit) {
    case "extend":
      return 4 * RATE;
    case "shorten":
      return 0 - (RATE + v22);
    case "remove":
      return 0 - (v21 + v22);
  }
}

/** The booking as the QUOTE route hands it to the planner. */
function planInput(
  shape: keyof typeof SHAPES,
  edit: keyof typeof EDITS,
  headlineGapCents = 0,
): BuildInProgressGuestRangePlanInput {
  const { nights, total } = SHAPES[shape];
  const guests = [guest("g1", "m1", [...nights], total), COMPANION];
  const totalPriceCents =
    guests.reduce((sum, g) => sum + g.priceCents, 0) + headlineGapCents;
  const change = EDITS[edit];
  return {
    booking: {
      id: "bk-parity",
      checkIn: D(HELD[0]),
      checkOut: D("2026-08-23"),
      totalPriceCents,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: totalPriceCents,
      guests,
    },
    editableFrom: D("2026-08-21"),
    newCheckOut: D(change.newCheckOut),
    ...("removeGuestIds" in change ? { removeGuestIds: [...change.removeGuestIds] } : {}),
    seasons: SEASONS,
  };
}

/** The same edit as the SAVE hands it to `calculateModifiedPricing`. */
function pricingArgs(
  shape: keyof typeof SHAPES,
  edit: keyof typeof EDITS,
  headlineGapCents = 0,
) {
  const input = planInput(shape, edit, headlineGapCents);
  return {
    booking: { ...input.booking, memberId: "m1", lodgeId: "lodge-1" } as never,
    bookingId: "bk-parity",
    isInProgressEdit: true,
    editableFrom: input.editableFrom,
    newCheckIn: input.booking.checkIn,
    newCheckOut: input.newCheckOut,
    normalizedAddGuests: undefined,
    removeGuestIds: input.removeGuestIds,
    guestsForPricing: input.booking.guests.map((g) => ({
      bookingGuestId: g.id,
      ageTier: "ADULT" as const,
      isMember: true,
      memberId: g.memberId ?? null,
      stayStart: input.booking.checkIn,
      stayEnd: input.newCheckOut,
    })),
    skipBookingLifecycleRules: false,
    seasonRateData: SEASONS as never,
    partnerSharedGuests: [],
  };
}

describe("#4317 quote and save price every shape of stored history identically", () => {
  const CASES = (Object.keys(SHAPES) as Array<keyof typeof SHAPES>).flatMap((shape) =>
    (Object.keys(EDITS) as Array<keyof typeof EDITS>).flatMap((edit) =>
      HEADLINE_GAPS.map((gap) => [shape, edit, gap] as const),
    ),
  );

  it.each(CASES)("%s, %s, headline gap %i: one amount on both paths, and it is the hand-worked one", async (shape, edit, gap) => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });

    const input = planInput(shape, edit, gap);
    const quote = buildInProgressGuestRangePlan(input).plan;
    const save = await calculateModifiedPricing(NO_DISCOUNT_TX, pricingArgs(shape, edit, gap));

    // The dollar answer, worked by hand - the same with a frozen headline,
    // whose gap the new total carries forward (review H1).
    expect(quote.priceDiffCents).toBe(expectedDiff(shape, edit));
    expect(quote.newTotalPriceCents).toBe(input.booking.totalPriceCents + expectedDiff(shape, edit));
    // And the save agrees with the quote, cent for cent and night for night.
    expect(save.newTotalPriceCents).toBe(quote.newTotalPriceCents);
    expect(save.inProgressPlan?.priceDiffCents).toBe(quote.priceDiffCents);
    expect(save.priceBreakdown.guests.map((g) => g.perNightCents)).toEqual(
      quote.proposedExistingGuests.map((g) => g.perNightCents),
    );
    expect(save.priceBreakdown.guests.map((g) => g.priceCents)).toEqual(
      quote.proposedExistingGuests.map((g) => g.priceCents),
    );
    // A night g1 keeps is written at its valued figure, never NULL.
    const g1 = quote.proposedExistingGuests[0]!;
    expect(g1.perNightCents.every((cents) => Number.isInteger(cents))).toBe(true);
    expect(g1.perNightCents[0]).toBe(SHAPES[shape].values[0]);
  });
});

/**
 * THE SAME SHAPES BEFORE THE STAY STARTS (#4317 T1-T5, T7-T9, D11).
 *
 * A stay yet to start is priced by the ordinary pass in
 * `calculateModifiedPricing`, which hands every held night to the engine as a
 * lock at its valued figure (`editedGuestPricingLocks`, the one home the save
 * and the preview share) and adds back each strand's unattached money (D11).
 * The engine here is the REAL one, behind the membership-type policy wrapper,
 * so a lock the plan fails to hand over shows up as today's $50 instead of the
 * stored value. Each edit is worked by hand from the shape's values:
 *
 *  - extend (T1, T4): both guests keep their nights and buy the 23rd and 24th;
 *  - shorten (T7-T9): both give back the 22nd, g1 at its value;
 *  - remove (T2): g1 leaves and is credited its stored total, $0 if negative;
 *  - reprice (T3): g1's locks are cleared (a #2337 link), so it is charged the
 *    fresh $150 less what it carried;
 *  - move (T5): the whole stay moves, so g1's nights are credited at their
 *    values and three new ones bought fresh.
 */
const PRE_CHECK_IN_EDITS = {
  extend: { newCheckIn: "2026-08-20", newCheckOut: "2026-08-25" },
  shorten: { newCheckIn: "2026-08-20", newCheckOut: "2026-08-22" },
  remove: { newCheckIn: "2026-08-20", newCheckOut: "2026-08-23", removeG1: true },
  reprice: { newCheckIn: "2026-08-20", newCheckOut: "2026-08-23", repriceG1: true },
  move: { newCheckIn: "2026-08-26", newCheckOut: "2026-08-29" },
} as const;

function preCheckInExpectedDiff(
  shape: keyof typeof SHAPES,
  edit: keyof typeof PRE_CHECK_IN_EDITS,
): number {
  const { total, values } = SHAPES[shape];
  const unattached = total - values.reduce<number>((sum, cents) => sum + cents, 0);
  switch (edit) {
    case "extend":
      return 4 * RATE;
    case "shorten":
      return 0 - (RATE + values[2]);
    case "remove":
      return 0 - total;
    case "reprice":
    case "move":
      // Fresh $150, plus what g1 carries beyond its nights, less its total.
      return 3 * RATE + unattached - total;
  }
}

function nightsBetween(checkIn: string, checkOut: string): Date[] {
  const nights: Date[] = [];
  for (let night = D(checkIn); night < D(checkOut); night = new Date(night.getTime() + 86_400_000)) {
    nights.push(night);
  }
  return nights;
}

/** The edit as the batch save hands it to `calculateModifiedPricing`. */
function preCheckInArgs(
  shape: keyof typeof SHAPES,
  edit: keyof typeof PRE_CHECK_IN_EDITS,
  headlineGapCents = 0,
) {
  const { nights, total } = SHAPES[shape];
  const guests = [guest("g1", "m1", [...nights], total), COMPANION];
  const totalPriceCents =
    guests.reduce((sum, g) => sum + g.priceCents, 0) + headlineGapCents;
  const change = PRE_CHECK_IN_EDITS[edit];
  const booking = {
    id: "bk-pre",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D(HELD[0]),
    checkOut: D("2026-08-23"),
    totalPriceCents,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: totalPriceCents,
    guests,
  };
  const remaining = "removeG1" in change ? guests.filter((g) => g.id !== "g1") : guests;
  const nightsHeld = nightsBetween(change.newCheckIn, change.newCheckOut);
  return {
    booking: booking as never,
    bookingId: "bk-pre",
    isInProgressEdit: false,
    editableFrom: null,
    newCheckIn: D(change.newCheckIn),
    newCheckOut: D(change.newCheckOut),
    normalizedAddGuests: undefined,
    removeGuestIds: "removeG1" in change ? ["g1"] : undefined,
    guestsForPricing: remaining.map((g) => ({
      bookingGuestId: g.id,
      ageTier: "ADULT" as const,
      isMember: true,
      memberId: g.memberId,
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE" as const,
      stayStart: D(change.newCheckIn),
      stayEnd: D(change.newCheckOut),
      nights: nightsHeld,
      ...editedGuestPricingLocks(g, booking, "repriceG1" in change && g.id === "g1"),
    })),
    skipBookingLifecycleRules: false,
    seasonRateData: SEASONS as never,
    partnerSharedGuests: [],
  };
}

describe("#4317 an edit before the stay starts prices every shape of stored history", () => {
  const CASES = (Object.keys(SHAPES) as Array<keyof typeof SHAPES>).flatMap((shape) =>
    (Object.keys(PRE_CHECK_IN_EDITS) as Array<keyof typeof PRE_CHECK_IN_EDITS>).flatMap(
      (edit) => HEADLINE_GAPS.map((gap) => [shape, edit, gap] as const),
    ),
  );

  it.each(CASES)("%s, %s, headline gap %i: the hand-worked amount, through the real engine", async (shape, edit, gap) => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockImplementation(
      async (_db, input) =>
        calculateBookingPrice(input.checkIn, input.checkOut, input.guests as never, input.seasons),
    );
    const args = preCheckInArgs(shape, edit, gap);
    const oldTotal = (args.booking as { totalPriceCents: number }).totalPriceCents;

    const save = await calculateModifiedPricing(NO_DISCOUNT_TX, args);

    expect(save.inProgressPlan).toBeNull();
    expect(save.newTotalPriceCents - oldTotal).toBe(preCheckInExpectedDiff(shape, edit));
    // Every night the save will write carries an integer, never NULL.
    for (const priced of save.priceBreakdown.guests) {
      expect(priced.perNightCents.every((cents) => Number.isInteger(cents))).toBe(true);
    }
  });

  it("keeps g1's held nights at their values and buys only the new ones (partly priced, extend)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    });
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockImplementation(
      async (_db, input) =>
        calculateBookingPrice(input.checkIn, input.checkOut, input.guests as never, input.seasons),
    );

    const save = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      preCheckInArgs("partly priced", "extend"),
    );

    // $50 + $50 + the blank's $56 kept, then two new nights at $50.
    expect(save.priceBreakdown.guests[0]!.perNightCents).toEqual([5000, 5000, 5600, RATE, RATE]);
    expect(save.priceBreakdown.guests[0]!.priceCents).toBe(15600 + 2 * RATE);
  });
});

/**
 * #4317 review H1, THE PROBE THAT FOUND IT: A ($200, no night rows) and B ($200)
 * under a headline a parked edit froze at $600. Extending both by one $50 night
 * buys $100. Read as the bare sum of the guests, the new total was $500 and the
 * edit REFUNDED $100 for $100 of nights bought; carried forward it is $700 and
 * the edit charges $100. Pinned on both pricing paths, and the quote's planner
 * agrees with the save.
 */
describe("#4317 review H1: a frozen headline is carried, never settled by an edit", () => {
  const A = guest("g1", "m1", [], 20_000);
  const B = guest("g2", "m2", sold([6667, 6667, 6666]), 20_000);
  const FROZEN = {
    id: "bk-frozen",
    checkIn: D(HELD[0]),
    checkOut: D("2026-08-23"),
    totalPriceCents: 60_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 60_000,
    guests: [A, B],
  };

  beforeEach(() => {
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockImplementation(
      async (_db, input) =>
        calculateBookingPrice(input.checkIn, input.checkOut, input.guests as never, input.seasons),
    );
  });

  it("before the stay: +$100, and the $600 headline becomes $700", async () => {
    const booking = { ...FROZEN, memberId: "m1", lodgeId: "lodge-1" };
    const save = await calculateModifiedPricing(NO_DISCOUNT_TX, {
      booking: booking as never,
      bookingId: "bk-frozen",
      isInProgressEdit: false,
      editableFrom: null,
      newCheckIn: D(HELD[0]),
      newCheckOut: D("2026-08-24"),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: booking.guests.map((g) => ({
        bookingGuestId: g.id,
        ageTier: "ADULT" as const,
        isMember: true,
        memberId: g.memberId,
        rateMembershipTypeId: MEMBER_TYPE,
        rateSource: "OWN_TYPE" as const,
        stayStart: D(HELD[0]),
        stayEnd: D("2026-08-24"),
        nights: [...HELD, "2026-08-23"].map(D),
        ...editedGuestPricingLocks(g, booking, false),
      })),
      skipBookingLifecycleRules: false,
      seasonRateData: SEASONS as never,
      partnerSharedGuests: [],
    });

    expect(save.priceBreakdown.guests.map((g) => g.priceCents)).toEqual([25_000, 25_000]);
    expect(save.newTotalPriceCents).toBe(70_000);
    expect(save.newTotalPriceCents - FROZEN.totalPriceCents).toBe(2 * RATE);
  });

  it("during the stay: the quote's planner and the save both charge +$100 and carry the gap", async () => {
    const input: BuildInProgressGuestRangePlanInput = {
      booking: FROZEN,
      editableFrom: D("2026-08-21"),
      newCheckOut: D("2026-08-24"),
      seasons: SEASONS,
    };
    const quote = buildInProgressGuestRangePlan(input).plan;
    const save = await calculateModifiedPricing(NO_DISCOUNT_TX, {
      booking: { ...FROZEN, memberId: "m1", lodgeId: "lodge-1" } as never,
      bookingId: "bk-frozen",
      isInProgressEdit: true,
      editableFrom: input.editableFrom,
      newCheckIn: FROZEN.checkIn,
      newCheckOut: input.newCheckOut,
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: FROZEN.guests.map((g) => ({
        bookingGuestId: g.id,
        ageTier: "ADULT" as const,
        isMember: true,
        memberId: g.memberId ?? null,
        stayStart: FROZEN.checkIn,
        stayEnd: input.newCheckOut,
      })),
      skipBookingLifecycleRules: false,
      seasonRateData: SEASONS as never,
      partnerSharedGuests: [],
    });

    expect(quote.priceDiffCents).toBe(2 * RATE);
    expect(quote.newTotalPriceCents).toBe(70_000);
    expect(save.newTotalPriceCents).toBe(quote.newTotalPriceCents);
  });
});

/**
 * #4317 review round 2: a headline frozen BELOW its guests can carry an edit's
 * change under zero. The quote's planner and the save refuse it alike, before
 * anything is priced into the booking: $100 over $100 + $300 of guests, the
 * $300 guest removed, would be -$200.
 */
describe("#4317 review round 2: an edit that would carry a headline below zero is refused", () => {
  const LOW = guest("g1", "m1", sold([3334, 3333, 3333]), 10_000);
  const HIGH = guest("g2", "m2", sold([10_000, 10_000, 10_000]), 30_000);
  const BELOW = {
    id: "bk-below",
    checkIn: D(HELD[0]),
    checkOut: D("2026-08-23"),
    totalPriceCents: 10_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 10_000,
    guests: [LOW, HIGH],
  };

  it("during the stay: the quote's planner and the save both refuse", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    const input: BuildInProgressGuestRangePlanInput = {
      booking: BELOW,
      editableFrom: D("2026-08-21"),
      newCheckOut: D("2026-08-23"),
      removeGuestIds: ["g2"],
      seasons: SEASONS,
    };
    expect(() => buildInProgressGuestRangePlan(input)).toThrow(NegativeEditedHeadlineError);
    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        booking: { ...BELOW, memberId: "m1", lodgeId: "lodge-1" } as never,
        bookingId: "bk-below",
        isInProgressEdit: true,
        editableFrom: input.editableFrom,
        newCheckIn: BELOW.checkIn,
        newCheckOut: input.newCheckOut,
        normalizedAddGuests: undefined,
        removeGuestIds: ["g2"],
        guestsForPricing: [LOW].map((g) => ({
          bookingGuestId: g.id,
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: g.memberId,
          stayStart: BELOW.checkIn,
          stayEnd: input.newCheckOut,
        })),
        skipBookingLifecycleRules: false,
        seasonRateData: SEASONS as never,
        partnerSharedGuests: [],
      }),
    ).rejects.toBeInstanceOf(NegativeEditedHeadlineError);
  });

  it("before the stay: the save refuses removing the $300 guest", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockImplementation(
      async (_db, input) =>
        calculateBookingPrice(input.checkIn, input.checkOut, input.guests as never, input.seasons),
    );
    const booking = { ...BELOW, memberId: "m1", lodgeId: "lodge-1" };
    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        booking: booking as never,
        bookingId: "bk-below",
        isInProgressEdit: false,
        editableFrom: null,
        newCheckIn: BELOW.checkIn,
        newCheckOut: BELOW.checkOut,
        normalizedAddGuests: undefined,
        removeGuestIds: ["g2"],
        guestsForPricing: [LOW].map((g) => ({
          bookingGuestId: g.id,
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: g.memberId,
          rateMembershipTypeId: MEMBER_TYPE,
          rateSource: "OWN_TYPE" as const,
          stayStart: BELOW.checkIn,
          stayEnd: BELOW.checkOut,
          nights: HELD.map(D),
          ...editedGuestPricingLocks(g, booking, false),
        })),
        skipBookingLifecycleRules: false,
        seasonRateData: SEASONS as never,
        partnerSharedGuests: [],
      }),
    ).rejects.toBeInstanceOf(NegativeEditedHeadlineError);
  });
});

/**
 * #4317 review round 3: the in-progress plan caps the promotion it carries at
 * its new total, as the engine caps every code a re-deciding door prices, and
 * flags it so the save and the quote re-decide the promotion's records over the
 * plan's own nights. A legitimate discounted reduction is priced, never refused.
 */
describe("#4317 review rounds 3 and 4: an in-progress plan carries its promotion and caps it", () => {
  const night = (date: string, cents: number) => ({ stayDate: D(date), priceCents: cents, priceSource: "SOLD" as const });
  const SHORTEN_A = guest("g1", "m1", [night(HELD[0], 5000), night(HELD[1], 0), night(HELD[2], 5000)], 10_000);
  const SHORTEN_B = guest("g2", "m2", [night(HELD[0], 2500), night(HELD[1], 2500), night(HELD[2], 25_000)], 30_000);

  function promotedBooking(guests: ReturnType<typeof guest>[], promoAdjustmentCents: number) {
    const totalPriceCents = guests.reduce((sum, g) => sum + g.priceCents, 0);
    return {
      id: "bk-promo",
      checkIn: D(HELD[0]),
      checkOut: D("2026-08-23"),
      totalPriceCents,
      discountCents: -promoAdjustmentCents,
      promoAdjustmentCents,
      finalPriceCents: totalPriceCents + promoAdjustmentCents,
      guests,
    };
  }

  it("$400 with a fixed $350 code, shortened mid-stay to $100: priced at $0, the code capped at $100", async () => {
    const booking = promotedBooking([SHORTEN_A, SHORTEN_B], -35_000);
    const input: BuildInProgressGuestRangePlanInput = {
      booking,
      editableFrom: D("2026-08-21"),
      newCheckOut: D("2026-08-22"),
      seasons: SEASONS,
    };
    const quote = buildInProgressGuestRangePlan(input).plan;

    expect(quote.newTotalPriceCents).toBe(10_000);
    expect(quote.promotionCappedAtNewTotal).toBe(true);
    expect(quote.newPromoAdjustmentCents).toBe(-10_000);
    expect(quote.newDiscountCents).toBe(10_000);
    expect(quote.newFinalPriceCents).toBe(0);
    // The member paid $50; the stay now costs nothing.
    expect(quote.priceDiffCents).toBe(-5_000);

    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] });
    const save = await calculateModifiedPricing(NO_DISCOUNT_TX, {
      booking: { ...booking, memberId: "m1", lodgeId: "lodge-1" } as never,
      bookingId: "bk-promo",
      isInProgressEdit: true,
      editableFrom: input.editableFrom,
      newCheckIn: booking.checkIn,
      newCheckOut: input.newCheckOut,
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: booking.guests.map((g) => ({
        bookingGuestId: g.id,
        ageTier: "ADULT" as const,
        isMember: true,
        memberId: g.memberId,
        stayStart: booking.checkIn,
        stayEnd: input.newCheckOut,
      })),
      skipBookingLifecycleRules: false,
      seasonRateData: SEASONS as never,
      partnerSharedGuests: [],
    });
    // The save prices the same plan and hands the promotion engine nothing: the
    // capped code is carried, never re-decided (round 4), so an expired code
    // still applies and the figure is the quote's.
    expect(save.newTotalPriceCents).toBe(quote.newTotalPriceCents);
    expect(save.inProgressPlan?.promotionCappedAtNewTotal).toBe(true);
    expect(save.inProgressPlan?.newPromoAdjustmentCents).toBe(quote.newPromoAdjustmentCents);
    expect(save.inProgressPlan?.priceDiffCents).toBe(quote.priceDiffCents);
    expect(save.guestNightRates).toEqual([]);
  });

  it("a deeper cut never refunds less: a 50% code's refund only grows as nights come off (round 4)", () => {
    // $50 a night from the 20th to the 29th, half off: $500, -$250, paid $250.
    const days = Array.from({ length: 10 }, (_, index) => `2026-08-${String(20 + index).padStart(2, "0")}`);
    const ten = {
      ...guest("g1", "m1", days.map((day) => night(day, RATE)), 10 * RATE),
      stayEnd: D("2026-08-30"),
    };
    const refundKeeping = (nights: number) =>
      -buildInProgressGuestRangePlan({
        booking: { ...promotedBooking([ten], -25_000), checkOut: D("2026-08-30") },
        editableFrom: D("2026-08-21"),
        newCheckOut: D(days[nights]!),
        seasons: SEASONS,
      }).plan.priceDiffCents;

    // Keeping 2..9 nights: the code is carried whole while the stay is worth
    // more than it, then capped, so the stay costs nothing - never a jump back
    // up where a re-decided 50% would take only half of what is left.
    const refunds = [9, 8, 7, 6, 5, 4, 3, 2].map(refundKeeping);
    expect(refunds).toEqual([5_000, 10_000, 15_000, 20_000, 25_000, 25_000, 25_000, 25_000]);
    for (let deeper = 1; deeper < refunds.length; deeper += 1) {
      expect(refunds[deeper]!).toBeGreaterThanOrEqual(refunds[deeper - 1]!);
    }
  });

  it("a 100% code, a guest removed mid-stay: priced at $0, the code capped at the $200 left", () => {
    const LOW = guest("g1", "m1", sold([3334, 3333, 3333]), 10_000);
    const HIGH = guest("g2", "m2", sold([10_000, 10_000, 10_000]), 30_000);
    const plan = buildInProgressGuestRangePlan({
      booking: promotedBooking([LOW, HIGH], -40_000),
      editableFrom: D("2026-08-21"),
      newCheckOut: D("2026-08-23"),
      removeGuestIds: ["g2"],
      seasons: SEASONS,
    }).plan;

    // g2 keeps the 20th it slept: $100 + $100 left.
    expect(plan.newTotalPriceCents).toBe(20_000);
    expect(plan.promotionCappedAtNewTotal).toBe(true);
    expect(plan.newPromoAdjustmentCents).toBe(-20_000);
    expect(plan.newFinalPriceCents).toBe(0);
    expect(plan.priceDiffCents).toBe(0);
  });

  it("CONTROL: a code smaller than what is left is carried exactly, and re-decided by nobody", () => {
    const plan = buildInProgressGuestRangePlan({
      booking: promotedBooking([SHORTEN_A, SHORTEN_B], -2_000),
      editableFrom: D("2026-08-21"),
      newCheckOut: D("2026-08-22"),
      seasons: SEASONS,
    }).plan;

    expect(plan.promotionCappedAtNewTotal).toBe(false);
    expect(plan.newPromoAdjustmentCents).toBe(-2_000);
    expect(plan.newDiscountCents).toBe(2_000);
    expect(plan.newFinalPriceCents).toBe(8_000);
  });
});

/**
 * #4317 review M2: a negative stored guest total (D11) refuses the edit on
 * every path; the database forbids one, so this guards an unreachable shape.
 */
describe("#4317 review M2: a negative stored guest total refuses the edit", () => {
  it.each([true, false])("in progress %s: the save refuses before pricing", async (inProgress) => {
    const negative = guest("g1", "m1", sold([RATE, RATE, RATE]), -700);
    const booking = {
      id: "bk-negative",
      memberId: "m1",
      lodgeId: "lodge-1",
      checkIn: D(HELD[0]),
      checkOut: D("2026-08-23"),
      totalPriceCents: COMPANION.priceCents - 700,
      discountCents: 0,
      promoAdjustmentCents: 0,
      finalPriceCents: COMPANION.priceCents - 700,
      guests: [negative, COMPANION],
    };
    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        booking: booking as never,
        bookingId: "bk-negative",
        isInProgressEdit: inProgress,
        editableFrom: inProgress ? D("2026-08-21") : null,
        newCheckIn: booking.checkIn,
        newCheckOut: D("2026-08-25"),
        normalizedAddGuests: undefined,
        removeGuestIds: undefined,
        guestsForPricing: booking.guests.map((g) => ({
          bookingGuestId: g.id,
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: g.memberId,
          stayStart: booking.checkIn,
          stayEnd: D("2026-08-25"),
        })),
        skipBookingLifecycleRules: false,
        seasonRateData: SEASONS as never,
        partnerSharedGuests: [],
      }),
    ).rejects.toBeInstanceOf(NegativeStoredGuestTotalError);
  });
});

describe("#3032 every door that can raise the fence surfaces its code", () => {
  /**
   * The pending-review fence (`assertNoPendingEditFinancialReview`) refuses a
   * second money-affecting edit with a 409 and a machine code. FOUR doors can
   * raise it — the preview, the save, the guest removal and the guest ADD — and a
   * member can meet the SAME refusal through any of them.
   *
   * WHY THIS IS A SOURCE SCAN. The property is an ORDERING one:
   * `EditFinancialReviewPendingError` extends `ApiError`, so a handler's generic
   * `ApiError` branch will happily catch it and answer with the right status, the
   * right sentence, and NO `code`. Nothing fails, nothing logs, and the panel that
   * would have offered "the club is pricing your last change" shows a bare error
   * instead. That is precisely the shape a behavioural test on the happy path
   * cannot see.
   *
   * WHAT THIS CENSUS GOT WRONG, AND WHY IT IS WORTH SAYING. The first version
   * searched for the literal `err instanceof ApiError`. `modify-quote/route.ts`
   * writes `error instanceof ApiError`, so for that door the match was -1, the
   * ordering assertion sat behind `if (genericBranch > -1)` and never ran at all —
   * a census passing because it matched nothing, which is the false green this
   * repository keeps getting caught by. Two more holes went with it: the "does it
   * surface the code" half accepted a bare `err.code` anywhere in the file, which
   * any unrelated branch satisfies, and the "is the fence handled" half accepted
   * the IMPORT of `EDIT_FINANCIAL_REVIEW_PENDING_CODE` at the top of the file,
   * which is above everything by construction.
   *
   * So all three halves are now tied to what the code WRITES:
   *
   *  - both spellings of the receiver, and both the local and the aliased shared
   *    `ApiError`, and the generic branch is REQUIRED rather than optional — a
   *    door with none is a change somebody must come and look at;
   *  - the fence must be handled at a real handling site (an `instanceof` branch,
   *    or a response literal naming the code), never at an import; and
   *  - the `code` must appear IN that handling site rather than anywhere in the
   *    file.
   *
   * Comments are stripped first. This repository documents each defect at the
   * site where it removed it, so the strings a scanner greps for are densest in
   * exactly the files that no longer commit the defect — including this feature's
   * own docblocks, which discuss the generic `ApiError` branch at length.
   *
   * The DELETE and the ADD routes additionally have real behavioural proofs, in
   * `guest-removal-minors-alert-route.test.ts` and
   * `guests-add-notify-choice.test.ts`; this is the census that stops the other
   * two drifting away from them.
   */
  const DOORS = [
    "src/app/api/bookings/[id]/modify-quote/route.ts",
    "src/app/api/bookings/[id]/modify/route.ts",
    "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    "src/app/api/bookings/[id]/guests/route.ts",
  ];

  /** How far past the handling site the `code` it answers with may sit. */
  const HANDLER_WINDOW = 600;

  it.each(DOORS)("%s answers with the code, above the generic branch", (door) => {
    const source = stripComments(
      fs.readFileSync(path.resolve(process.cwd(), door), "utf8"),
    );

    // A HANDLING site, not an import: an `instanceof` branch on the error, or a
    // response literal naming the code. `import { EDIT_FINANCIAL_REVIEW_PENDING_CODE }`
    // matches neither.
    const pendingBranch = source.search(
      /instanceof EditFinancialReviewPendingError|code:\s*EDIT_FINANCIAL_REVIEW_PENDING_CODE/,
    );
    expect(
      pendingBranch,
      `${door} must handle the fence at a real handling site, not merely import its code`,
    ).toBeGreaterThan(-1);

    // The code itself, and IN the handling site: a branch that caught the error
    // and answered without `code` would satisfy an `instanceof` check on its own,
    // and an `err.code` in some unrelated branch elsewhere would satisfy a
    // whole-file search.
    const handler = source.slice(pendingBranch, pendingBranch + HANDLER_WINDOW);
    expect(
      handler,
      `${door} must surface the fence's machine code where it answers it`,
    ).toMatch(/code:/);

    // Both receiver spellings (`err` and `error`) and both the local and the
    // aliased shared class, because the doors differ on every one of those and
    // a spelling this missed is an assertion that silently does not run.
    const genericBranch = source.search(
      /(?:err|error)\s+instanceof\s+(?:Shared)?ApiError(?![A-Za-z0-9_])/,
    );
    expect(
      genericBranch,
      `${door} has no generic ApiError branch this census can order against - ` +
        "if that is deliberate, this census has to be told so explicitly",
    ).toBeGreaterThan(-1);
    expect(
      pendingBranch,
      `${door}: the fence branch must precede the generic ApiError branch, ` +
        "which would otherwise swallow it and drop the code",
    ).toBeLessThan(genericBranch);
  });
});

describe("#3031 no magic zero reaches a night row", () => {
  /**
   * `syncGuestNights` used to write `bg?.perNightCents[k] ?? 0`.
   *
   * That write BECOMES the booking's sold-price history, so the default was a
   * real financial number - zero - put on a real night, which the next edit
   * would read back as evidence that the member paid nothing for it. Epic #2797
   * prohibits exactly that, and a per-night vector shorter than the night list
   * is a wiring defect in whoever built the breakdown rather than a night that
   * happens to be free.
   *
   * The state is unreachable through the planner, which is the point: the guard
   * exists so that a FUTURE breakdown builder fails loudly instead of quietly
   * zeroing a night. So it is driven here by handing `applyGuestChanges` the
   * malformed breakdown directly.
   */
  function writeDouble() {
    const created: unknown[] = [];
    return {
      created,
      tx: {
        bookingGuestNight: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn(async (args: { data: unknown }) => {
            created.push(args.data);
            return { count: 1 };
          }),
        },
        bookingGuest: { update: vi.fn().mockResolvedValue(undefined) },
      } as never,
    };
  }

  const PLAN_ENTRY = {
    guest: { id: "g1", memberId: "m1" },
    stayStart: D(HELD[0]),
    stayEnd: D("2026-08-23"),
    nights: HELD.map((night) => D(night)),
    perNightCents: [RATE, RATE, RATE],
    futureNights: [],
    priceCents: 3 * RATE,
    oldFuturePriceCents: 0,
    newFuturePriceCents: 0,
    futureDeltaCents: 0,
    removedFromFuture: false,
    futureStart: D(HELD[0]),
  };

  it("refuses to write a night the breakdown did not price", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = writeDouble();

    await expect(
      applyGuestChanges(tx, {
        guestDietarySeeding: bookingGuestDietarySeeding(false),
        bookingId: "bk-parity",
        newCheckIn: D(HELD[0]),
        newCheckOut: D("2026-08-23"),
        removedGuests: [],
        remainingGuests: [],
        proposedRemainingGuests: [],
        normalizedAddGuests: undefined,
        priceBreakdown: {
          guests: [
            {
              priceCents: 3 * RATE,
              // One amount short of the three nights below.
              perNightCents: [RATE, RATE],
              perNightPriceSources: ["SOLD", "SOLD", "SOLD"],
              nightDates: HELD.map((night) => D(night)),
            },
          ],
        },
        inProgressPlan: {
          proposedExistingGuests: [PLAN_ENTRY],
          proposedAddedGuests: [],
        } as never,
      }),
    ).rejects.toThrow(/No priced amount for the night of/);

    // And nothing was written: the refusal comes before the row insert, so a
    // partially-zeroed night set cannot survive the failure.
    expect(created).toEqual([]);
  });

  it("writes NULL where the breakdown SAYS the price is not known (#3170)", async () => {
    // THE OTHER HALF OF THE DISTINCTION the case above pins, and the two must be
    // read together: a vector that is SHORT is a wiring defect and throws, while
    // an explicit `null` is a statement that the night's price is not known and
    // is stored as `NULL`. Since #4317 the only producer of one is the identity
    // echo, writing back a NULL an older deploy stored; collapsing the two would
    // turn every future wiring bug into a silently unpriced night.
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = writeDouble();

    await applyGuestChanges(tx, {
      guestDietarySeeding: bookingGuestDietarySeeding(false),
      bookingId: "bk-parity",
      newCheckIn: D(HELD[0]),
      newCheckOut: D("2026-08-23"),
      removedGuests: [],
      remainingGuests: [],
      proposedRemainingGuests: [],
      normalizedAddGuests: undefined,
      priceBreakdown: {
        guests: [
          {
            priceCents: 3 * RATE,
            // Same LENGTH as the night list — nothing is missing. The middle
            // night's price is stated to be unknown.
            perNightCents: [RATE, null, RATE],
            perNightPriceSources: ["SOLD", "UNKNOWN", "SOLD"],
            nightDates: HELD.map((night) => D(night)),
          },
        ],
      },
      inProgressPlan: {
        proposedExistingGuests: [PLAN_ENTRY],
        proposedAddedGuests: [],
      } as never,
    });

    const rows = created[0] as Array<{ stayDate: Date; priceCents: number | null }>;
    expect(rows.map((row) => row.priceCents)).toEqual([RATE, null, RATE]);
    // Said separately, because `toEqual` would also pass on a 0 if someone
    // later relaxed the expectation: a stored 0 is a real sold price (a comped
    // night), so 0 can never stand in for "not known".
    expect(rows[1].priceCents).toBeNull();
    expect(rows[1].priceCents).not.toBe(0);
  });

  it("refuses a source vector shorter than the priced night vector (#3275)", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = writeDouble();

    await expect(
      applyGuestChanges(tx, {
        guestDietarySeeding: bookingGuestDietarySeeding(false),
        bookingId: "bk-parity",
        newCheckIn: D(HELD[0]),
        newCheckOut: D("2026-08-23"),
        removedGuests: [],
        remainingGuests: [],
        proposedRemainingGuests: [],
        normalizedAddGuests: undefined,
        priceBreakdown: {
          guests: [
            {
              priceCents: 3 * RATE,
              perNightCents: [RATE, RATE, RATE],
              // One provenance entry short: this is not permission to guess
              // SOLD for the final night.
              perNightPriceSources: ["SOLD", "SOLD"],
              nightDates: HELD.map((night) => D(night)),
            },
          ],
        },
        inProgressPlan: {
          proposedExistingGuests: [PLAN_ENTRY],
          proposedAddedGuests: [],
        } as never,
      }),
    ).rejects.toThrow(/received no price provenance/);

    expect(created).toEqual([]);
  });

  it("writes the priced amounts when the breakdown is complete", async () => {
    // The control, so the case above cannot pass on a function that always
    // throws.
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, created } = writeDouble();

    await applyGuestChanges(tx, {
      guestDietarySeeding: bookingGuestDietarySeeding(false),
      bookingId: "bk-parity",
      newCheckIn: D(HELD[0]),
      newCheckOut: D("2026-08-23"),
      removedGuests: [],
      remainingGuests: [],
      proposedRemainingGuests: [],
      normalizedAddGuests: undefined,
      priceBreakdown: {
        guests: [
          {
            priceCents: 3 * RATE,
            perNightCents: [RATE, RATE, RATE],
            perNightPriceSources: ["SOLD", "SOLD", "SOLD"],
            nightDates: HELD.map((night) => D(night)),
          },
        ],
      },
      inProgressPlan: {
        proposedExistingGuests: [PLAN_ENTRY],
        proposedAddedGuests: [],
      } as never,
    });

    expect(created).toEqual([
      HELD.map((night) => ({
        bookingGuestId: "g1",
        stayDate: D(night),
        priceCents: RATE,
        priceSource: "SOLD",
      })),
    ]);
  });
});
