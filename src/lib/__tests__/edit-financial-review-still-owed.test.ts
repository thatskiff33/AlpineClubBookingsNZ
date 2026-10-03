import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3835: the settle dialog's preview is the completion's own route choice and
 * netting, run in a transaction that never commits. The figures are proven
 * equal to the completion's on PostgreSQL
 * (`edit-financial-review-captured-cancel.realdb.test.ts`); this pins the
 * branches: which bookings are previewed, the route each figure is read from,
 * the refusal passed on, and the rollback.
 */
const h = vi.hoisted(() => ({
  task: null as unknown,
  choose: vi.fn(),
  owed: vi.fn(),
  committed: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn({ manualRefundTask: { findUnique: async () => h.task } });
      h.committed = true;
      return result;
    },
  },
}));
vi.mock("@/lib/edit-financial-review-settlement", () => ({ chooseEditReviewSettlementRoute: h.choose }));
vi.mock("@/lib/edit-financial-review-cancel-netting", () => ({ capturedShareOwedAfterCancellationCents: h.owed }));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {},
}));

import { requireClubTimeZone } from "@/lib/club-time";
import { previewEditReviewStillOwed } from "@/lib/edit-financial-review-still-owed";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";

const preview = () => previewEditReviewStillOwed({ taskId: "task-1", shareCents: 5_000, clubZone: requireClubTimeZone("Pacific/Auckland") });
const reviewOn = (status: string) => ({
  id: "task-1", bookingId: "booking-1", kind: "EDIT_FINANCIAL_REVIEW", status: "OPEN",
  booking: { status, checkIn: new Date("2026-08-01T00:00:00.000Z"), lodgeId: "lodge-1", payment: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.committed = false;
  h.task = reviewOn("CANCELLED");
});

describe("previewEditReviewStillOwed (#3835)", () => {
  it.each([
    ["card", { kind: "stripe-refund", refundCents: 2_500 }],
    ["hand-back", { kind: "local-allocation", refundCents: 2_500 }],
  ])("MUTATION: the %s figure is the route's own netted refund, and nothing commits", async (route, chosen) => {
    h.choose.mockResolvedValue(chosen);

    expect(await preview()).toEqual({ shareCents: 5_000, stillOwedCents: 2_500, route });
    expect(h.choose).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5_000, direction: "REFUND_TO_MEMBER" }));
    expect(h.committed).toBe(false);
  });

  it("MUTATION: credit minted against the payment is netted by the writer's own function", async () => {
    h.choose.mockResolvedValue({ kind: "account-credit", allocateAgainstPaymentId: "payment-1" });
    h.owed.mockResolvedValue(2_500);

    expect(await preview()).toEqual({ shareCents: 5_000, stillOwedCents: 2_500, route: "account-credit" });
    expect(h.owed).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "booking-1", taskId: "task-1", shareCents: 5_000 }));
  });

  it("MUTATION: passes the completion's refusal on, as the sentence it would refuse with", async () => {
    h.choose.mockRejectedValue(new ManualBookingPaymentError("Refused."));

    expect(await preview()).toEqual({ shareCents: 5_000, refusal: "Refused." });
  });

  it("MUTATION: previews nothing on a booking that was not cancelled, or on the credit-only route", async () => {
    h.task = reviewOn("PAID");
    expect(await preview()).toBeNull();
    expect(h.choose).not.toHaveBeenCalled();

    h.task = reviewOn("CANCELLED");
    h.choose.mockResolvedValue({ kind: "account-credit", allocateAgainstPaymentId: null });
    expect(await preview()).toBeNull();
  });
});
