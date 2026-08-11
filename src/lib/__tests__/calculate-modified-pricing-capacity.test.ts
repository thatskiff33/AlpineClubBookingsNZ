import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import {
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";

const h = vi.hoisted(() => ({
  checkCapacityForGuestRanges: vi.fn(),
  checkCapacityForPartnerSharedAdmission: vi.fn(),
}));

// Keep the real OverCapacityConfirmationRequiredError + overCapacityNights so the
// thrown class is the genuine one; only stub the DB-backed capacity queries.
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: h.checkCapacityForGuestRanges,
    checkCapacityForPartnerSharedAdmission: h.checkCapacityForPartnerSharedAdmission,
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

import { calculateModifiedPricing } from "@/lib/booking-modify-plan";
import { eachDateOnlyInRange } from "@/lib/date-only";
import {
  resolveGuestRateMembershipTypes,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function baseArgs() {
  const guest = {
    id: "g1",
    ageTier: "ADULT",
    isMember: true,
    memberId: "m1",
    stayStart: D("2026-09-10"),
    stayEnd: D("2026-09-13"),
    priceCents: 30000,
  };
  const booking = {
    id: "b1",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-09-10"),
    checkOut: D("2026-09-13"),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    guests: [guest],
  } as never;

  return {
    booking,
    bookingId: "b1",
    isInProgressEdit: false,
    editableFrom: null,
    newCheckIn: D("2026-09-10"),
    newCheckOut: D("2026-09-13"),
    normalizedAddGuests: undefined,
    removeGuestIds: undefined,
    guestsForPricing: [
      {
        bookingGuestId: "g1",
        ageTier: "ADULT" as const,
        isMember: true,
        memberId: "m1",
        stayStart: D("2026-09-10"),
        stayEnd: D("2026-09-13"),
      },
    ],
    skipBookingLifecycleRules: false,
    seasonRateData: [],
  };
}

const OVER_CAPACITY = {
  available: false,
  minAvailable: -1,
  nightDetails: [{ date: D("2026-09-11"), occupiedBeds: 30, availableBeds: -1 }],
};

// A whole-lodge-held night (ADR-001, issue #118): unavailable, but availableBeds
// is pinned to 0 (never negative) and flagged wholeLodgeHeld — exactly what
// checkCapacityForGuestRanges now returns for a night held by another booking.
const WHOLE_LODGE_HELD = {
  available: false,
  minAvailable: 0,
  nightDetails: [
    {
      date: D("2026-09-11"),
      occupiedBeds: 5,
      availableBeds: 0,
      wholeLodgeHeld: true,
    },
  ],
};

// #2756: `calculateModifiedPricing` now reads the club's group-discount setting
// once, up front, and hands the same config to whichever pricing path runs — so
// every double for it has to carry that row. `null` is a club that has NOT
// switched the discount on, which is every case in this file: these cases are
// about capacity ranges and per-night prices, and they must all come out exactly
// where they came out before the discount reached this planner.
const NO_DISCOUNT_TX = {
  groupDiscountSetting: { findUnique: async () => null },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("calculateModifiedPricing capacity (issue #1668)", () => {
  it("throws the existing 400 for a non-admin over-capacity edit", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);

    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        ...baseArgs(),
        adminOverride: false,
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "Not enough beds available for these changes",
    });
  });

  it("throws OverCapacityConfirmationRequiredError for an admin override without confirm", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);

    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        ...baseArgs(),
        adminOverride: true,
        confirmOverCapacity: false,
      }),
    ).rejects.toBeInstanceOf(OverCapacityConfirmationRequiredError);
  });

  it("member parity: a held night throws the SAME 400 as a full lodge for a non-admin edit (no exclusive signal)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(WHOLE_LODGE_HELD);

    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        ...baseArgs(),
        adminOverride: false,
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "Not enough beds available for these changes",
    });
  });

  it("held night unconfirmed admin override still routes through OverCapacityConfirmationRequiredError (member-parity confirm prompt, empty confirmable list)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(WHOLE_LODGE_HELD);

    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        ...baseArgs(),
        adminOverride: true,
        confirmOverCapacity: false,
      }),
    ).rejects.toBeInstanceOf(OverCapacityConfirmationRequiredError);
  });

  it("override NON-BYPASS: a CONFIRMED admin over-capacity override onto a held night throws WholeLodgeHoldBlockedError and does not proceed (decision 5)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(WHOLE_LODGE_HELD);

    let thrown: unknown;
    try {
      await calculateModifiedPricing(NO_DISCOUNT_TX, {
        ...baseArgs(),
        adminOverride: true,
        confirmOverCapacity: true,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(WholeLodgeHoldBlockedError);
    expect((thrown as WholeLodgeHoldBlockedError).blockedNights).toEqual([
      "2026-09-11",
    ]);
  });

  it("proceeds with capacityOverridden: true for a confirmed admin override", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(OVER_CAPACITY);
    vi.mocked(resolveGuestRateMembershipTypes).mockImplementation(
      ((_tx: unknown, { guests }: { guests: unknown[] }) =>
        Promise.resolve(guests)) as never,
    );
    const breakdown = {
      totalPriceCents: 32000,
      guests: [
        {
          priceCents: 32000,
          perNightCents: [16000, 16000],
          nightDates: [D("2026-09-10"), D("2026-09-11")],
        },
      ],
    };
    vi.mocked(priceBookingGuestsWithMembershipTypePolicy).mockResolvedValue(
      breakdown as never,
    );
    const tx = {
      groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    } as never;

    const result = await calculateModifiedPricing(tx, {
      ...baseArgs(),
      adminOverride: true,
      confirmOverCapacity: true,
    });

    expect(result.capacityOverridden).toBe(true);
    expect(result.newTotalPriceCents).toBe(32000);
  });
});

