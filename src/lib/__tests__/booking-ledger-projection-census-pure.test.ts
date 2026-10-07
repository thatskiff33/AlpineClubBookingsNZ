/**
 * The projection census and the group child planner it shares with the
 * back-post load without the Prisma client (#3854): they judge one snapshot
 * in memory, so nothing on their import chain may reach `@/lib/prisma` — the
 * reason the kept formula lives in `cancellation-kept.ts`, not
 * `paid-cancellation-money.ts` (whose `cancellation.ts` does).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => {
  throw new Error("the census reached @/lib/prisma");
});

describe("census purity (#3854)", () => {
  it("imports the census, its report, and the group child planner without reaching the Prisma client", async () => {
    const census = await import("@/lib/booking-ledger-projection-census");
    const report = await import("@/lib/booking-ledger-projection-census-report");
    const plan = await import("@/lib/booking-ledger-group-child-plan");
    expect(typeof census.evaluateBookingLedgerIdentities).toBe("function");
    expect(typeof report.summarizeBookingLedgerCensus).toBe("function");
    expect(plan.groupSettledChildKeptFrom({ amountCents: 4_500, refundedAmountCents: 0, openNonCancellationHandBackCents: 0 }, { kind: "per-child", committedRefundCents: 5_000 })).toBe(0);
    expect(plan.groupSettledChildKeptFrom({ amountCents: 4_500, refundedAmountCents: 0, openNonCancellationHandBackCents: 0 }, { kind: "per-child", committedRefundCents: 1_500 })).toBe(3_000);
    // #3827 (`INV-PAY-117`): an open edit hand-back is still owed back, so the club keeps none of it.
    expect(plan.groupSettledChildKeptFrom({ amountCents: 4_500, refundedAmountCents: 0, openNonCancellationHandBackCents: 1_000 }, { kind: "per-child", committedRefundCents: 1_500 })).toBe(2_000);
    // #3854 sync lens F1: only the OPEN edit hand-backs are the cancel's; a paid appeal comes back out of the refunds.
    expect(plan.groupChildHandBacksFromRows("pay", [
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "OPEN", occurrenceKey: "edit-refund-hand-back:m1", paymentId: "pay", amountCents: 1_000 },
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "OPEN", occurrenceKey: null, paymentId: "pay", amountCents: 7_000 },
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", occurrenceKey: "edit-refund-hand-back:m0", paymentId: "pay", amountCents: 500 },
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "OPEN", occurrenceKey: "edit-refund-hand-back:m2", paymentId: "other", amountCents: 300 },
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "OPEN", occurrenceKey: "refund-request-hand-back:r1", paymentId: "pay", amountCents: 900 },
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", occurrenceKey: "refund-request-hand-back:r2", paymentId: "pay", amountCents: 400 },
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "DISMISSED", occurrenceKey: "refund-request-hand-back:r3", paymentId: "pay", amountCents: 200 },
      { kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", occurrenceKey: "refund-request-hand-back:r4", paymentId: "other", amountCents: 100 },
    ])).toEqual({ openEditRefundHandBackCents: 1_000, completedRefundRequestHandBackCents: 400 });
  });
});
