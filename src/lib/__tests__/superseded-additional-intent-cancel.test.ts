import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  enqueue: vi.fn(),
  runNow: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { paymentTransaction: { findMany: mocks.findMany } },
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueuePaymentIntentCancellationRecovery: mocks.enqueue,
  runPaymentRecoveryOperationNow: mocks.runNow,
}));

import {
  cancelSupersededAdditionalIntentsNow,
  queueSupersededAdditionalIntentCancellationRows,
} from "@/lib/booking-payment-cleanup";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { matchesWhere, type WhereInput } from "./support/prisma-where";

/*
  #3340 acceptance criterion 3 — A SUPERSEDED PAYMENT INTENT IS NOT LEFT
  CONFIRMABLE.

  Before this the cancellation was only ENQUEUED for the five-minute recovery
  cron. Measured in the live case, the dead intent stayed confirmable for 4
  minutes 5 seconds, and a member's card confirm landed inside that window: $65
  charged against a superseded intent on a page reading $300.

  The durable row is still the guarantee and is still written FIRST. What these
  assertions pin is that the mint does not RETURN before it has also tried to
  kill the old intent, and that a Stripe failure degrades to exactly the
  pre-#3340 arrangement rather than to an exception.

  Frozen clock inherited; nothing here reads a date.
*/

const STALE_TRANSACTION = {
  id: "tx_old",
  stripePaymentIntentId: "pi_old",
  amountCents: 6500,
};

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.enqueue.mockReset();
  mocks.runNow.mockReset();
  mocks.enqueue.mockResolvedValue({ id: "operation_1" });
  mocks.runNow.mockResolvedValue("succeeded");
});

/**
 * The supersede as every minter runs it since #4442: the durable rows (inside
 * the minter's queue transaction there; on the client here), then the
 * immediate cancels after.
 */
async function supersede(options: Parameters<typeof queueSupersededAdditionalIntentCancellationRows>[0] & {
  format: typeof CLUB_FORMAT_TEST;
}) {
  const queued = await queueSupersededAdditionalIntentCancellationRows(options);
  await cancelSupersededAdditionalIntentsNow({ ...options, queued });
  return queued.map(({ paymentTransactionId, paymentIntentId }) => ({ paymentTransactionId, paymentIntentId }));
}

