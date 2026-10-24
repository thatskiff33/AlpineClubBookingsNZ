import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4272: the recovery replay's cancelled-booking path. The record it writes is
 * proved against the real request module in `edit-financial-review-charge.test.ts`
 * (`settleCancelledEditReviewCharge`); here, the order around it - only on a
 * cancelled booking, only holding the edit's raise claim, and the row closed only
 * once the record is written.
 */
const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  complete: vi.fn(),
  sumShares: vi.fn(),
  findRequest: vi.fn(),
  record: vi.fn(),
  auditLogFindMany: vi.fn(),
  recoveryUpdateMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
    auditLog: { findMany: (...a: unknown[]) => mocks.auditLogFindMany(...a) },
    paymentTransaction: { findUnique: async () => ({ refundedAmountCents: 0, refunds: [] }) },
    // The real hold's fenced write (#4272 review): asserted, not stubbed.
    paymentRecoveryOperation: { updateMany: (...a: unknown[]) => mocks.recoveryUpdateMany(...a) },
  },
}));
vi.mock("@/lib/edit-financial-review-charge-raise-claim", () => ({
  claimEditReviewChargeRaise: (...a: unknown[]) => mocks.claim(...a),
  releaseEditReviewChargeRaise: (...a: unknown[]) => mocks.release(...a),
}));
vi.mock("@/lib/edit-financial-review-charge-recovery", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/edit-financial-review-charge-recovery")),
  completeEditFinancialReviewChargeRecovery: (...a: unknown[]) => mocks.complete(...a),
}));
vi.mock("@/lib/edit-financial-review-charge-request", () => ({
  sumEditReviewChargeSharesCents: (...a: unknown[]) => mocks.sumShares(...a),
  findEditReviewChargeRequest: (...a: unknown[]) => mocks.findRequest(...a),
  recordUncollectedEditReviewChargeShare: (...a: unknown[]) => mocks.record(...a),
}));

import { closeCancelledEditReviewChargeReplay } from "@/lib/edit-financial-review-charge-cancelled";

const operation = {
  id: "op-1",
  bookingId: "booking-1",
  paymentId: "payment-1",
  // This claim's attempt: the third.
  attempts: 3,
  nextRetryAt: null,
  processingStartedAt: new Date("2026-07-01T00:00:00.000Z"),
};
const args = { format: CLUB_FORMAT_TEST, operation, bookingModificationId: "mod-1", memberId: "member-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue({ bookingModificationId: "mod-1", token: "t-1" });
  mocks.release.mockResolvedValue(true);
  mocks.complete.mockResolvedValue(undefined);
  mocks.sumShares.mockResolvedValue(20000);
  mocks.findRequest.mockResolvedValue(null);
  mocks.record.mockResolvedValue(undefined);
  mocks.auditLogFindMany.mockResolvedValue([]);
  mocks.recoveryUpdateMany.mockResolvedValue({ count: 1 });
});

describe("closeCancelledEditReviewChargeReplay (#4272)", () => {
  it("records the uncollected share under the claim, then closes the row", async () => {
    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CANCELLED" })).resolves.toBe(true);

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "booking-cancelled", bookingModificationId: "mod-1", memberId: "member-1" }),
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.record.mock.invocationCallOrder[0]);
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(operation);
  });

  it("re-reads the status when the caller has none (a cancellation landing mid-replay)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ status: "CANCELLED" });

    await expect(closeCancelledEditReviewChargeReplay(args)).resolves.toBe(true);

    expect(mocks.bookingFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a live booking is not its business - nothing claimed, recorded or closed", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ status: "PAID" });

    await expect(closeCancelledEditReviewChargeReplay(args)).resolves.toBe(false);
    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CONFIRMED" })).resolves.toBe(false);

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("throws, leaving the row open, when another run holds the edit's claim", async () => {
    mocks.claim.mockResolvedValue(null);

    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CANCELLED" })).rejects.toThrow(/holds the charge raise claim/);

    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("throws, leaving the row open, when the record cannot be written - and still releases the claim", async () => {
    mocks.record.mockRejectedValue(new Error("audit sink down"));

    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CANCELLED" })).rejects.toThrow("audit sink down");

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("waits, WITHOUT spending an attempt, while the request is still processing at Stripe", async () => {
    // A bank debit can sit PROCESSING for days; five ordinary retries would
    // kill the row and hand a cancelled booking to the repair pass.
    mocks.findRequest.mockResolvedValue({
      paymentTransactionId: "ptx-1",
      stripePaymentIntentId: "pi_1",
      amountCents: 20000,
      carriedAskCents: 0,
      status: "PROCESSING",
    });

    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CANCELLED" })).resolves.toBe(true);

    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryUpdateMany).toHaveBeenCalledTimes(1);
    const [{ where, data }] = mocks.recoveryUpdateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    // Fenced on this exact attempt, and handed back with the attempt it took returned.
    expect(where).toMatchObject({ id: "op-1", status: "PROCESSING", processingStartedAt: operation.processingStartedAt });
    expect(data).toMatchObject({ status: "PENDING", attempts: 2, processingStartedAt: null });
    expect((data.nextRetryAt as Date).getTime()).toBeGreaterThan(Date.now());
  });
});
