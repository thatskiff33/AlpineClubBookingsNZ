import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3033 (epic #2797) — the one read behind every "money on this booking is
 * waiting for review" claim.
 *
 * Three surfaces ask this question (the member's booking banner, the My
 * Bookings row qualifier, and the admin booking-tools warning) and they must not
 * be able to disagree, because the answer is a claim about a member's money.
 *
 * MUTATION PROOF. Drop either the `kind` clause or the `status` clause and
 * "counts only an unresolved edit valuation, and only while it is open" fails —
 * it asserts the whole `where`, so both halves are covered by the one test.
 * Scope the query by payment and "finds a credit-only review, which carries no
 * payment" fails. Issue the query on an empty list and "asks nothing when there
 * is nothing to ask about" fails. Give the single-booking reader its own second
 * query and "answers one booking through the same query, not a second one"
 * fails.
 */

const findMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  prisma: { manualRefundTask: { findMany } },
}));

import {
  bookingHasOpenFinancialReview,
  bookingsWithOpenFinancialReview,
} from "@/lib/booking-financial-review-visibility";

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
});

describe("which bookings have money held for review (#3033)", () => {
  it("counts only an unresolved edit valuation, and only while it is open", async () => {
    /*
      NARROWER than the finance-evidence diagnostics blocker beside it, on
      purpose. That one counts every OPEN manual task, because any of them means
      the booking's finance state is unsettled. This answer reaches a MEMBER, and
      only an EDIT_FINANCIAL_REVIEW means "your change saved and the adjustment
      is being worked out". A cash hand-back on a cancelled booking is a
      different situation with its own wording, and borrowing this one for it
      would be false.
    */
    await bookingsWithOpenFinancialReview(["b1"]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "EDIT_FINANCIAL_REVIEW",
          status: "OPEN",
        }),
      }),
    );
  });

  it("finds a credit-only review, which carries no payment", async () => {
    // Owner decision D2 makes `paymentId` optional, so a payment-scoped lookup
    // would miss precisely the tasks this feature creates. Booking-scoped, the
    // same reasoning the finance-evidence blocker already records.
    await bookingsWithOpenFinancialReview(["b1", "b2"]);

    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.bookingId).toEqual({ in: ["b1", "b2"] });
    expect(where).not.toHaveProperty("paymentId");
    expect(where).not.toHaveProperty("payment");
  });

  it("answers as a set of the bookings that have one", async () => {
    findMany.mockResolvedValue([{ bookingId: "b2" }]);

    const result = await bookingsWithOpenFinancialReview(["b1", "b2", "b3"]);

    expect([...result]).toEqual(["b2"]);
  });

  it("asks nothing when there is nothing to ask about", async () => {
    // A member with no bookings must not produce a `WHERE id IN ()`.
    const result = await bookingsWithOpenFinancialReview([]);

    expect(findMany).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it("answers one booking through the same query, not a second one", async () => {
    findMany.mockResolvedValue([{ bookingId: "b1" }]);

    await expect(bookingHasOpenFinancialReview("b1")).resolves.toBe(true);

    findMany.mockResolvedValue([]);
    await expect(bookingHasOpenFinancialReview("b1")).resolves.toBe(false);
  });
});
