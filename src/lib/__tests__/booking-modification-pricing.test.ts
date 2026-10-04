/**
 * #3828: an edit on a several-code booking stores one PROMO_DELTA per code that
 * moved. `computeModificationPricing` attaches each side's per-code figures —
 * the snapshot before, a re-read of the edit's own re-price after — only when a
 * side carries more than one code, so a one-code edit's sides and lines are
 * exactly what its site composed.
 */
import { describe, expect, it, vi } from "vitest";

import { computeModificationPricing } from "@/lib/booking-modification-pricing";
import type { ModificationPricingSide } from "@/lib/booking-modification-lines";

const log = { info: vi.fn(), error: vi.fn() };

function side(promoAdjustmentCents: number, promoCode: string | null): ModificationPricingSide {
  return {
    guests: [
      {
        guestKey: "g1",
        ageTier: "ADULT",
        isMember: true,
        rateMembershipTypeId: "rate-1",
        name: "Jo",
        nights: [{ stayDate: new Date("2026-08-14T00:00:00.000Z"), priceCents: 8000, priceSource: "SOLD" }],
      },
    ],
    promoAdjustmentCents,
    promoCode,
  };
}

function storeReturning(rows: unknown) {
  return { promoRedemption: { findMany: vi.fn().mockResolvedValue(rows) } };
}

const twoCodes = {
  promoRedemptions: [
    { id: "r2", applicationOrder: 1, priceAdjustmentCents: -2000, promoCode: { code: "GUESTFREE" } },
    { id: "r1", applicationOrder: 0, priceAdjustmentCents: -3000, promoCode: { code: "SUMMER25" } },
  ],
};

describe("computeModificationPricing per-code promotion sides (#3828)", () => {
  it("stores one PROMO_DELTA per code that moved, reading the after side in the edit's transaction", async () => {
    const store = storeReturning([
      { id: "r1", applicationOrder: 0, priceAdjustmentCents: -3000, promoCode: { code: "SUMMER25" } },
      { id: "r2", applicationOrder: 1, priceAdjustmentCents: -1000, promoCode: { code: "GUESTFREE" } },
    ]);

    const { priceLines, sides } = await computeModificationPricing(
      { bookingId: "bk1", site: "test", promoCodes: { store: store as never, before: twoCodes } },
      () => ({ before: side(-5000, "SUMMER25, GUESTFREE"), after: side(-4000, "SUMMER25, GUESTFREE") }),
      1000,
      log,
    );

    expect(store.promoRedemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookingId: "bk1" } }),
    );
    expect(priceLines).toEqual([
      { v: 1, kind: "PROMO_DELTA", sign: 1, promoCode: "GUESTFREE", amountCents: 1000 },
    ]);
    expect(sides?.before.promoByCode).toEqual([
      { code: "SUMMER25", amountCents: -3000 },
      { code: "GUESTFREE", amountCents: -2000 },
    ]);
  });

  it("leaves a one-code edit's sides exactly as its site composed them", async () => {
    const store = storeReturning([
      { id: "r1", applicationOrder: 0, priceAdjustmentCents: -4000, promoCode: { code: "SUMMER25" } },
    ]);
    const before = side(-5000, "SUMMER25");
    const after = side(-4000, "SUMMER25");

    const { priceLines, sides } = await computeModificationPricing(
      {
        bookingId: "bk1",
        site: "test",
        promoCodes: {
          store: store as never,
          before: { promoRedemptions: [{ id: "r1", priceAdjustmentCents: -5000, promoCode: { code: "SUMMER25" } }] },
        },
      },
      () => ({ before, after }),
      1000,
      log,
    );

    expect(sides).toEqual({ before, after });
    expect(sides?.before).not.toHaveProperty("promoByCode");
    expect(priceLines).toEqual([
      { v: 1, kind: "PROMO_DELTA", sign: 1, promoCode: "SUMMER25", amountCents: 1000 },
    ]);
  });

  it("does not pretend to recover from a failed after-side read: the narration guard stores no lines", async () => {
    // On Postgres a failed statement aborts the interactive transaction, so a
    // catch that went on to write the aggregate line would only hide the abort.
    const store = { promoRedemption: { findMany: vi.fn().mockRejectedValue(new Error("gone")) } };
    const errorLog = { info: vi.fn(), error: vi.fn() };

    const { priceLines, sides } = await computeModificationPricing(
      { bookingId: "bk1", site: "test", promoCodes: { store: store as never, before: twoCodes } },
      () => ({ before: side(-5000, "SUMMER25, GUESTFREE"), after: side(-4000, "SUMMER25, GUESTFREE") }),
      1000,
      errorLog,
    );

    expect(priceLines).toBeNull();
    expect(sides).toBeNull();
    expect(errorLog.error).toHaveBeenCalledTimes(1);
  });
});
