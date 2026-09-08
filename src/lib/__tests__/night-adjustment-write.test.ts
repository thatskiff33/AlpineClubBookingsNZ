import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { parseDateOnly } from "@/lib/date-only";
import {
  NIGHT_ADJUSTMENT_INVARIANT,
  reconcilePromoAdjustmentTargets,
  recordBookingNightAdjustments,
  restoreBookingNightAdjustments,
  snapshotBookingNightAdjustments,
  type PromoAdjustmentTarget,
} from "@/lib/night-adjustment-write";

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * #3276: the one writer of the night adjustment build-up, exercised against a
 * recording transaction double. The reconciliation guard (INV-MONEY-029) is
 * proved in both directions — it passes rows that sum to the recorded totals
 * and refuses, BEFORE any row is written and before any night is marked
 * RECORDED, when they do not.
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
  nightUpdateMany: ReturnType<typeof vi.fn>;
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
    adjustmentsState?: string;
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
    nightFindMany: track("night.findMany", (options.nights ?? []).map((night) => ({ adjustments: [], ...night }))),
    nightUpdateMany: track("night.updateMany", { count: 0 }),
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
    bookingGuestNight: { findMany: recorded.nightFindMany, updateMany: recorded.nightUpdateMany },
    bookingGuest: { findMany: recorded.guestFindMany },
  } as unknown as Prisma.TransactionClient;
  return { tx, recorded };
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
          { guestIndex: 0, scope: "night", stayDate: N1, beneficiaryMemberId: "even", amountCents: 500 },
          { guestIndex: 0, scope: "night", stayDate: N2, beneficiaryMemberId: "even", amountCents: -500 },
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
          { guestIndex: 0, scope: "night", stayDate: N1, beneficiaryMemberId: "capped", amountCents: null },
          { guestIndex: 1, scope: "night", stayDate: N1, beneficiaryMemberId: "known", amountCents: -300 },
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
      reconcilePromoAdjustmentTargets({
        ...base,
        targets: [{ ...TARGETS[0], amountCents: -1500.5 }],
      }),
    ).toThrow(new RegExp(`${NIGHT_ADJUSTMENT_INVARIANT}.*integer`));
  });
});

