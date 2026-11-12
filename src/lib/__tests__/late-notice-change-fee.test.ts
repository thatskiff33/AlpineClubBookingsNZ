import { describe, expect, it, vi } from "vitest";

// The predicate is pure. Its module also loads the cancellation policy reader,
// which constructs Prisma at import, so the client is doubled here.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { lateNoticeChangeFeeApplies } from "@/lib/late-notice-change-fee";

/**
 * Owner decision, 10 Nov 2026: a late-notice change fee is charged only once
 * the booking has been paid. Who holds a bed is not an input.
 */
const zeroCaptured = { status: "SUCCEEDED", amountCents: 0 };
const uncaptured = { status: "PENDING", amountCents: 20_000 };

describe("lateNoticeChangeFeeApplies", () => {
  it("is true for a paid or completed booking even when the payment captured nothing", () => {
    expect(lateNoticeChangeFeeApplies({ status: "PAID", payment: zeroCaptured })).toBe(true);
    expect(lateNoticeChangeFeeApplies({ status: "COMPLETED", payment: zeroCaptured })).toBe(true);
  });

  it("is false for an unpaid booking, with an uncaptured row or with none", () => {
    for (const status of ["CONFIRMED", "PAYMENT_PENDING", "PENDING"]) {
      expect(lateNoticeChangeFeeApplies({ status, payment: uncaptured }), status).toBe(false);
      expect(lateNoticeChangeFeeApplies({ status, payment: null }), status).toBe(false);
    }
  });

  it("is true when money has been captured and the booking status has not flipped yet", () => {
    expect(
      lateNoticeChangeFeeApplies({
        status: "PAYMENT_PENDING",
        payment: { status: "SUCCEEDED", amountCents: 20_000 },
      }),
    ).toBe(true);
  });

  it("is false for a draft", () => {
    expect(lateNoticeChangeFeeApplies({ status: "DRAFT", payment: null })).toBe(false);
  });
});
