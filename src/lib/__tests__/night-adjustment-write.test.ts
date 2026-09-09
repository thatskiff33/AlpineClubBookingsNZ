import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { parseDateOnly } from "@/lib/date-only";
import {
  deriveNightAdjustmentState,
  NIGHT_ADJUSTMENT_INVARIANT,
  reconcilePromoAdjustmentTargets,
  recordBookingNightAdjustments,
  restoreBookingNightAdjustments,
  snapshotBookingNightAdjustments,
  type PromoAdjustmentTarget,
} from "@/lib/night-adjustment-write";

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: loggerMocks.warn, error: loggerMocks.error, debug: vi.fn() },
}));

/**
 * #3276: the one writer of the night adjustment build-up, exercised against a
 * recording transaction double, and the one derivation of whether a booking's
 * build-up can be trusted. The reconciliation guard (INV-MONEY-029) is proved
 * in both directions; every refusal is proved to leave the transaction
 * untouched (refuse before mutate).
 */

const d = parseDateOnly;
const N1 = d("2026-08-01");
const N2 = d("2026-08-02");

type Recorded = {
  adjustmentDeleteMany: ReturnType<typeof vi.fn>;
  adjustmentCreateMany: ReturnType<typeof vi.fn>;
  adjustmentFindMany: ReturnType<typeof vi.fn>;
  redemptionFindUnique: ReturnType<typeof vi.fn>;
  nightFindMany: ReturnType<typeof vi.fn>;
  guestFindMany: ReturnType<typeof vi.fn>;
  order: string[];
};

function fakeTx(options: {
  redemption?: {
    id: string;
    promoCodeId: string;
    priceAdjustmentCents: number;
    allocations: Array<{ memberId: string; priceAdjustmentCents: number }>;
  } | null;
  nights?: Array<{
    id: string;
    bookingGuestId: string;
    stayDate: Date;
    adjustments?: Array<Record<string, unknown>>;
  }>;
  guests?: Array<{ id: string }>;
  adjustments?: Array<Record<string, unknown>>;
}): { tx: Prisma.TransactionClient; recorded: Recorded } {
  const order: string[] = [];
  const track = (name: string, value: unknown) =>
    vi.fn(async () => {
      order.push(name);
      return value;
    });
  const recorded: Recorded = {
    adjustmentDeleteMany: track("adjustment.deleteMany", { count: 0 }),
    adjustmentCreateMany: track("adjustment.createMany", { count: 0 }),
    adjustmentFindMany: track("adjustment.findMany", options.adjustments ?? []),
    redemptionFindUnique: track("redemption.findUnique", options.redemption ?? null),
    nightFindMany: track(
      "night.findMany",
      (options.nights ?? []).map((night) => ({ adjustments: [], ...night })),
    ),
    guestFindMany: track("guest.findMany", options.guests ?? []),
    order,
  };
  const tx = {
    bookingGuestNightAdjustment: {
      deleteMany: recorded.adjustmentDeleteMany,
      createMany: recorded.adjustmentCreateMany,
      findMany: recorded.adjustmentFindMany,
    },
    promoRedemption: { findUnique: recorded.redemptionFindUnique },
    bookingGuestNight: { findMany: recorded.nightFindMany },
    bookingGuest: { findMany: recorded.guestFindMany },
  } as unknown as Prisma.TransactionClient;
  return { tx, recorded };
}

function nothingWritten(recorded: Recorded) {
  expect(recorded.adjustmentDeleteMany).not.toHaveBeenCalled();
  expect(recorded.adjustmentCreateMany).not.toHaveBeenCalled();
}

const REDEMPTION = {
  id: "redemption-1",
  promoCodeId: "promo-1",
  priceAdjustmentCents: -1500,
  allocations: [{ memberId: "booker", priceAdjustmentCents: -1500 }],
};
const NIGHTS = [
  { id: "night-a1", bookingGuestId: "guest-a", stayDate: N1 },
  { id: "night-a2", bookingGuestId: "guest-a", stayDate: N2 },
  { id: "night-b1", bookingGuestId: "guest-b", stayDate: N1 },
];
const TARGETS: PromoAdjustmentTarget[] = [
  { guestIndex: 0, scope: "night", stayDate: N1, beneficiaryMemberId: "booker", amountCents: -500 },
  { guestIndex: 0, scope: "night", stayDate: N2, beneficiaryMemberId: "booker", amountCents: -400 },
  { guestIndex: 1, scope: "guest", stayDate: null, beneficiaryMemberId: "booker", amountCents: -600 },
];
const ROW = (bookingGuestNightId: string | null, bookingGuestId: string | null, amountCents: number | null) => ({
  kind: "PROMO" as const,
  amountCents,
  bookingGuestNightId,
  bookingGuestId,
  bookingId: "booking-1",
  promoRedemptionId: "redemption-1",
  promoCodeId: "promo-1",
  beneficiaryMemberId: "booker",
});