describe("recordBookingNightAdjustments", () => {
  it("writes one row per target against the resolved night (or guest), then marks the nights RECORDED", async () => {
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
      data: [
        {
          kind: "PROMO",
          amountCents: -500,
          bookingGuestNightId: "night-a1",
          bookingGuestId: null,
          bookingId: "booking-1",
          promoRedemptionId: "redemption-1",
          promoCodeId: "promo-1",
          beneficiaryMemberId: "booker",
        },
        {
          kind: "PROMO",
          amountCents: -400,
          bookingGuestNightId: "night-a2",
          bookingGuestId: null,
          bookingId: "booking-1",
          promoRedemptionId: "redemption-1",
          promoCodeId: "promo-1",
          beneficiaryMemberId: "booker",
        },
        {
          kind: "PROMO",
          amountCents: -600,
          bookingGuestNightId: null,
          bookingGuestId: "guest-b",
          bookingId: "booking-1",
          promoRedemptionId: "redemption-1",
          promoCodeId: "promo-1",
          beneficiaryMemberId: "booker",
        },
      ],
    });
    expect(recorded.nightUpdateMany).toHaveBeenCalledWith({
      where: { bookingGuestId: { in: ["guest-a", "guest-b"] } },
      data: { adjustmentsState: "RECORDED" },
    });
    // RECORDED only after the rows are in place.
    expect(recorded.order.indexOf("adjustment.createMany")).toBeLessThan(
      recorded.order.indexOf("night.updateMany"),
    );
  });

  it("with no promotion on the booking, writes no rows and still marks the nights RECORDED (nothing taken off)", async () => {
    const { tx, recorded } = fakeTx({ redemption: null, nights: NIGHTS });
    await recordBookingNightAdjustments(tx, {
      bookingId: "booking-1",
      guestIds: ["guest-a"],
      targets: [],
      writer: "test writer",
    });
    expect(recorded.adjustmentCreateMany).not.toHaveBeenCalled();
    expect(recorded.nightUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses, before any row or state write, when the rows do not reconcile to the stored allocation", async () => {
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
    expect(recorded.adjustmentCreateMany).not.toHaveBeenCalled();
    expect(recorded.nightUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses targets that name a promotion the booking does not carry", async () => {
    const { tx, recorded } = fakeTx({ redemption: null, nights: NIGHTS });
    await expect(
      recordBookingNightAdjustments(tx, {
        bookingId: "booking-1",
        guestIds: ["guest-a", "guest-b"],
        targets: TARGETS,
        writer: "test writer",
      }),
    ).rejects.toThrow(/no stored redemption/);
    expect(recorded.nightUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a night-scope target the guest holds no night row for", async () => {
    const { tx, recorded } = fakeTx({ redemption: REDEMPTION, nights: NIGHTS.slice(0, 1) });
    await expect(
      recordBookingNightAdjustments(tx, {
        bookingId: "booking-1",
        guestIds: ["guest-a", "guest-b"],
        targets: TARGETS,
        writer: "test writer",
      }),
    ).rejects.toThrow(/holds no such night row/);
    expect(recorded.adjustmentCreateMany).not.toHaveBeenCalled();
    expect(recorded.nightUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an undated night-scope target and a dated guest-scope target", async () => {
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
      expect(recorded.adjustmentDeleteMany).not.toHaveBeenCalled();
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
    expect(recorded.adjustmentDeleteMany).not.toHaveBeenCalled();
  });
});

describe("snapshot and restore across a mechanical rewrite", () => {
  // A night-scope row rides on its night; a guest-scope row is read on its own.
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

  it("re-attaches rows by (guest, date + shift) byte for byte and restores RECORDED on the moved nights", async () => {
    const before = fakeTx({
      adjustments: GUEST_ROWS,
      nights: [
        { id: "old-a1", bookingGuestId: "guest-a", stayDate: N1, adjustmentsState: "RECORDED", adjustments: [NIGHT_ROW] },
        { id: "old-b1", bookingGuestId: "guest-b", stayDate: N1, adjustmentsState: "RECORDED", adjustments: [] },
      ],
    });
    const snapshot = await snapshotBookingNightAdjustments(before.tx, "booking-1");
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.recordedNights).toHaveLength(2);

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
      data: [
        {
          kind: "PROMO",
          amountCents: -500,
          bookingGuestNightId: "new-a2",
          bookingGuestId: null,
          bookingId: "booking-1",
          promoRedemptionId: "redemption-1",
          promoCodeId: "promo-1",
          beneficiaryMemberId: "booker",
        },
        {
          kind: "PROMO",
          amountCents: -600,
          bookingGuestNightId: null,
          bookingGuestId: "guest-b",
          bookingId: "booking-1",
          promoRedemptionId: "redemption-1",
          promoCodeId: "promo-1",
          beneficiaryMemberId: "booker",
        },
      ],
    });
    expect(after.recorded.nightUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["new-a2", "new-b2"] } },
      data: { adjustmentsState: "RECORDED" },
    });
  });

  it("abandons the carry, writing nothing and marking nothing, when a recorded night no longer exists", async () => {
    const before = fakeTx({
      adjustments: GUEST_ROWS,
      nights: [{ id: "old-a1", bookingGuestId: "guest-a", stayDate: N1, adjustmentsState: "RECORDED", adjustments: [NIGHT_ROW] }],
    });
    const snapshot = await snapshotBookingNightAdjustments(before.tx, "booking-1");
    const after = fakeTx({
      nights: [{ id: "new-b1", bookingGuestId: "guest-b", stayDate: N1 }],
      guests: [{ id: "guest-a" }, { id: "guest-b" }],
    });
    await expect(
      restoreBookingNightAdjustments(after.tx, { snapshot, writer: "test edit" }),
    ).resolves.toEqual({ carried: false });
    expect(after.recorded.adjustmentCreateMany).not.toHaveBeenCalled();
    expect(after.recorded.nightUpdateMany).not.toHaveBeenCalled();
  });

  it("is a no-op for a booking that recorded nothing", async () => {
    const before = fakeTx({ adjustments: [], nights: [] });
    const snapshot = await snapshotBookingNightAdjustments(before.tx, "booking-1");
    const after = fakeTx({});
    await expect(
      restoreBookingNightAdjustments(after.tx, { snapshot, writer: "test edit" }),
    ).resolves.toEqual({ carried: true });
    expect(after.recorded.nightFindMany).not.toHaveBeenCalled();
    expect(after.recorded.adjustmentDeleteMany).not.toHaveBeenCalled();
  });
});
