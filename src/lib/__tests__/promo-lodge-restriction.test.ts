import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import {
  PROMO_LODGE_RESTRICTION_MESSAGE,
  redeemPromoCode,
} from "../promo";

// The promo module imports the Prisma client at load time. These tests never
// touch it (redeemPromoCode is driven entirely through the injected `tx`), but
// the mock keeps the import graph free of a real database connection.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    promoRedemptionAllocation: {
      aggregate: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

// assertPromoRedeemableAtLodge is not exported; it is exercised through its
// only caller, redeemPromoCode, which runs the guard first and only then
// begins writing redemption rows. A stub transaction lets us assert both the
// guard's decision (throw vs proceed) and — via whether the create ran — that
// the guard gates the write path (docs/multi-lodge/test-plan.md: "Promo lodge
// restriction guard"). This is the money-path guard the production-readiness
// review flagged as having zero coverage.

/**
 * Build a stub Prisma transaction whose promoCodeLodge.findMany returns the
 * given per-lodge restriction rows. Records whether redemption rows were
 * written so a test can prove the guard short-circuits before any writes.
 */
function makeTx(restrictionLodgeIds: string[]) {
  const state = { createdRedemption: false };
  const tx = {
    promoCodeLodge: {
      findMany: vi.fn().mockResolvedValue(
        restrictionLodgeIds.map((lodgeId) => ({ lodgeId }))
      ),
    },
    promoRedemption: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => {
        state.createdRedemption = true;
        return { id: "redemption-1" };
      }),
    },
    promoRedemptionAllocation: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    promoRedemptionGuestTarget: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    promoCode: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return { tx, state };
}

function redeemAt(
  tx: ReturnType<typeof makeTx>["tx"],
  lodgeId: string | null | undefined
) {
  // Minimal single-beneficiary allocation so the write path (when reached) is
  // representative; the guard runs before any of it.
  return redeemPromoCode(
    tx as any,
    "promo-1",
    "booking-1",
    "member-1",
    1000,
    0,
    0,
    1,
    [
      {
        memberId: "member-1",
        discountCents: 1000,
        priceAdjustmentCents: 0,
        freeNightsUsed: 0,
      },
    ],
    undefined,
    lodgeId
  );
}

describe("assertPromoRedeemableAtLodge (via redeemPromoCode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redeems anywhere when the promo has no lodge restriction rows", async () => {
    const { tx, state } = makeTx([]);

    await expect(redeemAt(tx, "lodge-a")).resolves.toBeUndefined();
    expect(state.createdRedemption).toBe(true);
    expect(tx.promoCode.update).toHaveBeenCalled();
  });

  it("redeems anywhere with no lodge context when unrestricted", async () => {
    const { tx, state } = makeTx([]);

    await expect(redeemAt(tx, null)).resolves.toBeUndefined();
    await expect(redeemAt(tx, undefined)).resolves.toBeUndefined();
    expect(state.createdRedemption).toBe(true);
  });

  it("redeems at a listed lodge when the promo is restricted", async () => {
    const { tx, state } = makeTx(["lodge-a", "lodge-b"]);

    await expect(redeemAt(tx, "lodge-b")).resolves.toBeUndefined();
    expect(state.createdRedemption).toBe(true);
  });

  it("rejects redemption at a non-listed lodge", async () => {
    const { tx, state } = makeTx(["lodge-a", "lodge-b"]);

    await expect(redeemAt(tx, "lodge-c")).rejects.toBeInstanceOf(ApiError);
    // The guard must gate the money write: nothing is created on rejection.
    expect(state.createdRedemption).toBe(false);
    expect(tx.promoRedemption.create).not.toHaveBeenCalled();
    expect(tx.promoCode.update).not.toHaveBeenCalled();
  });

  it("throws a 400 ApiError with the lodge-restriction message", async () => {
    const { tx } = makeTx(["lodge-a"]);

    await expect(redeemAt(tx, "lodge-c")).rejects.toMatchObject({
      status: 400,
      message: PROMO_LODGE_RESTRICTION_MESSAGE,
    });
  });

  it("rejects redemption with a null lodge when the promo is restricted", async () => {
    const { tx, state } = makeTx(["lodge-a"]);

    // A restricted promo can never be redeemed without a resolved lodge — the
    // booking must belong to a listed lodge.
    await expect(redeemAt(tx, null)).rejects.toBeInstanceOf(ApiError);
    expect(state.createdRedemption).toBe(false);
  });

  it("rejects redemption with an undefined lodge when the promo is restricted", async () => {
    const { tx, state } = makeTx(["lodge-a"]);

    await expect(redeemAt(tx, undefined)).rejects.toBeInstanceOf(ApiError);
    expect(state.createdRedemption).toBe(false);
  });
});
