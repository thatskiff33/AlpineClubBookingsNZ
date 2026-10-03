/**
 * #3826 (epic #3813, C1): a booking may hold one PromoRedemption per promo
 * code. Pins the foundation's four promises:
 *
 *  1. Every reader sees a booking's redemptions through one helper, in the
 *     booker's order, and a single-code booking reads exactly as it did.
 *  2. While the `multiPromoCodes` rollout switch is off, the server refuses to
 *     persist a second redemption on any booking — the property the deployed
 *     old release depends on through a blue-green cut-over.
 *  3. Every release path gives back EVERY code's usage counter.
 *  4. The night-adjustment identity (INV-MONEY-029) holds per redemption for
 *     the writer and across them for the reader.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  MultiplePromoRedemptionsError,
  bookingPromoCodeLabel,
  bookingPromoRedemptions,
  soleBookingPromoRedemption,
} from "../booking-promo-redemptions";
import { bookingPromoEmailOptions } from "../booking-promo-email-options";
import { redeemPromoCode, releaseBookingPromoRedemptions } from "../promo";
import { SECOND_PROMO_CODE_REFUSED_MESSAGE } from "../promo-redemption-slot";
import {
  combinedPromoRedemptionEvidence,
  deriveNightAdjustmentState,
  recordBookingNightAdjustments,
} from "../night-adjustment-write";
import { MEMBER_MERGE_RELATION_SPECS } from "../member-merge-relations";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("booking promo redemption readers (#3826)", () => {
  it("orders by the booker's applicationOrder and keeps database order on ties", () => {
    const booking = {
      promoRedemptions: [
        { id: "b", applicationOrder: 1 },
        { id: "a", applicationOrder: 0 },
        { id: "c", applicationOrder: 1 },
      ],
    };
    expect(bookingPromoRedemptions(booking).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("reads a booking with no promotion, or no loaded relation, as an empty list", () => {
    expect(bookingPromoRedemptions({ promoRedemptions: [] })).toEqual([]);
    expect(bookingPromoRedemptions({})).toEqual([]);
    expect(bookingPromoRedemptions(null)).toEqual([]);
    expect(soleBookingPromoRedemption({ promoRedemptions: [] })).toBeNull();
    expect(bookingPromoCodeLabel({ promoRedemptions: [] })).toBeNull();
  });

  it("answers a single-code booking exactly as the one-to-one relation did", () => {
    const only = { id: "r1", promoCode: { code: "FREE3" } };
    const booking = { promoRedemptions: [only] };
    expect(soleBookingPromoRedemption(booking)).toBe(only);
    expect(bookingPromoCodeLabel(booking)).toBe("FREE3");
    expect(
      bookingPromoEmailOptions({
        lodgeId: "lodge-1",
        discountCents: 4500,
        promoAdjustmentCents: -4500,
        ...booking,
      }),
    ).toEqual({
      lodgeId: "lodge-1",
      discountCents: 4500,
      promoAdjustmentCents: -4500,
      promoCode: "FREE3",
    });
  });

  it("refuses a single-code reader a booking carrying several codes rather than answering with the first", () => {
    const booking = {
      promoRedemptions: [
        { id: "r1", applicationOrder: 0, promoCode: { code: "A" } },
        { id: "r2", applicationOrder: 1, promoCode: { code: "B" } },
      ],
    };
    expect(() => soleBookingPromoRedemption(booking)).toThrow(MultiplePromoRedemptionsError);
    expect(bookingPromoCodeLabel(booking)).toBe("A, B");
  });
});

// --- The rollout switch ------------------------------------------------------

function makeRedeemTx(options: {
  existingOrders: number[];
  multiPromoCodes: boolean | null;
}) {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    promoCodeLodge: { findMany: vi.fn(async () => []) },
    promoRedemption: {
      findFirst: vi.fn(async () =>
        options.existingOrders.length > 0
          ? { applicationOrder: Math.max(...options.existingOrders) }
          : null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `redemption-${created.length}`, ...data };
      }),
    },
    clubModuleSettings: {
      findUnique: vi.fn(async () =>
        options.multiPromoCodes === null ? null : { multiPromoCodes: options.multiPromoCodes },
      ),
    },
    promoRedemptionAllocation: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    promoRedemptionGuestTarget: { createMany: vi.fn(async () => ({ count: 0 })) },
    promoCode: { update: vi.fn(async () => ({})) },
  };
  return { tx, created };
}

type RedeemTx = Parameters<typeof redeemPromoCode>[0];

async function redeem(tx: ReturnType<typeof makeRedeemTx>["tx"], promoCodeId: string) {
  await redeemPromoCode(
    tx as unknown as RedeemTx,
    promoCodeId,
    "booking-1",
    "member-1",
    1000,
    -1000,
  );
}

describe("the multiPromoCodes rollout switch (#3826)", () => {
  it("a first code on a booking is written exactly as before, without reading the switch", async () => {
    const { tx, created } = makeRedeemTx({ existingOrders: [], multiPromoCodes: false });
    await redeem(tx, "code-a");
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty("applicationOrder");
    expect(tx.clubModuleSettings.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a second code while the switch is off, before anything is written", async () => {
    const { tx, created } = makeRedeemTx({ existingOrders: [0], multiPromoCodes: false });
    await expect(redeem(tx, "code-b")).rejects.toMatchObject({
      message: SECOND_PROMO_CODE_REFUSED_MESSAGE,
      status: 409,
    });
    expect(created).toEqual([]);
    expect(tx.promoCode.update).not.toHaveBeenCalled();
  });

  it("refuses a second code when the club never saved its Modules page (the default is off)", async () => {
    const { tx, created } = makeRedeemTx({ existingOrders: [0], multiPromoCodes: null });
    await expect(redeem(tx, "code-b")).rejects.toMatchObject({ status: 409 });
    expect(created).toEqual([]);
  });

  it("appends a second code after the last once the switch is on", async () => {
    const { tx, created } = makeRedeemTx({ existingOrders: [0, 1], multiPromoCodes: true });
    await redeem(tx, "code-c");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ promoCodeId: "code-c", applicationOrder: 2 });
  });
});

// --- Release ------------------------------------------------------------------

describe("releasing a booking that carries two codes (#3826)", () => {
  it("deletes both redemptions and gives back each code's own counter, in code-id order", async () => {
    const allocationCounts: Record<string, number> = { "r-z": 2, "r-a": 1 };
    const counters: Record<string, number> = { "code-a": 5, "code-z": 7 };
    const deleted: string[] = [];
    const counterOrder: string[] = [];
    const tx = {
      promoRedemption: {
        findMany: vi.fn(async () => [
          { id: "r-z", promoCodeId: "code-z" },
          { id: "r-a", promoCodeId: "code-a" },
        ]),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          deleted.push(where.id);
          return {};
        }),
      },
      promoRedemptionAllocation: {
        count: vi.fn(async ({ where }: { where: { promoRedemptionId: string } }) =>
          allocationCounts[where.promoRedemptionId] ?? 0,
        ),
      },
      promoCode: {
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: { currentRedemptions: { decrement: number } };
          }) => {
            counterOrder.push(where.id);
            counters[where.id]! -= data.currentRedemptions.decrement;
            return {};
          },
        ),
      },
    };

    const released = await releaseBookingPromoRedemptions(
      tx as unknown as RedeemTx,
      "booking-1",
    );

    expect(released).toBe(2);
    expect(tx.promoRedemption.findMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
      select: { id: true, promoCodeId: true },
    });
    expect(deleted.sort()).toEqual(["r-a", "r-z"]);
    expect(counters).toEqual({ "code-a": 4, "code-z": 5 });
    // One global order, so two releases of overlapping codes cannot deadlock.
    expect(counterOrder).toEqual(["code-a", "code-z"]);
  });
});

// --- INV-MONEY-029 across several redemptions --------------------------------

describe("night adjustments across several redemptions (#3826)", () => {
  const twoRedemptions = [
    {
      priceAdjustmentCents: -3000,
      allocations: [{ memberId: "m-b", priceAdjustmentCents: -3000 }],
    },
    {
      priceAdjustmentCents: -2000,
      allocations: [
        { memberId: "m-c", priceAdjustmentCents: -1500 },
        { memberId: "m-b", priceAdjustmentCents: -500 },
        // An organisation booker slot names no member and is not decomposed.
        { memberId: null, priceAdjustmentCents: 0 },
      ],
    },
  ];

  it("returns a single redemption's evidence unchanged and none for no redemption", () => {
    expect(combinedPromoRedemptionEvidence([])).toBeNull();
    expect(combinedPromoRedemptionEvidence([twoRedemptions[0]!])).toEqual({
      priceAdjustmentCents: -3000,
      allocations: [{ memberId: "m-b", priceAdjustmentCents: -3000 }],
    });
  });

  it("sums the redemptions and each member's allocations across codes", () => {
    expect(combinedPromoRedemptionEvidence(twoRedemptions)).toEqual({
      priceAdjustmentCents: -5000,
      allocations: [
        { memberId: "m-b", priceAdjustmentCents: -3500 },
        { memberId: "m-c", priceAdjustmentCents: -1500 },
      ],
    });
  });

  it("derives KNOWN when the rows reconcile to the combined totals, NOT_KNOWN when they do not", () => {
    const redemption = combinedPromoRedemptionEvidence(twoRedemptions);
    const rows = [
      { beneficiaryMemberId: "m-b", amountCents: -3500 },
      { beneficiaryMemberId: "m-c", amountCents: -1500 },
    ];
    expect(deriveNightAdjustmentState({ rows, redemption })).toBe("KNOWN");
    expect(
      deriveNightAdjustmentState({
        rows: [rows[0]!, { beneficiaryMemberId: "m-c", amountCents: -1000 }],
        redemption,
      }),
    ).toBe("NOT_KNOWN");
  });

  function writerTx(redemptions: Array<{
    id: string;
    promoCodeId: string;
    priceAdjustmentCents: number;
    allocations: Array<{ memberId: string | null; priceAdjustmentCents: number }>;
  }>) {
    const written: unknown[] = [];
    const tx = {
      promoRedemption: { findMany: vi.fn(async () => redemptions) },
      bookingGuestNight: {
        findMany: vi.fn(async () => [
          { id: "night-1", bookingGuestId: "guest-1", stayDate: new Date("2026-08-01T00:00:00.000Z") },
        ]),
      },
      bookingGuestNightAdjustment: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
          written.push(...data);
          return { count: data.length };
        }),
      },
    };
    return { tx, written };
  }

  const params = (targets: Parameters<typeof recordBookingNightAdjustments>[1]["targets"]) => ({
    bookingId: "booking-1",
    guestIds: ["guest-1"],
    targets,
    writer: "test",
    format: CLUB_FORMAT_TEST,
  });
  const nightTarget = (promoCodeId: string | undefined, beneficiaryMemberId: string, amountCents: number) => ({
    ...(promoCodeId ? { promoCodeId } : {}),
    guestIndex: 0,
    scope: "night" as const,
    stayDate: new Date("2026-08-01T00:00:00.000Z"),
    beneficiaryMemberId,
    amountCents,
  });
  const guestTarget = (promoCodeId: string, beneficiaryMemberId: string, amountCents: number) => ({
    promoCodeId,
    guestIndex: 0,
    scope: "guest" as const,
    stayDate: null,
    beneficiaryMemberId,
    amountCents,
  });
  const redemptionsAB = [
    { id: "r-a", promoCodeId: "code-a", priceAdjustmentCents: -1000, allocations: [{ memberId: "m-b", priceAdjustmentCents: -1000 }] },
    { id: "r-b", promoCodeId: "code-b", priceAdjustmentCents: -500, allocations: [{ memberId: "m-c", priceAdjustmentCents: -500 }] },
  ];

  it("attributes each target to its own code's redemption and checks the identity per redemption", async () => {
    const { tx, written } = writerTx(redemptionsAB);
    await recordBookingNightAdjustments(
      tx as never,
      params([nightTarget("code-a", "m-b", -1000), guestTarget("code-b", "m-c", -500)]),
    );
    expect(written).toEqual([
      expect.objectContaining({ promoRedemptionId: "r-a", promoCodeId: "code-a", bookingGuestNightId: "night-1" }),
      expect.objectContaining({ promoRedemptionId: "r-b", promoCodeId: "code-b", bookingGuestId: "guest-1" }),
    ]);
  });

  it("refuses rows that reconcile only in aggregate, before writing anything", async () => {
    // Both members' totals are right overall, but each amount is booked under
    // the other code — the per-redemption identity the writer owns.
    const { tx, written } = writerTx([
      { id: "r-a", promoCodeId: "code-a", priceAdjustmentCents: -1000, allocations: [{ memberId: "m-b", priceAdjustmentCents: -1000 }] },
      { id: "r-b", promoCodeId: "code-b", priceAdjustmentCents: -1000, allocations: [{ memberId: "m-b", priceAdjustmentCents: -1000 }] },
    ]);
    await expect(
      recordBookingNightAdjustments(
        tx as never,
        params([nightTarget("code-a", "m-b", -2000)]),
      ),
    ).rejects.toThrow(/INV-MONEY-029/);
    expect(written).toEqual([]);
    expect(tx.bookingGuestNightAdjustment.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a target that names no code on a booking carrying several", async () => {
    const { tx } = writerTx(redemptionsAB);
    await expect(
      recordBookingNightAdjustments(tx as never, params([nightTarget(undefined, "m-b", -1000)])),
    ).rejects.toThrow(/carries 2 promo codes/);
  });

  it("refuses a target naming a code the booking has not redeemed", async () => {
    const { tx } = writerTx(redemptionsAB);
    await expect(
      recordBookingNightAdjustments(tx as never, params([nightTarget("code-x", "m-b", -1000)])),
    ).rejects.toThrow(/has not redeemed/);
  });

  it("a target that names no code still belongs to a single-code booking's redemption", async () => {
    const { tx, written } = writerTx([redemptionsAB[0]!]);
    await recordBookingNightAdjustments(tx as never, params([nightTarget(undefined, "m-b", -1000)]));
    expect(written).toEqual([
      expect.objectContaining({ promoRedemptionId: "r-a", promoCodeId: "code-a" }),
    ]);
  });
});

describe("member merge (#3826)", () => {
  it("still moves a merged member's promo redemptions", () => {
    expect(
      MEMBER_MERGE_RELATION_SPECS.find((spec) => spec.key === "PromoRedemption.member"),
    ).toMatchObject({ column: "memberId", bucket: "move" });
  });
});
