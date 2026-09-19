/**
 * Withdrawing an unpaid additional-payment request (#3528, `INV-ADDPAY-040`).
 *
 * The service is exercised against a fake Prisma whose `$transaction` runs the
 * callback on the same fake, so every write inside it is visible to the
 * assertions, and a thrown fence is a rolled-back transaction: nothing after
 * the throw runs, and the caller reads the 409.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    booking: { findUnique: vi.fn() },
    manualRefundTask: { findMany: vi.fn() },
    paymentRecoveryOperation: { findFirst: vi.fn(), updateMany: vi.fn() },
    payment: { updateMany: vi.fn() },
    paymentTransaction: { updateMany: vi.fn() },
    xeroSyncOperation: { updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  cancelPaymentIntentIfCancellableWithResult: vi.fn(),
  createAuditLog: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellableWithResult:
    mocks.cancelPaymentIntentIfCancellableWithResult,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  ADDITIONAL_ASK_ALREADY_PAID_MESSAGE,
  ADDITIONAL_ASK_CHANGED_MESSAGE,
  ADDITIONAL_ASK_NOT_REVIEW_RAISED_MESSAGE,
  ADDITIONAL_ASK_WITHDRAWN_XERO_ERROR_CODE,
  withdrawAdditionalPaymentAsk,
} from "@/lib/additional-payment-withdraw";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";

const NOW = new Date("2026-06-20T00:00:00.000Z");
const MODIFICATION_ID = "mod-1";
const INTENT_ID = "pi_ask_1";

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "txn-1",
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "PENDING",
    amountCents: 2275,
    stripePaymentIntentId: INTENT_ID,
    reason: buildEditFinancialReviewChargeReason(MODIFICATION_ID),
    withdrawnAt: null,
    ...overrides,
  };
}

function booking(overrides: Record<string, unknown> = {}) {
  const payment =
    overrides.payment === null
      ? null
      : {
          id: "payment-1",
          additionalAmountCents: 2275,
          additionalPaymentStatus: "PENDING",
          additionalPaymentIntentId: INTENT_ID,
          transactions: [request()],
          ...((overrides.payment as Record<string, unknown>) ?? {}),
        };
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    deletedAt: null,
    organisation: null,
    modifications: [{ id: MODIFICATION_ID }, { id: "mod-other" }],
    ...overrides,
    payment,
  };
}

/**
 * A `reviewContext` the real strict parser accepts, so the source-task lookup is
 * exercised for real: a half-built blob reads as "no anchor" and the audit
 * assertion below would pass with an empty list for the wrong reason.
 */
function reviewContext(bookingModificationId: string) {
  return {
    version: 1,
    occurrence: {
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      cause: "NO_STORED_NIGHT_PRICES",
      surrenderedNightDates: ["2026-08-01"],
      addedNightDates: [],
      storedEvidence: { guestTotalCents: null, nightPrices: [] },
    },
    guestMemberId: "member-1",
    bookingCheckIn: "2026-08-01",
    bookingCheckOut: "2026-08-04",
    bookingModificationId,
  };
}

function withdraw() {
  return withdrawAdditionalPaymentAsk({
    bookingId: "booking-1",
    actorMemberId: "admin-1",
    auditRequest: { id: "req-1", ipAddress: "127.0.0.1", userAgent: "vitest" },
    now: NOW,
  });
}

function stripeSays(status: string, canceled = status === "canceled") {
  mocks.cancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
    canceled,
    paymentIntent: { id: INTENT_ID, status },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.booking.findUnique.mockResolvedValue(booking());
  mocks.prisma.manualRefundTask.findMany.mockResolvedValue([
    { id: "task-1", amountCents: 2275, reviewContext: reviewContext(MODIFICATION_ID) },
    { id: "task-other", amountCents: 500, reviewContext: reviewContext("mod-other") },
  ]);
  mocks.prisma.paymentRecoveryOperation.findFirst.mockResolvedValue(null);
  mocks.prisma.paymentRecoveryOperation.updateMany.mockResolvedValue({ count: 0 });
  mocks.prisma.payment.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.xeroSyncOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.prisma.$executeRaw.mockResolvedValue(1);
  mocks.prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof mocks.prisma) => Promise<unknown>) =>
      callback(mocks.prisma),
  );
  stripeSays("canceled", true);
});