// #2029: the in-progress capacity check must cover the genuinely-new check-out-day
// night the widened edit window opened. These drive the REAL plan
// (buildInProgressGuestRangePlan) through calculateModifiedPricing with the
// capacity resolvers mocked, so a wrong range start (editableFrom instead of the
// corrected anchor) leaves the new night invisible and the assertions fail.
describe("calculateModifiedPricing in-progress check-out-day capacity (#2029)", () => {
  const MEMBER_TYPE = "type-member";
  const RATE = 5000;
  const SEASON = [
    {
      seasonId: "s1",
      startDate: D("2026-08-01"),
      endDate: D("2026-08-31"),
      rates: [{ ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: RATE }],
    },
  ];
  const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };
  const FULL = {
    available: false,
    minAvailable: -1,
    nightDetails: [{ date: D("2026-08-24"), occupiedBeds: 30, availableBeds: -1 }],
  };

  function existingGuest(stayStart: string, stayEnd: string, priceCents: number) {
    return {
      id: "g1",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D(stayStart),
      stayEnd: D(stayEnd),
      // #2736: the real query (`LoadedBookingForModify`) always includes the
      // guest's `BookingGuestNight` rows, so this double supplies them too —
      // without them these cases would only ever exercise the envelope FALLBACK
      // and quietly stop covering the branch production actually takes. They are
      // the envelope expanded, because this guest's stay is contiguous.
      nights: eachDateOnlyInRange(D(stayStart), D(stayEnd)).map((stayDate) => ({
        stayDate,
      })),
      priceCents,
    };
  }

  function inProgressArgs(opts: {
    editableFrom: string;
    newCheckOut: string;
    guestStayStart?: string;
    guestStayEnd?: string;
    guestPriceCents?: number;
    partnerSharedGuests?: Array<{ memberId: string; partnerMemberId: string }>;
  }) {
    const gStart = opts.guestStayStart ?? "2026-08-20";
    const gEnd = opts.guestStayEnd ?? "2026-08-24";
    const price = opts.guestPriceCents ?? 4 * RATE;
    const guest = existingGuest(gStart, gEnd, price);
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-20"),
        checkOut: D(gEnd),
        totalPriceCents: price,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: price,
        guests: [guest],
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      editableFrom: D(opts.editableFrom),
      newCheckIn: D("2026-08-20"),
      newCheckOut: D(opts.newCheckOut),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: [
        {
          bookingGuestId: "g1",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          stayStart: D(gStart),
          stayEnd: D(opts.newCheckOut),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASON as never,
      partnerSharedGuests: opts.partnerSharedGuests ?? [],
    };
  }

  it("(a) rejects a check-out-day +1 extension into a FULL night with the normal capacity error", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(FULL);

    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        ...inProgressArgs({ editableFrom: "2026-08-25", newCheckOut: "2026-08-25" }),
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "Not enough beds available for these changes",
    });

    // The resolver was asked about the check-out-day night (08-24), via both the
    // window start and a guest range that covers it.
    const call = h.checkCapacityForGuestRanges.mock.calls[0];
    expect(call[1]).toEqual(D("2026-08-24")); // rangeStart
    const ranges = call[3] as Array<{ stayStart: Date; stayEnd: Date }>;
    expect(ranges).toEqual([
      expect.objectContaining({ stayStart: D("2026-08-24"), stayEnd: D("2026-08-25") }),
    ]);
  });

  it("(b) succeeds when the check-out-day night has capacity, checking that night", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(NO_DISCOUNT_TX, {
      ...inProgressArgs({ editableFrom: "2026-08-25", newCheckOut: "2026-08-25" }),
    });

    // Charged exactly the one new night (ties to the pricing suite).
    expect(result.newTotalPriceCents).toBe(4 * RATE + RATE);
    expect(h.checkCapacityForGuestRanges.mock.calls[0][1]).toEqual(D("2026-08-24"));
  });

  it("(c) mid-stay extension checks from editableFrom (regression pin — unchanged)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    await calculateModifiedPricing(NO_DISCOUNT_TX, {
      ...inProgressArgs({ editableFrom: "2026-08-22", newCheckOut: "2026-08-26" }),
    });

    const call = h.checkCapacityForGuestRanges.mock.calls[0];
    expect(call[1]).toEqual(D("2026-08-22")); // == editableFrom, not lowered
    const ranges = call[3] as Array<{ stayStart: Date }>;
    expect(ranges[0].stayStart).toEqual(D("2026-08-22"));
  });

  it("(d) partner-shared path checks the check-out-day night and rejects when full", async () => {
    h.checkCapacityForPartnerSharedAdmission.mockResolvedValue({
      available: false,
      reason: "No partner-shared slot available on 2026-08-24",
      minAvailable: -1,
      nightDetails: [],
    });

    await expect(
      calculateModifiedPricing(NO_DISCOUNT_TX, {
        ...inProgressArgs({
          editableFrom: "2026-08-25",
          newCheckOut: "2026-08-25",
          partnerSharedGuests: [{ memberId: "m1", partnerMemberId: "m2" }],
        }),
      }),
    ).rejects.toMatchObject({
      constructor: ApiError,
      status: 400,
      message: "No partner-shared slot available on 2026-08-24",
    });

    expect(h.checkCapacityForPartnerSharedAdmission.mock.calls[0][1]).toEqual(
      D("2026-08-24"),
    );
  });

  it("(e) a future-dated partial-range guest never consumes capacity before arrival (#713)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    // Guest occupies [08-22, 08-24); editableFrom is 08-21 (they arrive later).
    await calculateModifiedPricing(NO_DISCOUNT_TX, {
      ...inProgressArgs({
        editableFrom: "2026-08-21",
        newCheckOut: "2026-08-26",
        guestStayStart: "2026-08-22",
        guestStayEnd: "2026-08-24",
        guestPriceCents: 2 * RATE,
      }),
    });

    const ranges = h.checkCapacityForGuestRanges.mock.calls[0][3] as Array<{
      stayStart: Date;
    }>;
    // Their checked range starts at their own arrival (08-22), never earlier —
    // no phantom bed consumed on 08-21.
    expect(ranges[0].stayStart).toEqual(D("2026-08-22"));
  });
});