describe("reconcilePromoAdjustmentTargets (INV-MONEY-029)", () => {
  const base = { targets: TARGETS, allocations: REDEMPTION.allocations, priceAdjustmentCents: -1500, context: "test" };

  it("passes rows that sum to the recorded allocation and redemption totals", () => {
    expect(() => reconcilePromoAdjustmentTargets(base)).not.toThrow();
  });

  it("refuses when a beneficiary's rows do not sum to their allocation, naming the invariant", () => {
    expect(() =>
      reconcilePromoAdjustmentTargets({
        ...base,
        allocations: [{ memberId: "booker", priceAdjustmentCents: -1400 }],
      }),
    ).toThrow(new RegExp(`${NIGHT_ADJUSTMENT_INVARIANT}.*booker.*-1500.*-1400`));
  });

  it("refuses when the rows sum to the allocations but not to the redemption total", () => {
    expect(() => reconcilePromoAdjustmentTargets({ ...base, priceAdjustmentCents: -1600 })).toThrow(
      new RegExp(`${NIGHT_ADJUSTMENT_INVARIANT}.*-1500.*-1600`),
    );
  });

  it("treats an absent allocation as zero received, so a SET_PRICE net-zero member reconciles", () => {
    expect(() =>
      reconcilePromoAdjustmentTargets({
        targets: [
          { beneficiaryMemberId: "even", amountCents: 500 },
          { beneficiaryMemberId: "even", amountCents: -500 },
        ],
        allocations: [],
        priceAdjustmentCents: 0,
        context: "test",
      }),
    ).not.toThrow();
  });

  it("refuses an allocation with no rows behind it", () => {
    expect(() =>
      reconcilePromoAdjustmentTargets({
        targets: [],
        allocations: [{ memberId: "ghost", priceAdjustmentCents: -100 }],
        priceAdjustmentCents: -100,
        context: "test",
      }),
    ).toThrow(new RegExp(`${NIGHT_ADJUSTMENT_INVARIANT}.*ghost`));
  });

  it("excludes a NOT KNOWN beneficiary from both sums instead of reading null as zero", () => {
    expect(() =>
      reconcilePromoAdjustmentTargets({
        targets: [
          { beneficiaryMemberId: "capped", amountCents: null },
          { beneficiaryMemberId: "known", amountCents: -300 },
        ],
        allocations: [
          { memberId: "capped", priceAdjustmentCents: -999 },
          { memberId: "known", priceAdjustmentCents: -300 },
        ],
        priceAdjustmentCents: -1299,
        context: "test",
      }),
    ).not.toThrow();
  });

  it("refuses a non-integer amount", () => {
    expect(() =>
      reconcilePromoAdjustmentTargets({ ...base, targets: [{ ...TARGETS[0], amountCents: -1500.5 }] }),
    ).toThrow(new RegExp(`${NIGHT_ADJUSTMENT_INVARIANT}.*integer`));
  });
});

describe("deriveNightAdjustmentState: validity is derived from the rows, never stored", () => {
  const redemption = { priceAdjustmentCents: -1500, allocations: REDEMPTION.allocations };
  const rows = TARGETS.map(({ beneficiaryMemberId, amountCents }) => ({ beneficiaryMemberId, amountCents }));

  it("a booking with no promotion had nothing taken off", () => {
    expect(deriveNightAdjustmentState({ rows: [], redemption: null })).toBe("NO_PROMOTION");
  });

  it("rows that reconcile to the recorded totals are KNOWN", () => {
    expect(deriveNightAdjustmentState({ rows, redemption })).toBe("KNOWN");
  });

  it("a parked removal that deleted a guest without re-running the promotion leaves the remaining rows under-summing: NOT_KNOWN", () => {
    // K1: the departed guest's rows cascaded away, the allocation still says
    // -1500, nobody re-ran the engine. No special case is needed to see it.
    const remaining = rows.filter((_, i) => i !== 2);
    expect(deriveNightAdjustmentState({ rows: remaining, redemption })).toBe("NOT_KNOWN");
  });

  it("a promotion with no rows at all (written by the old colour, or never recorded) is NOT_KNOWN", () => {
    expect(deriveNightAdjustmentState({ rows: [], redemption })).toBe("NOT_KNOWN");
  });

  it("a NOT KNOWN amount anywhere makes the booking NOT_KNOWN rather than summing null as zero", () => {
    expect(
      deriveNightAdjustmentState({ rows: [{ beneficiaryMemberId: "booker", amountCents: null }], redemption }),
    ).toBe("NOT_KNOWN");
  });

  it("rows that sum per beneficiary but not to the redemption total are NOT_KNOWN", () => {
    expect(
      deriveNightAdjustmentState({ rows, redemption: { ...redemption, priceAdjustmentCents: -1600 } }),
    ).toBe("NOT_KNOWN");
  });
});

