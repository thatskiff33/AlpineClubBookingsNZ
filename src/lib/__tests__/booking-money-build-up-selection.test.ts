import { describe, expect, it, vi } from "vitest";

import {
  NIGHT_ADJUSTMENT_INVARIANT,
  readBookingMoneyBuildUp,
  selectBookingMoneyBuildUp,
  type BookingMoneyBuildUpRow,
} from "@/lib/booking-money-build-up";

const BOOKER = "member-booker";

function knownRows(amounts: readonly number[], guestIds?: readonly string[]) {
  const rows: BookingMoneyBuildUpRow[] = amounts.map((amountCents, index) => ({
    bookingGuestId: guestIds?.[index] ?? `guest-${index}`,
    beneficiaryMemberId: BOOKER,
    amountCents,
  }));
  return {
    rows,
    redemption: {
      priceAdjustmentCents: amounts.reduce((sum, cents) => sum + cents, 0),
      allocations: [
        {
          memberId: BOOKER,
          priceAdjustmentCents: amounts.reduce((sum, cents) => sum + cents, 0),
        },
      ],
    },
  };
}

describe("#3277 canonical D3 build-up selection", () => {
  const corpus = [
    { name: "percentage / all guests", base: 40_500, amounts: [-2_500, -3_000, -2_600] },
    { name: "percentage / assigned own nights", base: 40_500, amounts: [-900, -800] },
    { name: "fixed amount / selected guests", base: 40_500, amounts: [-10_000, -10_000] },
    { name: "free nights / per-member cap", base: 40_500, amounts: [-4_500, -3_000] },
    { name: "fixed nightly CAP_ONLY", base: 40_500, amounts: [-500, -500, -3_000] },
    { name: "fixed nightly SET_PRICE positive adjustment", base: 40_500, amounts: [1_000, 1_000, 1_500] },
    { name: "partial work-party window", base: 37_500, amounts: [-7_000, -5_500, -10_500] },
    { name: "redistributed cap still reconciles", base: 30_000, amounts: [-4_000, -6_000] },
  ] as const;

  it.each(corpus)("selects STORED only when $name is byte-identical", ({ base, amounts }) => {
    const recorded = knownRows(amounts);
    const derivedCents = base + amounts.reduce((sum, cents) => sum + cents, 0);
    const result = selectBookingMoneyBuildUp({
      operation: "CREDIT_ELECTION",
      baseEvidence: { kind: "EXACT", amountCents: base },
      ...recorded,
      derivedCents,
    });

    expect(result).toMatchObject({
      source: "STORED",
      storedCents: derivedCents,
      selectedCents: derivedCents,
      historyMetadata: {
        moneyBuildUpSource: "STORED",
        moneyBuildUpFallbackClassification: null,
      },
    });
  });

  it("preserves today's amount for a classified redistribution mismatch", () => {
    const recorded = knownRows([-4_000, -6_000]);
    const result = selectBookingMoneyBuildUp({
      operation: "GUEST_REMOVAL",
      baseEvidence: { kind: "EXACT", amountCents: 12_000 },
      ...recorded,
      bookingGuestId: "guest-0",
      derivedCents: -7_500,
      mismatchClassification: "LEGITIMATE_DIVERGENCE",
    });

    expect(result).toMatchObject({
      source: "DERIVED_COMPATIBILITY_FALLBACK",
      reason: "STORED_DERIVED_MISMATCH",
      storedCents: -8_000,
      derivedCents: -7_500,
      selectedCents: -7_500,
      fallbackClassification: "LEGITIMATE_DIVERGENCE",
    });
  });

  it.each([
    "STORED_SIDE_DEFECT",
    "DERIVATION_DEFECT",
    "LEGITIMATE_DIVERGENCE",
  ] as const)("keeps D3's derived amount for every %s disagreement", (classification) => {
    const result = selectBookingMoneyBuildUp({
      operation: "CREDIT_ELECTION",
      baseEvidence: { kind: "EXACT", amountCents: 20_000 },
      ...knownRows([-2_000]),
      derivedCents: 17_999,
      mismatchClassification: classification,
    });
    expect(result).toMatchObject({
      source: "DERIVED_COMPATIBILITY_FALLBACK",
      storedCents: 18_000,
      derivedCents: 17_999,
      selectedCents: 17_999,
      fallbackClassification: classification,
    });
  });

  it("classifies an expired old-colour promotion with no recorded rows as a stored-side fallback", () => {
    const result = selectBookingMoneyBuildUp({
      operation: "XERO_PROMO_LINE",
      baseEvidence: { kind: "EXACT", amountCents: 20_000 },
      rows: [],
      redemption: {
        priceAdjustmentCents: -2_000,
        allocations: [{ memberId: BOOKER, priceAdjustmentCents: -2_000 }],
      },
      derivedCents: -2_000,
    });

    expect(result).toMatchObject({
      source: "DERIVED_COMPATIBILITY_FALLBACK",
      reason: "ADJUSTMENT_BUILDUP_NOT_KNOWN",
      storedCents: null,
      selectedCents: -2_000,
      fallbackClassification: "STORED_SIDE_DEFECT",
    });
  });

  it("makes unknown or inexact base evidence non-actionable at individual-night grain", () => {
    for (const reason of [
      "NO_STORED_NIGHT_PRICES",
      "PARTIAL_STORED_NIGHT_PRICES",
      "INEXACT_STORED_NIGHT_PRICES",
      "STORED_TOTAL_MISMATCH",
    ] as const) {
      const result = selectBookingMoneyBuildUp({
        operation: "GUEST_REMOVAL",
        baseEvidence: { kind: "UNKNOWN", reason },
        ...knownRows([-500]),
        bookingGuestId: "guest-0",
        derivedCents: -9_500,
      });
      expect(result).toMatchObject({
        source: "BASE_EVIDENCE_UNKNOWN",
        reason,
        storedCents: null,
      });
      expect("selectedCents" in result).toBe(false);
    }
  });

  it("keeps a whole-guest EVEN_SPLIT total usable when the caller proves that grain exact", () => {
    const result = selectBookingMoneyBuildUp({
      operation: "GUEST_REMOVAL",
      baseEvidence: { kind: "EXACT", amountCents: 10_001 },
      ...knownRows([-1_001], ["departing"]),
      bookingGuestId: "departing",
      derivedCents: -9_000,
    });
    expect(result).toMatchObject({ source: "STORED", selectedCents: -9_000 });
  });

  it("refuses a known mismatch without an explicit classification", () => {
    expect(() =>
      selectBookingMoneyBuildUp({
        operation: "CREDIT_ELECTION",
        baseEvidence: { kind: "EXACT", amountCents: 20_000 },
        ...knownRows([-2_000]),
        derivedCents: 17_999,
      }),
    ).toThrow(new RegExp(`${NIGHT_ADJUSTMENT_INVARIANT}.*without a classified`));
  });

  it("keeps the Xero result at one aggregate signed promo amount", () => {
    const result = selectBookingMoneyBuildUp({
      operation: "XERO_PROMO_LINE",
      baseEvidence: { kind: "EXACT", amountCents: 40_500 },
      ...knownRows([-500, -400, 350]),
      derivedCents: -550,
    });
    expect(result).toMatchObject({ source: "STORED", selectedCents: -550 });
  });

  it("loads base evidence at the operation's grain", async () => {
    const store = {
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          totalPriceCents: 10_001,
          guests: [
            {
              id: "departing",
              priceCents: 10_001,
              nights: [
                { id: "night-1", priceCents: 5_000, priceSource: "EVEN_SPLIT" },
                { id: "night-2", priceCents: 5_001, priceSource: "EVEN_SPLIT" },
              ],
            },
          ],
          promoRedemption: null,
          nightAdjustments: [],
        }),
      },
    };

    await expect(
      readBookingMoneyBuildUp(store as never, {
        bookingId: "booking-1",
        bookingGuestId: "departing",
        operation: "GUEST_REMOVAL",
      }),
    ).resolves.toMatchObject({
      baseEvidence: { kind: "EXACT", amountCents: 10_001 },
    });
    await expect(
      readBookingMoneyBuildUp(store as never, {
        bookingId: "booking-1",
        operation: "REVIEW_REBASE",
      }),
    ).resolves.toMatchObject({
      baseEvidence: { kind: "UNKNOWN", reason: "INEXACT_STORED_NIGHT_PRICES" },
    });
    for (const operation of ["CREDIT_ELECTION", "XERO_PROMO_LINE"] as const) {
      await expect(
        readBookingMoneyBuildUp(store as never, {
          bookingId: "booking-1",
          operation,
        }),
      ).resolves.toMatchObject({
        baseEvidence: { kind: "EXACT", amountCents: 10_001 },
      });
    }
  });

  it("projects both direct guest and night-anchored adjustment targets", async () => {
    const store = {
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          totalPriceCents: 20_000,
          promoRedemption: null,
          nightAdjustments: [
            {
              bookingGuestId: "guest-direct",
              beneficiaryMemberId: BOOKER,
              amountCents: -500,
              bookingGuestNightId: null,
            },
            {
              bookingGuestId: null,
              beneficiaryMemberId: BOOKER,
              amountCents: 250,
              bookingGuestNightId: "night-target",
            },
          ],
          guests: [
            {
              id: "guest-night",
              priceCents: 20_000,
              nights: [
                { id: "night-target", priceCents: 20_000, priceSource: "SOLD" },
              ],
            },
          ],
        }),
      },
    };
    const loaded = await readBookingMoneyBuildUp(store as never, {
      bookingId: "booking-1",
      operation: "XERO_PROMO_LINE",
    });
    expect(loaded.rows).toEqual([
      {
        bookingGuestId: "guest-direct",
        beneficiaryMemberId: BOOKER,
        amountCents: -500,
      },
      {
        bookingGuestId: "guest-night",
        beneficiaryMemberId: BOOKER,
        amountCents: 250,
      },
    ]);
  });
});