// #2736: the per-night breakdown an in-progress edit hands to `applyGuestChanges`
// is what gets written back as `BookingGuestNight` rows, so it decides which
// nights the guest is recorded as holding after the edit — and therefore which
// nights the bed board, the roster and every later edit's locked prices see. It
// used to be built by expanding the plan's envelope, which silently filled a
// sparse guest's gap. These drive the REAL plan through `calculateModifiedPricing`.
describe("calculateModifiedPricing in-progress per-night breakdown (#2736)", () => {
  const MEMBER_TYPE = "type-member";
  const RATE = 5000;
  const SEASON = [
    {
      seasonId: "s1",
      startDate: D("2026-08-01"),
      endDate: D("2026-08-31"),
      rates: [
        { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: RATE },
      ],
    },
  ];
  const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };

  /** Nights 08-20 and 08-22 — home on the 21st. */
  function sparseArgs(priceCents: number) {
    const guest = {
      id: "g1",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D("2026-08-20"),
      stayEnd: D("2026-08-23"),
      nights: [{ stayDate: D("2026-08-20") }, { stayDate: D("2026-08-22") }],
      priceCents,
    };
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-20"),
        checkOut: D("2026-08-23"),
        totalPriceCents: priceCents,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: priceCents,
        guests: [guest],
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      editableFrom: D("2026-08-21"),
      newCheckIn: D("2026-08-20"),
      newCheckOut: D("2026-08-25"),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: [
        {
          bookingGuestId: "g1",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          stayStart: D("2026-08-20"),
          stayEnd: D("2026-08-25"),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASON as never,
      partnerSharedGuests: [],
    };
  }

  it("writes back the gap, not a continuous run", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      sparseArgs(2 * RATE),
    );

    // 20 and 22 kept, 21 still an absence, 23 and 24 bought by the extension.
    expect(result.priceBreakdown.guests[0].nightDates).toEqual([
      D("2026-08-20"),
      D("2026-08-22"),
      D("2026-08-23"),
      D("2026-08-24"),
    ]);
    expect(result.newTotalPriceCents).toBe(4 * RATE);
  });

  it("splits the total in whole cents that sum back exactly", async () => {
    // An odd total over four nights: the remainder lands on the earliest nights
    // one cent at a time and the parts are integers (INV-MONEY-001,
    // INV-MONEY-003) — no float division, no rounding drift.
    //
    // This guest's rows arrive without their price, so #2744's real-rate
    // write-back has nothing to recover and the even split is still what lands —
    // the behaviour this fixture pinned before, unchanged. That shape is a
    // THINNER select, not a state the database can hold: `BookingGuestNight.
    // priceCents` is NOT NULL and both production loaders ask for it, which
    // `in-progress-edit-sold-price-census.test.ts` is what keeps true. The two
    // fallbacks a live booking can actually reach are a guest with NO rows
    // (pre-`BookingGuestNight`, or created by approving a request — #2739) and a
    // guest whose stored total has drifted from their rows; both are covered by
    // the matrix in `booking-edit-guest-ranges-sparse.test.ts`.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(NO_DISCOUNT_TX, sparseArgs(1001));
    const guest = result.priceBreakdown.guests[0];

    expect(guest.perNightCents).toHaveLength(guest.nightDates.length);
    for (const cents of guest.perNightCents) {
      expect(Number.isInteger(cents)).toBe(true);
    }
    expect(guest.perNightCents.reduce((a, b) => a + b, 0)).toBe(guest.priceCents);
    expect(guest.priceCents).toBe(1001 + 2 * RATE);
  });
});