describe("recordBookingNightAdjustments", () => {
  it("writes one row per target against the resolved night (or guest), reading everything before it writes anything", async () => {
    const { tx, recorded } = fakeTx({ redemption: REDEMPTION, nights: NIGHTS });
    await recordBookingNightAdjustments(tx, {
      bookingId: "booking-1",
      guestIds: ["guest-a", "guest-b"],
      targets: TARGETS,
      writer: "test writer",
    });
    expect(recorded.adjustmentDeleteMany).toHaveBeenCalledWith({ where: { bookingId: "booking-1" } });
    expect(recorded.adjustmentCreateMany).toHaveBeenCalledTimes(1);
    expect(recorded.adjustmentCreateMany.mock.calls[0][0]).toEqual({
      data: [ROW("night-a1", null, -500), ROW("night-a2", null, -400), ROW(null, "guest-b", -600)],
    });
    // Refuse-before-mutate: every read precedes the first write.
    expect(recorded.order).toEqual([
      "redemption.findUnique",
      "night.findMany",
      "adjustment.deleteMany",
      "adjustment.createMany",
    ]);
  });

  it("with no promotion on the booking, clears the booking's rows and writes none (nothing was taken off)", async () => {
    const { tx, recorded } = fakeTx({ redemption: null, nights: NIGHTS });
    await recordBookingNightAdjustments(tx, {
      bookingId: "booking-1",
      guestIds: ["guest-a"],
      targets: [],
      writer: "test writer",
    });
    expect(recorded.adjustmentDeleteMany).toHaveBeenCalledTimes(1);
    expect(recorded.adjustmentCreateMany).not.toHaveBeenCalled();
  });

  it("refuses, leaving no partial write, when the rows do not reconcile to the stored allocation", async () => {
    const { tx, recorded } = fakeTx({
      redemption: { ...REDEMPTION, allocations: [{ memberId: "booker", priceAdjustmentCents: -1000 }] },
      nights: NIGHTS,
    });
    await expect(
      recordBookingNightAdjustments(tx, {
        bookingId: "booking-1",
        guestIds: ["guest-a", "guest-b"],
        targets: TARGETS,
        writer: "test writer",
      }),
    ).rejects.toThrow(new RegExp(NIGHT_ADJUSTMENT_INVARIANT));
    nothingWritten(recorded);
  });

  it("refuses targets that name a promotion the booking does not carry, writing nothing", async () => {
    const { tx, recorded } = fakeTx({ redemption: null, nights: NIGHTS });
    await expect(
      recordBookingNightAdjustments(tx, {
        bookingId: "booking-1",
        guestIds: ["guest-a", "guest-b"],
        targets: TARGETS,
        writer: "test writer",
      }),
    ).rejects.toThrow(/no stored redemption/);
    nothingWritten(recorded);
  });

  it("refuses a date missing from a guest that DOES hold night rows, writing nothing", async () => {
    const { tx, recorded } = fakeTx({ redemption: REDEMPTION, nights: [NIGHTS[0], NIGHTS[2]] });
    await expect(
      recordBookingNightAdjustments(tx, {
        bookingId: "booking-1",
        guestIds: ["guest-a", "guest-b"],
        targets: TARGETS,
        writer: "test writer",
      }),
    ).rejects.toThrow(/holds no such night row/);
    nothingWritten(recorded);
  });

  it("drops the night rows of a guest that holds NO night rows (a pre-#713 strand), warns, and records the rest", async () => {
    // guest-a has no night rows at all; guest-b's guest-scope row is unaffected.
    const { tx, recorded } = fakeTx({ redemption: REDEMPTION, nights: [NIGHTS[2]] });
    loggerMocks.warn.mockClear();
    await recordBookingNightAdjustments(tx, {
      bookingId: "booking-1",
      guestIds: ["guest-a", "guest-b"],
      targets: TARGETS,
      writer: "test writer",
    });
    expect(recorded.adjustmentCreateMany.mock.calls[0][0]).toEqual({ data: [ROW(null, "guest-b", -600)] });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", guestIds: ["guest-a"] }),
      expect.stringContaining(NIGHT_ADJUSTMENT_INVARIANT),
    );
    // And what got written derives, honestly, as not known.
    expect(
      deriveNightAdjustmentState({
        rows: [{ beneficiaryMemberId: "booker", amountCents: -600 }],
        redemption: { priceAdjustmentCents: -1500, allocations: REDEMPTION.allocations },
      }),
    ).toBe("NOT_KNOWN");
  });

  it("refuses an undated night-scope target and a dated guest-scope target before any read", async () => {
    for (const target of [
      { ...TARGETS[0], stayDate: null },
      { ...TARGETS[2], stayDate: N1 },
    ]) {
      const { tx, recorded } = fakeTx({ redemption: REDEMPTION, nights: NIGHTS });
      await expect(
        recordBookingNightAdjustments(tx, {
          bookingId: "booking-1",
          guestIds: ["guest-a", "guest-b"],
          targets: [target],
          writer: "test writer",
        }),
      ).rejects.toThrow(new RegExp(NIGHT_ADJUSTMENT_INVARIANT));
      nothingWritten(recorded);
      expect(recorded.redemptionFindUnique).not.toHaveBeenCalled();
    }
  });

  it("refuses when a priced guest has no booking guest id", async () => {
    const { tx, recorded } = fakeTx({ redemption: REDEMPTION, nights: NIGHTS });
    await expect(
      recordBookingNightAdjustments(tx, {
        bookingId: "booking-1",
        guestIds: ["guest-a", null],
        targets: [],
        writer: "test writer",
      }),
    ).rejects.toThrow(/no booking guest id/);
    nothingWritten(recorded);
  });
});

