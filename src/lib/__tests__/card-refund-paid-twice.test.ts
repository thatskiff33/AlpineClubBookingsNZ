// #3924 round 5 (concurrency F2) and #3372 (owner, 9 Oct 2026: "Add a
// 'Resolved' button"): the card refunds closed as paid another way that Stripe
// paid as well - the list, and the Resolved mark that takes a row off it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  listRecords: vi.fn(),
  findRecord: vi.fn(),
  claim: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ createAuditLog: (...args: unknown[]) => mocks.createAuditLog(...args) }));
vi.mock("@/lib/prisma", () => {
  const tx = { manualRefundTask: { updateMany: (...args: unknown[]) => mocks.claim(...args) } };
  return {
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      manualRefundTask: {
        findMany: (...args: unknown[]) => mocks.listRecords(...args),
        findFirst: (...args: unknown[]) => mocks.findRecord(...args),
      },
    },
  };
});

import {
  CardRefundPaidTwiceError,
  listCardRefundsPaidTwice,
  readPaidTwiceResolution,
  resolveCardRefundPaidTwice,
} from "@/lib/card-refund-paid-twice";

const CLOSED_AT = new Date("2026-06-25T00:00:00.000Z");
const STRIPE_BEFORE_CLOSE = { stripeCreatedAt: new Date("2026-06-24T23:59:00.000Z"), createdAt: new Date("2026-06-26T00:00:00.000Z") };

/** A $150.00 card refund closed as paid another way at CLOSED_AT, with the refunds the payment then recorded. */
function closeRecord(refunds: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    id: "close-1",
    kind: "CANCELLED_BOOKING_HAND_BACK",
    occurrenceKey: "card-refund-paid-another-way:op-1",
    bookingId: "b-1",
    amountCents: 15_000,
    completedAt: CLOSED_AT,
    reviewContext: null as unknown,
    booking: { memberId: "member-1" },
    payment: {
      id: "p-1",
      bookingId: "b-1",
      status: "PARTIALLY_REFUNDED",
      amountCents: 20_000,
      refundedAmountCents: 30_000,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      transactions: [],
      source: "STRIPE",
      _count: { transactions: 1 },
      recoveryOperations: [
        {
          id: "op-1",
          type: "REFUND_BOOKING_MODIFICATION",
          status: "SUCCEEDED",
          idempotencyKey: "booking_cancel_refund_recovery_b-1",
          paymentTransactionId: null,
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 15_000 }],
          amountCents: 15_000,
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
          succeededAt: CLOSED_AT,
        },
      ],
      refunds: refunds.map((refund) => ({ paymentTransactionId: "txn-1", amountCents: 15_000, status: "succeeded", ...refund })),
      booking: { deletedAt: null, status: "CANCELLED", creditsApplied: [], creditsFromCancellation: [], manualRefundTasks: [] },
    },
    ...overrides,
  };
}