describe("the supersede: queueSupersededAdditionalIntentCancellationRows, then cancelSupersededAdditionalIntentsNow", () => {
  it("enqueues the durable row and then cancels immediately, in that order", async () => {
    mocks.findMany.mockResolvedValue([STALE_TRANSACTION]);
    const order: string[] = [];
    mocks.enqueue.mockImplementation(async () => {
      order.push("enqueue");
      return { id: "operation_1" };
    });
    mocks.runNow.mockImplementation(async () => {
      order.push("run");
      return "succeeded";
    });

    const queued = await supersede({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });

    expect(queued).toEqual([
      { paymentTransactionId: "tx_old", paymentIntentId: "pi_old" },
    ]);
    // Durable first: a crash between the two leaves the cron to finish the job.
    expect(order).toEqual(["enqueue", "run"]);
    expect(mocks.runNow).toHaveBeenCalledWith("operation_1", CLUB_FORMAT_TEST);
  });

  /*
    #4422: the selector is run over a ledger, not matched against its own text,
    so narrowing it back to open-only (the defect) fails here. A DECLINED ask is
    still confirmable at Stripe; it is cancelled until a cancel of it has
    SUCCEEDED. A captured ask, the new intent and a zero row never are.
  */
  it("selects the OTHER open and declined Stripe ADDITIONAL intents, and nothing captured or already cancelled (#4422)", async () => {
    const cancel = (status: PaymentRecoveryOperationStatus) => ({
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      status,
    });
    const row = (
      id: string,
      status: PaymentStatus,
      recoveryOperations: { type: PaymentRecoveryOperationType; status: PaymentRecoveryOperationStatus }[] = [],
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      paymentId: "payment_1",
      kind: PaymentTransactionKind.ADDITIONAL,
      source: PaymentSource.STRIPE,
      status,
      stripePaymentIntentId: `pi_${id}`,
      amountCents: 6500,
      recoveryOperations,
      ...extra,
    });
    const ledger = [
      row("open_pending", PaymentStatus.PENDING),
      row("open_processing", PaymentStatus.PROCESSING),
      row("declined", PaymentStatus.FAILED),
      row("declined_cancel_retrying", PaymentStatus.FAILED, [cancel(PaymentRecoveryOperationStatus.FAILED)]),
      row("declined_cancel_queued", PaymentStatus.FAILED, [cancel(PaymentRecoveryOperationStatus.PENDING)]),
      row("declined_refund_op_only", PaymentStatus.FAILED, [
        { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, status: PaymentRecoveryOperationStatus.SUCCEEDED },
      ]),
      row("already_cancelled", PaymentStatus.FAILED, [cancel(PaymentRecoveryOperationStatus.SUCCEEDED)]),
      row("captured", PaymentStatus.SUCCEEDED),
      row("refunded", PaymentStatus.REFUNDED),
      row("new", PaymentStatus.PENDING, [], { stripePaymentIntentId: "pi_new" }),
      row("zero", PaymentStatus.FAILED, [], { amountCents: 0 }),
      row("primary", PaymentStatus.FAILED, [], { kind: PaymentTransactionKind.PRIMARY }),
      row("internet_banking", PaymentStatus.PENDING, [], { source: PaymentSource.INTERNET_BANKING }),
      row("other_payment", PaymentStatus.FAILED, [], { paymentId: "payment_2" }),
    ];
    mocks.findMany.mockImplementation(async ({ where }: { where: WhereInput }) =>
      ledger.filter((entry) => matchesWhere(entry, where)),
    );
    mocks.enqueue.mockImplementation(async ({ paymentTransactionId }: { paymentTransactionId: string }) => ({
      id: `operation_${paymentTransactionId}`,
    }));

    const queued = await supersede({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });

    expect(queued.map((entry) => entry.paymentTransactionId)).toEqual([
      "open_pending",
      "open_processing",
      "declined",
      "declined_cancel_retrying",
      "declined_cancel_queued",
      "declined_refund_op_only",
    ]);
    // Each one cancelled at Stripe now, through the one durable row (#3340).
    expect(mocks.runNow.mock.calls.map((call) => call[0])).toEqual(
      queued.map((entry) => `operation_${entry.paymentTransactionId}`),
    );
  });

  it("degrades to the queued row when the immediate cancel cannot run", async () => {
    mocks.findMany.mockResolvedValue([STALE_TRANSACTION]);
    mocks.runNow.mockRejectedValue(new Error("Stripe is unreachable"));

    // The mint must still return the new client secret; the member's edit is
    // already saved and the recovery cron owns the retry.
    await expect(
      supersede({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking_1",
        paymentId: "payment_1",
        newPaymentIntentId: "pi_new",
      }),
    ).resolves.toEqual([
      { paymentTransactionId: "tx_old", paymentIntentId: "pi_old" },
    ]);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it("kills every stale intent, not just the first", async () => {
    mocks.findMany.mockResolvedValue([
      STALE_TRANSACTION,
      { id: "tx_older", stripePaymentIntentId: "pi_older", amountCents: 3000 },
    ]);
    mocks.enqueue
      .mockResolvedValueOnce({ id: "operation_1" })
      .mockResolvedValueOnce({ id: "operation_2" });

    await supersede({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });

    expect(mocks.runNow.mock.calls.map((call) => call[0])).toEqual([
      "operation_1",
      "operation_2",
    ]);
  });

  it("skips a transaction with no intent id rather than enqueueing a null cancel", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "tx_no_intent", stripePaymentIntentId: null, amountCents: 6500 },
    ]);
    const queued = await supersede({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });
    expect(queued).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.runNow).not.toHaveBeenCalled();
  });
});
