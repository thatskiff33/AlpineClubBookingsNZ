// #4210 round 3 (`INV-PAY-136`, UX 2): a dead row raised for an officer to
// check against a "Paid another way" close, closed as checked - not owed. One
// status-guarded write and its audit row; no money, ledger or Xero.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOperation: vi.fn(),
  claim: vi.fn(),
  findBooking: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ createAuditLog: (...args: unknown[]) => mocks.createAuditLog(...args) }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    paymentRecoveryOperation: {
      findUnique: (...args: unknown[]) => mocks.findOperation(...args),
      updateMany: (...args: unknown[]) => mocks.claim(...args),
    },
    booking: { findUnique: (...args: unknown[]) => mocks.findBooking(...args) },
  };
  return { prisma: { $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } };
});

import { CHECKED_NOT_OWED_MARKER, CardRefundCheckNotOwedError, closeCardRefundCheckNotOwed } from "@/lib/card-refund-check-not-owed";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS, PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";

const CHECK = { closedOperationId: "op-cancel", reason: "part-close" };
const checkRow = (over: Record<string, unknown> = {}) => ({
  id: "op-check",
  type: "REFUND_BOOKING_MODIFICATION",
  status: "PENDING",
  attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
  bookingId: "b-1",
  paymentId: "p-1",
  amountCents: 3_000,
  allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 3_000, madeByOperationId: "op-cancel", paidAnotherWayCheck: CHECK }],
  ...over,
});

const close = (note: string | null = "Checked the bank: the close paid it") =>
  closeCardRefundCheckNotOwed({ operationId: "op-check", note, actingMemberId: "treasurer-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOperation.mockResolvedValue(checkRow());
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.findBooking.mockResolvedValue({ memberId: "member-1" });
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("closing a check row as checked - not owed", () => {
  it("MUTATION: one write, guarded on the dead row as read, to SUCCEEDED with its marker", async () => {
    await expect(close()).resolves.toEqual({ operationId: "op-check", bookingId: "b-1", amountCents: 3_000 });
    expect(mocks.claim).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "op-check",
        // Dead by the one rule, and as it was read.
        AND: [PAYMENT_RECOVERY_EXHAUSTED_WHERE, { status: "PENDING", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS }],
        allocationPlan: { equals: checkRow().allocationPlan },
      }),
      data: expect.objectContaining({ status: "SUCCEEDED", nextRetryAt: null, lastError: CHECKED_NOT_OWED_MARKER }),
    });
  });

  it("MUTATION: audits it under payment, with the note and why it was a check - after the write", async () => {
    await close();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.card-refund.checked-not-owed",
        category: "payment",
        entityType: "PaymentRecoveryOperation",
        entityId: "op-check",
        targetId: "b-1",
        actorMemberId: "treasurer-1",
        subjectMemberId: "member-1",
        details: "Checked the bank: the close paid it",
        metadata: expect.objectContaining({ amountCents: 3_000, checkReason: "part-close", closedOperationId: "op-cancel" }),
      }),
      expect.anything(),
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.createAuditLog.mock.invocationCallOrder[0] ?? 0);
  });

  describe("refuses, and writes nothing", () => {
    async function expectRefusal(promise: Promise<unknown>, status: number) {
      await expect(promise).rejects.toBeInstanceOf(CardRefundCheckNotOwedError);
      await expect(promise).rejects.toMatchObject({ status });
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    }

    it("no note", async () => {
      await expectRefusal(close("  "), 400);
      expect(mocks.findOperation).not.toHaveBeenCalled();
    });

    it("no such row", async () => {
      mocks.findOperation.mockResolvedValue(null);
      await expectRefusal(close(), 404);
    });

    it("MUTATION: a row the runner sends, or any dead row not raised for a check - that is for \"Paid another way\"", async () => {
      mocks.findOperation.mockResolvedValue(checkRow({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 3_000, madeByOperationId: "op-cancel" }] }));
      await expectRefusal(close(), 409);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: a check row not dead - still being retried, or already closed", async () => {
      mocks.findOperation.mockResolvedValue(checkRow({ attempts: 1 }));
      await expectRefusal(close(), 409);
      mocks.findOperation.mockResolvedValue(checkRow({ status: "SUCCEEDED" }));
      await expectRefusal(close(), 409);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: a lost claim - closed or re-planned since it was read", async () => {
      mocks.claim.mockResolvedValue({ count: 0 });
      await expectRefusal(close(), 409);
    });
  });
});
