import { describe, expect, it } from "vitest";

import {
  BOOKING_MONEY_RECONCILIATION_REASON_ORDER,
  reconcileBookingMoney,
  summarizeBookingMoneyReconciliations,
  type BookingMoneyReconciliationProjection,
} from "@/lib/booking-money-reconciliation";

const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

function booking(
  overrides: Partial<BookingMoneyReconciliationProjection> = {},
): BookingMoneyReconciliationProjection {
  return {
    checkIn: NIGHT,
    checkOut: CHECK_OUT,
    totalPriceCents: 10_000,
    discountCents: 2_000,
    promoAdjustmentCents: -2_000,
    finalPriceCents: 8_000,
    guests: [
      {
        priceCents: 10_000,
        stayStart: null,
        stayEnd: null,
        nights: [
          {
            stayDate: NIGHT,
            priceCents: 10_000,
            priceSource: "SOLD",
          },
        ],
      },
    ],
    promoRedemption: {
      priceAdjustmentCents: -2_000,
      allocations: [{ memberId: "member-1", priceAdjustmentCents: -2_000 }],
    },
    nightAdjustments: [
      { beneficiaryMemberId: "member-1", amountCents: -2_000 },
    ],
    ...overrides,
  };
}

describe("reconcileBookingMoney", () => {
  it("classifies a booking satisfying all four identities as reconciled", () => {
    expect(reconcileBookingMoney(booking())).toEqual({
      state: "RECONCILED",
      reasons: [],
    });
  });

  it("accepts an evenly split row at whole-guest grain when it reconciles", () => {
    const value = booking();
    value.guests[0]!.nights[0]!.priceSource = "EVEN_SPLIT";
    expect(reconcileBookingMoney(value).state).toBe("RECONCILED");
  });

  it.each([
    ["NO_SURVIVING_STRANDS", { guests: [] }],
    [
      "STRAND_EVIDENCE_UNREADABLE",
      {
        guests: [
          {
            priceCents: 10_000,
            stayStart: null,
            stayEnd: null,
            nights: [
              {
                stayDate: NIGHT,
                priceCents: null,
                priceSource: "UNKNOWN" as const,
              },
            ],
          },
        ],
      },
    ],
    ["HEADLINE_TOTAL_MISMATCH", { totalPriceCents: 9_999, finalPriceCents: 7_999 }],
    [
      "PROMO_BUILD_UP_NOT_KNOWN",
      {
        nightAdjustments: [
          { beneficiaryMemberId: "member-1", amountCents: null },
        ],
      },
    ],
    [
      "PROMO_BUILD_UP_MISMATCH",
      {
        promoAdjustmentCents: -1_500,
        discountCents: 1_500,
        finalPriceCents: 8_500,
      },
    ],
    ["DISCOUNT_COMPONENT_MISMATCH", { discountCents: 1_999 }],
    ["FINAL_PRICE_RELATION_MISMATCH", { finalPriceCents: 8_001 }],
  ] as const)("reports %s", (reason, overrides) => {
    expect(reconcileBookingMoney(booking(overrides)).reasons).toContain(reason);
  });

  it("retains every simultaneous reason in the approved deterministic order", () => {
    const value = booking({
      guests: [],
      totalPriceCents: 12_000,
      promoAdjustmentCents: -1_500,
      discountCents: 42,
      finalPriceCents: 7,
      nightAdjustments: [
        { beneficiaryMemberId: "member-1", amountCents: null },
      ],
    });
    expect(reconcileBookingMoney(value)).toEqual({
      state: "UNRECONCILED",
      reasons: [
        "NO_SURVIVING_STRANDS",
        "PROMO_BUILD_UP_NOT_KNOWN",
        "DISCOUNT_COMPONENT_MISMATCH",
        "FINAL_PRICE_RELATION_MISMATCH",
      ],
    });
    expect(BOOKING_MONEY_RECONCILIATION_REASON_ORDER).toEqual([
      "NO_SURVIVING_STRANDS",
      "STRAND_EVIDENCE_UNREADABLE",
      "HEADLINE_TOTAL_MISMATCH",
      "PROMO_BUILD_UP_NOT_KNOWN",
      "PROMO_BUILD_UP_MISMATCH",
      "DISCOUNT_COMPONENT_MISMATCH",
      "FINAL_PRICE_RELATION_MISMATCH",
    ]);
  });

  it("does not turn unknown promo evidence into a zero adjustment", () => {
    const result = reconcileBookingMoney(
      booking({
        promoAdjustmentCents: 0,
        discountCents: 0,
        finalPriceCents: 10_000,
        promoRedemption: {
          priceAdjustmentCents: -2_000,
          allocations: [
            { memberId: "member-1", priceAdjustmentCents: -2_000 },
          ],
        },
        nightAdjustments: [
          { beneficiaryMemberId: "member-1", amountCents: null },
        ],
      }),
    );
    expect(result.reasons).toEqual(["PROMO_BUILD_UP_NOT_KNOWN"]);
  });

  it.each([-2_000, 2_000])(
    "keeps a member-less allocation of %i cents unknown rather than inventing zero",
    (priceAdjustmentCents) => {
      const result = reconcileBookingMoney(
        booking({
          promoAdjustmentCents: 0,
          discountCents: 0,
          finalPriceCents: 10_000,
          promoRedemption: {
            priceAdjustmentCents,
            allocations: [{ memberId: null, priceAdjustmentCents }],
          },
          nightAdjustments: [],
        }),
      );
      expect(result).toEqual({
        state: "UNRECONCILED",
        reasons: ["PROMO_BUILD_UP_NOT_KNOWN"],
      });
    },
  );

  it("summarizes every reason without collapsing simultaneous failures", () => {
    const summary = summarizeBookingMoneyReconciliations([
      booking(),
      booking({ discountCents: 1, finalPriceCents: 1 }),
    ]);
    expect(summary.byState).toEqual({ RECONCILED: 1, UNRECONCILED: 1 });
    expect(summary.byReason.DISCOUNT_COMPONENT_MISMATCH).toBe(1);
    expect(summary.byReason.FINAL_PRICE_RELATION_MISMATCH).toBe(1);
  });

  it("classifies #3244's added-guest mismatch without deciding collection or card routing", () => {
    const value = booking({
      guests: [
        ...booking().guests,
        {
          priceCents: 2_000,
          stayStart: null,
          stayEnd: null,
          nights: [
            {
              stayDate: NIGHT,
              priceCents: 2_000,
              priceSource: "SOLD",
            },
          ],
        },
      ],
    });
    expect(reconcileBookingMoney(value)).toEqual({
      state: "UNRECONCILED",
      reasons: ["HEADLINE_TOTAL_MISMATCH"],
    });
    expect("payment" in value).toBe(false);
  });
});

