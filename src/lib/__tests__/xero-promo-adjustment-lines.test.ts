/**
 * #3828 (`INV-MONEY-030`): the promotion lines of a booking invoice — one per
 * code, or the one aggregate line when a split cannot be trusted. The invoice
 * and group suites pin the wired paths; these pin the planner's edges.
 */
import { describe, expect, it } from "vitest";

import {
  planPromoAdjustmentLines,
  promoAdjustmentLineItems,
  promoAdjustmentLineRecord,
} from "@/lib/xero-promo-adjustment-lines";

const coding = {
  firstGuest: null,
  itemCodeResolver: null,
  seasonType: null,
  hutFeeMapping: { code: "200", itemCode: "HUT", codeExplicitlyConfigured: false },
};

function redemption(id: string | null, order: number, cents: number, code: string) {
  return {
    id,
    applicationOrder: order,
    priceAdjustmentCents: cents,
    allocations: cents === 0 ? [] : [{ memberId: "m1", priceAdjustmentCents: cents }],
    promoCode: { code, xeroItemCode: null, xeroAccountCode: null },
  };
}

describe("planPromoAdjustmentLines (#3828)", () => {
  it("a one-code booking is today's single line, and records nothing", () => {
    const plan = planPromoAdjustmentLines({
      aggregateCents: -500,
      // Its rows are not consulted at all: one code is never split.
      redemptions: [redemption(null, 0, -500, "SAVE5")],
      adjustmentRows: [],
    });
    expect(plan).toEqual({
      kind: "ONE_CODE",
      promo: { code: "SAVE5", xeroItemCode: null, xeroAccountCode: null },
      amountCents: -500,
    });
    expect(promoAdjustmentLineRecord(plan)).toBeNull();
    expect(promoAdjustmentLineItems(plan, coding)).toEqual([
      { description: "Promo adjustment - SAVE5", quantity: 1, unitAmount: -5, taxType: "OUTPUT2", itemCode: "HUT" },
    ]);
  });

  it("a code that took nothing off is no line, but is still recorded", () => {
    const plan = planPromoAdjustmentLines({
      aggregateCents: -500,
      redemptions: [redemption("a", 0, -500, "SAVE5"), redemption("b", 1, 0, "COVERED")],
      adjustmentRows: [{ promoRedemptionId: "a", beneficiaryMemberId: "m1", amountCents: -500 }],
    });
    expect(plan.kind).toBe("PER_CODE");
    expect(promoAdjustmentLineItems(plan, coding).map((line) => line.description)).toEqual([
      "Promo adjustment - SAVE5",
    ]);
    expect(promoAdjustmentLineRecord(plan)?.promoLineCodes).toEqual([
      { code: "SAVE5", amountCents: -500 },
      { code: "COVERED", amountCents: 0 },
    ]);
  });

  it("a code whose rows cannot be matched to it (no id) is not known, so the invoice falls back", () => {
    const plan = planPromoAdjustmentLines({
      aggregateCents: -800,
      redemptions: [redemption("a", 0, -500, "SAVE5"), redemption(null, 1, -300, "MYSTERY")],
      adjustmentRows: [
        { promoRedemptionId: "a", beneficiaryMemberId: "m1", amountCents: -500 },
        { promoRedemptionId: null, beneficiaryMemberId: "m1", amountCents: -300 },
      ],
    });
    expect(plan).toMatchObject({ kind: "AGGREGATE_FALLBACK", reason: "CODE_BUILDUP_NOT_KNOWN" });
    expect(promoAdjustmentLineItems(plan, coding)).toEqual([
      { description: "Promo adjustment - SAVE5, MYSTERY", quantity: 1, unitAmount: -8, taxType: "OUTPUT2", itemCode: "HUT" },
    ]);
  });

  it("a code whose rows do not reconcile to its own redemption is not known", () => {
    const plan = planPromoAdjustmentLines({
      aggregateCents: -800,
      redemptions: [redemption("a", 0, -500, "SAVE5"), redemption("b", 1, -300, "GUESTFREE")],
      adjustmentRows: [
        { promoRedemptionId: "a", beneficiaryMemberId: "m1", amountCents: -600 },
        { promoRedemptionId: "b", beneficiaryMemberId: "m1", amountCents: -200 },
      ],
    });
    // The two rows still add to the aggregate; each code's own does not.
    expect(plan).toMatchObject({ kind: "AGGREGATE_FALLBACK", reason: "CODE_BUILDUP_NOT_KNOWN" });
  });
});