const resolution = (refundedByCardCents: number) => ({
  paidTwiceResolved: { resolvedAt: "2026-06-30T00:00:00.000Z", resolvedByMemberId: "treasurer-0", note: "Sorted", refundedByCardCents },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRecords.mockResolvedValue([]);
  mocks.findRecord.mockResolvedValue(closeRecord([STRIPE_BEFORE_CLOSE]));
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("the list of card refunds paid back twice", () => {
  it("MUTATION: a refund Stripe made before the close and the app recorded after it", async () => {
    mocks.listRecords.mockResolvedValue([closeRecord([STRIPE_BEFORE_CLOSE])]);
    expect(await listCardRefundsPaidTwice()).toEqual([
      {
        operationId: "op-1",
        bookingId: "b-1",
        bookingReference: expect.any(String),
        closedAt: CLOSED_AT.toISOString(),
        paidAnotherWayCents: 15_000,
        refundedByCardCents: 15_000,
      },
    ]);
  });

  it("not a refund Stripe made after the close: that is another operation's", async () => {
    mocks.listRecords.mockResolvedValue([
      closeRecord([{ stripeCreatedAt: new Date("2026-06-26T00:00:00.000Z"), createdAt: new Date("2026-06-26T00:00:01.000Z") }]),
    ]);
    expect(await listCardRefundsPaidTwice()).toEqual([]);
  });

  it("MUTATION: a row marked Resolved leaves the list", async () => {
    mocks.listRecords.mockResolvedValue([closeRecord([STRIPE_BEFORE_CLOSE], { reviewContext: resolution(15_000) })]);
    expect(await listCardRefundsPaidTwice()).toEqual([]);
  });

  it("comes back if Stripe refunds the card for it again after it was resolved", async () => {
    mocks.listRecords.mockResolvedValue([closeRecord([STRIPE_BEFORE_CLOSE], { reviewContext: resolution(10_000) })]);
    expect(await listCardRefundsPaidTwice()).toEqual([expect.objectContaining({ refundedByCardCents: 15_000 })]);
  });
});

describe("marking a paid-twice row Resolved", () => {
  const resolve = (note: string | null = "Member paid the extra back by bank, ref 9") =>
    resolveCardRefundPaidTwice({ operationId: "op-1", note, actingMemberId: "treasurer-1" });

  it("finds the close by the operation under any of its three keys", async () => {
    await resolve();
    expect(mocks.findRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "CANCELLED_BOOKING_HAND_BACK",
          status: "COMPLETED",
          occurrenceKey: {
            in: [
              "card-refund-paid-another-way:op-1",
              "card-refund-paid-another-way:op-1:note-after-receipt",
              "card-refund-paid-another-way:op-1:no-xero-note",
            ],
          },
        }),
      }),
    );
  });

  it("MUTATION: one status-guarded write on the close's record - guarded on it having no resolution - with the note and what Stripe had refunded", async () => {
    await expect(resolve()).resolves.toEqual({ operationId: "op-1", bookingId: "b-1", refundedByCardCents: 15_000 });
    expect(mocks.claim).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "close-1",
        status: "COMPLETED",
        reviewContext: { equals: Prisma.DbNull },
      }),
      data: {
        reviewContext: {
          paidTwiceResolved: {
            resolvedAt: "2026-07-01T00:00:00.000Z",
            resolvedByMemberId: "treasurer-1",
            note: "Member paid the extra back by bank, ref 9",
            refundedByCardCents: 15_000,
          },
        },
      },
    });
  });

  it("MUTATION: audits it under payment, on the close's record, with the note - after the write", async () => {
    await resolve();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.card-refund.paid-twice-resolved",
        category: "payment",
        entityType: "ManualRefundTask",
        entityId: "close-1",
        targetId: "b-1",
        actorMemberId: "treasurer-1",
        subjectMemberId: "member-1",
        details: "Member paid the extra back by bank, ref 9",
        metadata: expect.objectContaining({ operationId: "op-1", refundedByCardCents: 15_000, paidAnotherWayCents: 15_000 }),
      }),
      expect.anything(),
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.createAuditLog.mock.invocationCallOrder[0]);
  });

  it("a row that came back is guarded on the resolution it carried, which the new one replaces", async () => {
    mocks.findRecord.mockResolvedValue(closeRecord([STRIPE_BEFORE_CLOSE], { reviewContext: resolution(10_000) }));
    await resolve();
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reviewContext: { equals: resolution(10_000) } }) }),
    );
  });

  describe("refuses, and writes nothing", () => {
    async function expectRefusal(promise: Promise<unknown>, status: number) {
      await expect(promise).rejects.toBeInstanceOf(CardRefundPaidTwiceError);
      await expect(promise).rejects.toMatchObject({ status });
      expect(mocks.createAuditLog).not.toHaveBeenCalled();
    }

    it("no note", async () => {
      await expectRefusal(resolve("   "), 400);
      expect(mocks.findRecord).not.toHaveBeenCalled();
    });

    it("no such close", async () => {
      mocks.findRecord.mockResolvedValue(null);
      await expectRefusal(resolve(), 404);
    });

    it("MUTATION: a close Stripe never paid as well", async () => {
      mocks.findRecord.mockResolvedValue(closeRecord([]));
      await expectRefusal(resolve(), 409);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: one already resolved (a second click that read it after the first wrote)", async () => {
      mocks.findRecord.mockResolvedValue(closeRecord([STRIPE_BEFORE_CLOSE], { reviewContext: resolution(15_000) }));
      await expectRefusal(resolve(), 409);
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it("MUTATION: a lost claim (a second click, or another treasurer, between the read and the write)", async () => {
      mocks.claim.mockResolvedValue({ count: 0 });
      await expectRefusal(resolve(), 409);
    });
  });
});

describe("readPaidTwiceResolution", () => {
  it("reads only a whole resolution", () => {
    expect(readPaidTwiceResolution(resolution(5))).toEqual(resolution(5).paidTwiceResolved);
    expect(readPaidTwiceResolution(null)).toBeNull();
    expect(readPaidTwiceResolution({ paidTwiceResolved: { note: "x" } })).toBeNull();
    expect(readPaidTwiceResolution({ occurrence: { cause: "X" } })).toBeNull();
    expect(readPaidTwiceResolution([1])).toBeNull();
  });
});
