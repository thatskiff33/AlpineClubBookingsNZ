import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  censusBookingMoneyReconciliation,
  readBookingMoneyReconciliation,
  type StoredBookingMoneyReconciliationProjection,
} from "@/lib/booking-money-reconciliation-store";

const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");

function row(
  overrides: Partial<StoredBookingMoneyReconciliationProjection> = {},
): StoredBookingMoneyReconciliationProjection {
  return {
    id: "booking-1",
    checkIn: NIGHT,
    checkOut: CHECK_OUT,
    totalPriceCents: 10_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 10_000,
    guests: [
      {
        priceCents: 10_000,
        stayStart: NIGHT,
        stayEnd: CHECK_OUT,
        nights: [
          {
            stayDate: NIGHT,
            priceCents: 10_000,
            priceSource: "SOLD",
          },
        ],
      },
    ],
    promoRedemption: null,
    nightAdjustments: [],
    ...overrides,
  };
}

describe("booking money reconciliation store", () => {
  it("loads the canonical projection through the caller-owned store", async () => {
    const findUnique = vi.fn().mockResolvedValue(row());
    await expect(
      readBookingMoneyReconciliation({ booking: { findUnique } } as never, "booking-1"),
    ).resolves.toEqual({ state: "RECONCILED", reasons: [] });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "booking-1" } }),
    );
  });

  it("counts every simultaneous reason from one ordered repeatable-read snapshot", async () => {
    const promo = {
      priceAdjustmentCents: -2_000,
      allocations: [{ memberId: "member-1", priceAdjustmentCents: -2_000 }],
    };
    const findMany = vi.fn().mockResolvedValue([
      row(),
      row({
        id: "booking-even-split",
        guests: [
          {
            priceCents: 10_000,
            stayStart: NIGHT,
            stayEnd: CHECK_OUT,
            nights: [
              { stayDate: NIGHT, priceCents: 10_000, priceSource: "EVEN_SPLIT" },
            ],
          },
        ],
      }),
      row({ id: "booking-no-strands", guests: [] }),
      row({
        id: "booking-unreadable",
        guests: [
          {
            priceCents: 10_000,
            stayStart: NIGHT,
            stayEnd: CHECK_OUT,
            nights: [
              { stayDate: NIGHT, priceCents: null, priceSource: "UNKNOWN" },
            ],
          },
        ],
      }),
      row({
        id: "booking-headline",
        totalPriceCents: 9_000,
        finalPriceCents: 9_000,
      }),
      row({
        id: "booking-promo-unknown",
        promoAdjustmentCents: -2_000,
        discountCents: 2_000,
        finalPriceCents: 8_000,
        promoRedemption: promo,
        nightAdjustments: [
          { beneficiaryMemberId: "member-1", amountCents: null },
        ],
      }),
      row({
        id: "booking-promo-mismatch",
        promoAdjustmentCents: -2_000,
        discountCents: 2_000,
        finalPriceCents: 8_000,
        promoRedemption: {
          priceAdjustmentCents: -1_000,
          allocations: [
            { memberId: "member-1", priceAdjustmentCents: -1_000 },
          ],
        },
        nightAdjustments: [
          { beneficiaryMemberId: "member-1", amountCents: -1_000 },
        ],
      }),
      row({ id: "booking-discount", discountCents: 1 }),
      row({ id: "booking-final", finalPriceCents: 123 }),
    ]);
    const transaction = vi.fn(async (callback) =>
      callback({ booking: { findMany } }),
    );
    const result = await censusBookingMoneyReconciliation({
      $transaction: transaction,
    } as never);

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: "asc" } }),
    );
    expect(result).toMatchObject({
      totalBookings: 9,
      byState: { RECONCILED: 2, UNRECONCILED: 7 },
      byReason: {
        NO_SURVIVING_STRANDS: 1,
        STRAND_EVIDENCE_UNREADABLE: 1,
        HEADLINE_TOTAL_MISMATCH: 1,
        PROMO_BUILD_UP_NOT_KNOWN: 1,
        PROMO_BUILD_UP_MISMATCH: 1,
        DISCOUNT_COMPONENT_MISMATCH: 1,
        FINAL_PRICE_RELATION_MISMATCH: 1,
      },
    });
  });
});