describe("withdrawAdditionalPaymentAsk", () => {
  it("retires every instrument the request minted, in the order that survives a crash", async () => {
    const result = await withdraw();

    expect(result).toEqual({
      ok: true,
      withdrawnAmountCents: 2275,
      paymentIntentId: INTENT_ID,
      intentStatus: "canceled",
      retired: { xeroOperations: 1, pendingRecoveries: 0 },
    });

    // The provider FIRST, outside the transaction, with the club's reason.
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith(
      INTENT_ID,
      { cancellationReason: "abandoned" },
    );
    const cancelOrder =
      mocks.cancelPaymentIntentIfCancellableWithResult.mock.invocationCallOrder[0];
    const txOrder = mocks.prisma.$transaction.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(txOrder);

    // The global money key, inside the transaction.
    expect(mocks.prisma.$executeRaw).toHaveBeenCalledTimes(1);

    // THE FENCE re-asserts every value being retired.
    expect(mocks.prisma.payment.updateMany).toHaveBeenCalledWith({
      where: {
        id: "payment-1",
        additionalAmountCents: 2275,
        additionalPaymentStatus: "PENDING",
        additionalPaymentIntentId: INTENT_ID,
      },
      data: {
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        additionalPaymentIntentId: null,
      },
    });

    // The ledger row: FAILED and stamped, never deleted, never on a captured row.
    expect(mocks.prisma.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "txn-1",
        status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        withdrawnAt: null,
      },
      data: { status: "FAILED", withdrawnAt: NOW },
    });

    // The held Xero document, by the intent it waits on.
    expect(mocks.prisma.xeroSyncOperation.updateMany).toHaveBeenCalledWith({
      where: {
        status: "WAITING_PAYMENT",
        direction: "OUTBOUND",
        requestPayload: { path: ["paymentIntentId"], equals: INTENT_ID },
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        completedAt: NOW,
        lastErrorCode: ADDITIONAL_ASK_WITHDRAWN_XERO_ERROR_CODE,
      }),
    });

    // A pending retry can no longer mint the ask again.
    expect(mocks.prisma.paymentRecoveryOperation.updateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
        status: "PENDING",
      },
      data: expect.objectContaining({ status: "FAILED", nextRetryAt: null }),
    });

    // The record: completed, then withdrawn, naming the task that raised it.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.additionalPayment.withdrawn",
        category: "payment",
        severity: "important",
        outcome: "success",
        entityId: "booking-1",
        actorMemberId: "admin-1",
        subjectMemberId: "member-1",
        metadata: expect.objectContaining({
          withdrawnAmountCents: 2275,
          paymentIntentId: INTENT_ID,
          paymentIntentStatus: "canceled",
          bookingModificationId: MODIFICATION_ID,
          sourceTaskIds: ["task-1"],
        }),
        requestId: "req-1",
      }),
    );
  });

  it("is a no-op at the provider on a retry after a crash, and still converges", async () => {
    // The intent was cancelled last time; the columns were not. The helper
    // reads `canceled` and makes no provider call; the fence still matches.
    stripeSays("canceled", false);
    const result = await withdraw();
    expect(result).toMatchObject({ ok: true, intentStatus: "canceled" });
    expect(mocks.prisma.payment.updateMany).toHaveBeenCalledTimes(1);
  });

  it("FENCE: a payment landing between read and write yields 409 and changes nothing", async () => {
    mocks.prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await withdraw();

    expect(result).toEqual({ ok: false, status: 409, error: ADDITIONAL_ASK_CHANGED_MESSAGE });
    // Nothing after the fence ran, and no record claims a withdrawal.
    expect(mocks.prisma.paymentTransaction.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.xeroSyncOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.prisma.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("FENCE: the ledger row is guarded too - a row captured under us rolls the whole thing back", async () => {
    mocks.prisma.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });

    const result = await withdraw();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.prisma.xeroSyncOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("refuses a request the member has already paid - that is a refund", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [request({ status: "SUCCEEDED" })],
        },
      }),
    );

    const result = await withdraw();

    // `isAdditionalPaymentOwed` is already false for SUCCEEDED, and the
    // message says which door to use either way.
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a captured ledger row even while the summary column still says PENDING", async () => {
    // The webhook that flips the column has not landed; the row already has.
    mocks.prisma.booking.findUnique.mockResolvedValue(
      booking({ payment: { transactions: [request({ status: "SUCCEEDED" })] } }),
    );

    const result = await withdraw();

    expect(result).toEqual({ ok: false, status: 409, error: ADDITIONAL_ASK_ALREADY_PAID_MESSAGE });
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
  });

  it("refuses when Stripe reports the intent succeeded and the webhook has not landed", async () => {
    stripeSays("succeeded", false);

    const result = await withdraw();

    expect(result).toEqual({ ok: false, status: 409, error: ADDITIONAL_ASK_ALREADY_PAID_MESSAGE });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves the ledger untouched and surfaces the error when Stripe will not cancel", async () => {
    mocks.cancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("payment_intent_unexpected_state"),
    );

    const result = await withdraw();

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("leaves a processing intent alone rather than zeroing a booking whose money is in flight", async () => {
    stripeSays("processing", false);

    const result = await withdraw();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toContain("processing");
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does nothing when there is no request to withdraw", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          additionalPaymentIntentId: null,
          transactions: [],
        },
      }),
    );

    const result = await withdraw();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does nothing on a booking whose lifecycle ended the obligation", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(booking({ status: "CANCELLED" }));
    expect(await withdraw()).toMatchObject({ ok: false, status: 409 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("D-3528-2: refuses an ask raised by a price change rather than a review, naming the edit as the door", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          transactions: [request({ reason: "Booking modification additional payment" })],
        },
      }),
    );

    const result = await withdraw();

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: ADDITIONAL_ASK_NOT_REVIEW_RAISED_MESSAGE,
    });
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
  });

  it("D-3528-2: matches the review reason by EXACT equality against the booking's own edits", async () => {
    // A review-shaped reason for an edit that is not this booking's.
    mocks.prisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          transactions: [request({ reason: buildEditFinancialReviewChargeReason("mod-elsewhere") })],
        },
      }),
    );
    expect(await withdraw()).toMatchObject({
      ok: false,
      error: ADDITIONAL_ASK_NOT_REVIEW_RAISED_MESSAGE,
    });
  });

  it("refuses while a background retry is mid-mint rather than racing the worker", async () => {
    mocks.prisma.paymentRecoveryOperation.findFirst.mockResolvedValue({ id: "rec-1" });

    const result = await withdraw();

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
  });

  it("withdraws a request that never got its intent (the mint is still owed to a pending retry)", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalPaymentIntentId: null,
          transactions: [request({ stripePaymentIntentId: null })],
        },
      }),
    );
    mocks.prisma.paymentRecoveryOperation.updateMany.mockResolvedValue({ count: 1 });

    const result = await withdraw();

    expect(result).toMatchObject({
      ok: true,
      paymentIntentId: null,
      intentStatus: null,
      retired: { xeroOperations: 0, pendingRecoveries: 1 },
    });
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
    // No intent means no held Xero document to look for.
    expect(mocks.prisma.xeroSyncOperation.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a deleted booking and an unknown one", async () => {
    mocks.prisma.booking.findUnique.mockResolvedValue(booking({ deletedAt: NOW }));
    expect(await withdraw()).toMatchObject({ ok: false, status: 409 });

    mocks.prisma.booking.findUnique.mockResolvedValue(null);
    expect(await withdraw()).toMatchObject({ ok: false, status: 404 });
  });
});