describe("snapshot and restore across a mechanical rewrite", () => {
  const NIGHT_ROW = {
    kind: "PROMO",
    amountCents: -500,
    promoRedemptionId: "redemption-1",
    promoCodeId: "promo-1",
    beneficiaryMemberId: "booker",
  };
  const GUEST_ROWS = [
    {
      kind: "PROMO",
      amountCents: -600,
      promoRedemptionId: "redemption-1",
      promoCodeId: "promo-1",
      beneficiaryMemberId: "booker",
      bookingGuestId: "guest-b",
    },
  ];

  it("re-attaches rows by (guest, date + shift) byte for byte, reading before it writes", async () => {
    const before = fakeTx({
      adjustments: GUEST_ROWS,
      nights: [{ id: "old-a1", bookingGuestId: "guest-a", stayDate: N1, adjustments: [NIGHT_ROW] }],
    });
    const snapshot = await snapshotBookingNightAdjustments(before.tx, "booking-1");
    expect(snapshot.rows).toHaveLength(2);

    const after = fakeTx({
      nights: [
        { id: "new-a2", bookingGuestId: "guest-a", stayDate: N2 },
        { id: "new-b2", bookingGuestId: "guest-b", stayDate: N2 },
      ],
      guests: [{ id: "guest-a" }, { id: "guest-b" }],
    });
    await expect(
      restoreBookingNightAdjustments(after.tx, { snapshot, shiftDays: 1, writer: "test shift" }),
    ).resolves.toEqual({ carried: true });
    expect(after.recorded.adjustmentCreateMany.mock.calls[0][0]).toEqual({
      data: [ROW("new-a2", null, -500), ROW(null, "guest-b", -600)],
    });
    expect(after.recorded.order).toEqual([
      "night.findMany",
      "guest.findMany",
      "adjustment.deleteMany",
      "adjustment.createMany",
    ]);
  });

  it("abandons the carry, writing nothing, when a recorded night no longer exists", async () => {
    const before = fakeTx({
      adjustments: GUEST_ROWS,
      nights: [{ id: "old-a1", bookingGuestId: "guest-a", stayDate: N1, adjustments: [NIGHT_ROW] }],
    });
    const snapshot = await snapshotBookingNightAdjustments(before.tx, "booking-1");
    const after = fakeTx({
      nights: [{ id: "new-b1", bookingGuestId: "guest-b", stayDate: N1 }],
      guests: [{ id: "guest-a" }, { id: "guest-b" }],
    });
    await expect(
      restoreBookingNightAdjustments(after.tx, { snapshot, writer: "test edit" }),
    ).resolves.toEqual({ carried: false });
    nothingWritten(after.recorded);
  });

  it("is a no-op for a booking that recorded nothing", async () => {
    const before = fakeTx({ adjustments: [], nights: [] });
    const snapshot = await snapshotBookingNightAdjustments(before.tx, "booking-1");
    const after = fakeTx({});
    await expect(
      restoreBookingNightAdjustments(after.tx, { snapshot, writer: "test edit" }),
    ).resolves.toEqual({ carried: true });
    expect(after.recorded.nightFindMany).not.toHaveBeenCalled();
    nothingWritten(after.recorded);
  });
});