// #2743: an edit sells only the nights it creates. The sparse suite asserts that
// on the PLAN's return value; this asserts it on what the writer is actually
// handed, which is a different array. `applyGuestChanges` → `syncGuestNights`
// consumes `priceBreakdown.guests[].nightDates`, matched POSITIONALLY over
// `proposedExistingGuests`, and re-derives the stored `BookingGuest.stayStart` /
// `stayEnd` from the first and last of those dates rather than from the plan's
// own envelope. So a plan that is right and a breakdown that is wrong would
// still write the wrong rows and reserve the wrong beds. These cases drive the
// REAL plan through `calculateModifiedPricing` and read the breakdown.
describe("calculateModifiedPricing in-progress departed guest (#2743)", () => {
  const MEMBER_TYPE = "type-member";
  const RATE = 5000;
  const SEASON = [
    {
      seasonId: "s1",
      startDate: D("2026-08-01"),
      endDate: D("2026-08-31"),
      rates: [
        { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: RATE },
      ],
    },
  ];
  const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };

  /** A guest built from the nights they hold, the way the writer derives them. */
  function guestOf(id: string, memberId: string, nights: string[]) {
    const sorted = [...nights].sort();
    return {
      id,
      ageTier: "ADULT",
      isMember: true,
      memberId,
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D(sorted[0]),
      stayEnd: D(
        new Date(D(sorted[sorted.length - 1]).getTime() + 86_400_000)
          .toISOString()
          .slice(0, 10),
      ),
      nights: sorted.map((stayDate) => ({ stayDate: D(stayDate) })),
      priceCents: sorted.length * RATE,
    };
  }

  /**
   * Booking 18 → 23 Aug. `g1` went home after the 19th; `g2` is there for the
   * whole run. It is the 21st, so the edit window opens on the 22nd.
   */
  function departedGuestArgs(newCheckOut: string) {
    const gone = guestOf("g1", "m1", ["2026-08-18", "2026-08-19"]);
    const present = guestOf("g2", "m2", [
      "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22",
    ]);
    const totalPriceCents = gone.priceCents + present.priceCents;
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-18"),
        checkOut: D("2026-08-23"),
        totalPriceCents,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: totalPriceCents,
        guests: [gone, present],
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      editableFrom: D("2026-08-22"),
      newCheckIn: D("2026-08-18"),
      newCheckOut: D(newCheckOut),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: [
        {
          bookingGuestId: "g1",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          stayStart: D("2026-08-18"),
          stayEnd: D(newCheckOut),
        },
        {
          bookingGuestId: "g2",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m2",
          stayStart: D("2026-08-18"),
          stayEnd: D(newCheckOut),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASON as never,
      partnerSharedGuests: [],
    };
  }

  it("hands the writer only the departed guest's own nights, and moves no money", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      departedGuestArgs("2026-08-23"),
    );
    const [gone, present] = result.priceBreakdown.guests;

    // The rows the writer will persist, and the envelope it re-derives from
    // them: the 18th and the 19th, full stop. Before #2743 this array was the
    // 18th to the 22nd and the member was billed three nights for somebody who
    // had gone home.
    expect(gone.nightDates).toEqual([D("2026-08-18"), D("2026-08-19")]);
    expect(gone.priceCents).toBe(2 * RATE);
    expect(gone.perNightCents.reduce((a, b) => a + b, 0)).toBe(gone.priceCents);
    // The guest who is actually there is untouched.
    expect(present.nightDates).toEqual([
      D("2026-08-18"), D("2026-08-19"), D("2026-08-20"), D("2026-08-21"),
      D("2026-08-22"),
    ]);
    expect(result.newTotalPriceCents).toBe(7 * RATE);
  });

  it("still gives them the nights an extension genuinely creates, as a second run with the gap intact", async () => {
    // The accepted residual, measured on the writer's own array rather than on
    // the plan: extending to the 25th admits the departed guest for the two
    // nights past the OLD check-out and nothing between. The stored envelope
    // that gets re-derived from this is 18 Aug → 25 Aug with two nights of
    // absence inside it — which is why the bed board reads the night rows and
    // never the envelope (INV-DATE-012, INV-MOD-025).
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      departedGuestArgs("2026-08-25"),
    );
    const [gone] = result.priceBreakdown.guests;

    expect(gone.nightDates).toEqual([
      D("2026-08-18"),
      D("2026-08-19"),
      // the 20th, 21st and 22nd are NOT theirs
      D("2026-08-23"),
      D("2026-08-24"),
    ]);
    expect(gone.priceCents).toBe(4 * RATE);
  });
});