/*
  #3278 — THE LEGACY BACKFILL POPULATION, PINNED RATHER THAN SUPPRESSED.

  Both migrations that divided stored guest totals across nights
  (`20260704150000` and `20260810010000`) carry
  `status NOT IN ('CANCELLED', 'BUMPED')`, so a booking that was already
  cancelled or bumped when they ran has no `BookingGuestNight` rows at all. Its
  guests fall back to the stay envelope, every night reads `null`, and the
  verdict is `STRAND_EVIDENCE_UNREADABLE` — permanently, for a booking nobody
  can do anything about.

  It is tempting to suppress that by status, and this deliberately does not.
  The classifier is handed no status and must not grow one: turning unknown
  evidence into a pass for a whole population is the single move epic #2797
  exists to forbid, `reconcileBookingMoney`'s own contract says it never does
  it, and the club's finance diagnostics already state in as many words that a
  CANCELLED or BUMPED booking's MONEY may still need attention — a terminal
  booking can hold a captured payment, an incomplete refund and a Xero invoice.
  Status is also a lossy proxy for the population in both directions: a booking
  cancelled today HAS night rows and a meaningful verdict, and a live booking
  whose rows a defect deleted is exactly what an officer must see.

  What removed the harm was the audience decision (owner, 20 September 2026):
  the verdict is officer-only, so this is a row in an officer's queue rather
  than alarm on a member's screen, and it arrives under its own reason name, so
  a census sorted by reason sets the whole population aside in one move without
  the code claiming any of it reconciles.
*/
describe("a legacy booking the night backfills skipped (#3278)", () => {
  function terminalLegacyBooking(): BookingMoneyReconciliationProjection {
    const value = booking();
    // What those migrations left behind: a stored guest total, and no rows.
    value.guests[0]!.nights = [];
    return value;
  }

  it("is reported as unreadable evidence rather than quietly reconciled", () => {
    const result = reconcileBookingMoney(terminalLegacyBooking());
    expect(result.state).toBe("UNRECONCILED");
    expect(result.reasons).toContain("STRAND_EVIDENCE_UNREADABLE");
  });

  it("never claims the headline total agrees with evidence it does not have", () => {
    expect(reconcileBookingMoney(terminalLegacyBooking()).reasons).not.toContain(
      "HEADLINE_TOTAL_MISMATCH",
    );
  });
});