describe("calculateModifiedPricing in-progress per-night prices (#2744)", () => {
  const MEMBER_TYPE = "type-member";
  const LOW = 5000;
  const HIGH = 9000;
  const SEASONS = [
    {
      seasonId: "s-low",
      startDate: D("2026-08-01"),
      endDate: D("2026-08-22"),
      rates: [
        { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: LOW },
      ],
    },
    {
      seasonId: "s-high",
      startDate: D("2026-08-23"),
      endDate: D("2026-09-30"),
      rates: [
        { ageTier: "ADULT", membershipTypeId: MEMBER_TYPE, pricePerNightCents: HIGH },
      ],
    },
  ];
  const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };

  /**
   * The guest from the issue: nights 08-20 and 08-22, both bought at LOW, with
   * the rows recording it. The edit extends the check-out to the 25th, so the
   * 23rd and 24th are bought now at HIGH.
   */
  function args({ withCompanion = false }: { withCompanion?: boolean } = {}) {
    const guest = {
      id: "g1",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D("2026-08-20"),
      stayEnd: D("2026-08-23"),
      nights: [
        { stayDate: D("2026-08-20"), priceCents: LOW },
        { stayDate: D("2026-08-22"), priceCents: LOW },
      ],
      priceCents: 2 * LOW,
    };
    // A second guest on the whole run, so taking g1 off does not leave the
    // booking with future nights nobody holds (which the plan refuses, #2736).
    const companion = {
      ...guest,
      id: "g2",
      memberId: "m2",
      nights: [
        { stayDate: D("2026-08-20"), priceCents: LOW },
        { stayDate: D("2026-08-21"), priceCents: LOW },
        { stayDate: D("2026-08-22"), priceCents: LOW },
      ],
      priceCents: 3 * LOW,
    };
    const guests = withCompanion ? [guest, companion] : [guest];
    const totalPriceCents = guests.reduce((sum, g) => sum + g.priceCents, 0);
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-20"),
        checkOut: D("2026-08-23"),
        totalPriceCents,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: totalPriceCents,
        guests,
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      editableFrom: D("2026-08-21"),
      newCheckIn: D("2026-08-20"),
      newCheckOut: D("2026-08-25"),
      normalizedAddGuests: undefined,
      removeGuestIds: undefined,
      guestsForPricing: [
        {
          bookingGuestId: "g1",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m1",
          stayStart: D("2026-08-20"),
          stayEnd: D("2026-08-25"),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASONS as never,
      partnerSharedGuests: [],
    };
  }

  it("persists each night's real rate, not the guest's average", async () => {
    // `applyGuestChanges`/`syncGuestNights` writes `perNightCents[k]` onto the
    // `BookingGuestNight` row for `nightDates[k]`, and `lockedNightPricesForGuest`
    // hands that column to the NEXT edit — so these four numbers are what the
    // system will later believe the member paid. They used to be four copies of
    // the average (7000 each); they are the real rates now.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(NO_DISCOUNT_TX, args());
    const guest = result.priceBreakdown.guests[0];

    expect(guest.nightDates).toEqual([
      D("2026-08-20"),
      D("2026-08-22"),
      D("2026-08-23"),
      D("2026-08-24"),
    ]);
    expect(guest.perNightCents).toEqual([LOW, LOW, HIGH, HIGH]);
    expect(guest.perNightCents.reduce((a, b) => a + b, 0)).toBe(guest.priceCents);
    expect(result.newTotalPriceCents).toBe(2 * LOW + 2 * HIGH);
    // Xero rebuilds its lines per contiguous run of equal price, so the runs
    // have to multiply back out: 2 x LOW and 2 x HIGH, no phantom balance.
    expect(2 * LOW + 2 * HIGH).toBe(guest.priceCents);
  });

  /**
   * A removal ACROSS a rate rise, which is the shape the refund half of #2744
   * exists for. Both nights sit in the HIGH season (from 08-23) but were bought
   * at LOW and the rows say so, so the price the member paid and the price the
   * table would quote today are DIFFERENT NUMBERS — which is what makes the
   * assertions below discriminate. An earlier version of this fixture gave back
   * 2026-08-22, a night the `s-low` season still covers, so the stored price and
   * today's rate were the same LOW and the test passed with the locked prices
   * removed from the pricing window entirely.
   */
  function removalArgs(
    {
      withNightRows = true,
      editableFrom = D("2026-08-24"),
    }: { withNightRows?: boolean; editableFrom?: Date } = {},
  ) {
    const guest = {
      id: "g1",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      rateMembershipTypeId: MEMBER_TYPE,
      rateSource: "OWN_TYPE",
      stayStart: D("2026-08-23"),
      stayEnd: D("2026-08-25"),
      nights: withNightRows
        ? [
            { stayDate: D("2026-08-23"), priceCents: LOW },
            { stayDate: D("2026-08-24"), priceCents: LOW },
          ]
        : [],
      priceCents: 2 * LOW,
    };
    // A companion on the same nights, so taking g1 off does not leave the
    // booking with future nights nobody holds (which the plan refuses, #2736).
    // Always rowed: the shape under test is g1's, not the booking's.
    const companion = {
      ...guest,
      id: "g2",
      memberId: "m2",
      nights: [
        { stayDate: D("2026-08-23"), priceCents: LOW },
        { stayDate: D("2026-08-24"), priceCents: LOW },
      ],
    };
    const totalPriceCents = 4 * LOW;
    return {
      booking: {
        id: "b1",
        memberId: "m1",
        lodgeId: "lodge-1",
        checkIn: D("2026-08-23"),
        checkOut: D("2026-08-25"),
        totalPriceCents,
        discountCents: 0,
        promoAdjustmentCents: 0,
        finalPriceCents: totalPriceCents,
        guests: [guest, companion],
      } as never,
      bookingId: "b1",
      isInProgressEdit: true,
      // The 24th is the only night this edit can still touch; the 23rd is slept.
      editableFrom,
      newCheckIn: D("2026-08-23"),
      newCheckOut: D("2026-08-25"),
      normalizedAddGuests: undefined,
      removeGuestIds: ["g1"],
      guestsForPricing: [
        {
          bookingGuestId: "g2",
          ageTier: "ADULT" as const,
          isMember: true,
          memberId: "m2",
          stayStart: D("2026-08-23"),
          stayEnd: D("2026-08-25"),
        },
      ],
      skipBookingLifecycleRules: false,
      seasonRateData: SEASONS as never,
      partnerSharedGuests: [],
    };
  }

  it("credits a removal at the stored price, so nobody comes off owing less than nothing", async () => {
    // The club has raised its rate to HIGH since this booking was made, and an
    // officer takes the guest off from the 24th. The 24th is given back at the
    // LOW it was sold for — not the HIGH it would cost to buy today — leaving
    // exactly the 23rd they slept, at what they paid for it.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(NO_DISCOUNT_TX, removalArgs());
    const guest = result.priceBreakdown.guests[0];
    const plan = result.inProgressPlan?.proposedExistingGuests[0];

    // The two numbers this test turns on: what they paid, and what it costs now.
    expect(HIGH).not.toBe(LOW);
    expect(plan?.oldFuturePriceCents).toBe(LOW);
    expect(plan?.futureDeltaCents).toBe(-LOW);
    expect(guest.priceCents).toBe(LOW);
    // Acceptance criterion 1, through the real wiring: nobody comes off a
    // booking owing less than nothing. Crediting today's HIGH against a stored
    // 2 x LOW is what used to leave a guest who genuinely slept at the lodge
    // showing 1000 instead of 5000 — still positive here only by accident of
    // the numbers, which is why the delta above is asserted too.
    expect(guest.priceCents).toBeGreaterThanOrEqual(0);
    expect(guest.nightDates).toEqual([D("2026-08-23")]);
    expect(guest.perNightCents).toEqual([LOW]);
  });

  it("never credits back more than the guest paid when no row records a price", async () => {
    // The population the locked prices cannot reach: a booking created by
    // approving a booking request, which still writes no `BookingGuestNight`
    // rows at all (#2739). Those nights have no sold price. Valued at TODAY's
    // rate — 2 x HIGH = 18000 against a stored 2 x LOW = 10000 — the guest came
    // off the booking at -8000 before #2744's ceiling, and at exactly zero after
    // it, because the ceiling had to cut the credit back to their whole stored
    // total. #2771 values the two nights from that total in the first place:
    // today's table prices both nights the same, so their 10000 shares out 5000
    // and 5000, which is the same 10000 here because both nights are given back.
    // What this asserts is unchanged and what produces it is not — the credit is
    // bounded by their own money rather than clamped after the fact.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      removalArgs({
        withNightRows: false,
        // Removed from the 23rd, so BOTH nights are given back and the raw
        // credit (2 x HIGH) exceeds the whole stored total.
        editableFrom: D("2026-08-23"),
      }),
    );
    const guest = result.priceBreakdown.guests[0];
    const plan = result.inProgressPlan?.proposedExistingGuests[0];

    expect(2 * HIGH).toBeGreaterThan(2 * LOW);
    expect(plan?.oldFuturePriceCents).toBe(2 * LOW);
    expect(guest.priceCents).toBe(0);
    expect(guest.priceCents).toBeGreaterThanOrEqual(0);
    expect(guest.perNightCents.every((cents) => cents >= 0)).toBe(true);
  });

  it("credits a row-less guest their own average for the one night they give back (#2771)", async () => {
    // The same booking, one night later: the 23rd is slept and only the 24th is
    // given back, so the ceiling is nowhere near and the two rules disagree in
    // the open. Two nights bought for 2 x LOW = 10000 with no rows to say which
    // was which; the club has since raised the rate to HIGH.
    //
    // Today's rate credited the whole 9000 for that one night, leaving a member
    // who had slept the 23rd carrying 1000 for it — the club handing back nearly
    // everything it had taken for HALF the stay. Their own 10000 shared between
    // two nights the table prices equally is 5000 each, so they give back 5000
    // and keep 5000, which is what they paid a night.
    h.checkCapacityForGuestRanges.mockResolvedValue(AVAILABLE);

    const result = await calculateModifiedPricing(
      NO_DISCOUNT_TX,
      removalArgs({ withNightRows: false }),
    );
    const guest = result.priceBreakdown.guests[0];
    const plan = result.inProgressPlan?.proposedExistingGuests[0];

    expect(plan?.oldFuturePriceCents).toBe(LOW);
    expect(plan?.oldFuturePriceCents).not.toBe(HIGH);
    expect(plan?.futureDeltaCents).toBe(-LOW);
    expect(guest.priceCents).toBe(LOW);
    expect(guest.nightDates).toEqual([D("2026-08-23")]);
    expect(guest.perNightCents).toEqual([LOW]);
  });
});
