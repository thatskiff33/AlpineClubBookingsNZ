import { PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";
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

import { queueSupersededAdditionalIntentCancellations } from "@/lib/booking-payment-cleanup";

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

describe("queueSupersededAdditionalIntentCancellations", () => {
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

    const queued = await queueSupersededAdditionalIntentCancellations({
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });

    expect(queued).toEqual([
      { paymentTransactionId: "tx_old", paymentIntentId: "pi_old" },
    ]);
    // Durable first: a crash between the two leaves the cron to finish the job.
    expect(order).toEqual(["enqueue", "run"]);
    expect(mocks.runNow).toHaveBeenCalledWith("operation_1");
  });

  it("looks only at OTHER outstanding Stripe ADDITIONAL intents", async () => {
    mocks.findMany.mockResolvedValue([]);
    await queueSupersededAdditionalIntentCancellations({
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentId: "payment_1",
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.STRIPE,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
          stripePaymentIntentId: { not: "pi_new" },
        }),
      }),
    );
  });

  it("degrades to the queued row when the immediate cancel cannot run", async () => {
    mocks.findMany.mockResolvedValue([STALE_TRANSACTION]);
    mocks.runNow.mockRejectedValue(new Error("Stripe is unreachable"));

    // The mint must still return the new client secret; the member's edit is
    // already saved and the recovery cron owns the retry.
    await expect(
      queueSupersededAdditionalIntentCancellations({
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

    await queueSupersededAdditionalIntentCancellations({
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
    const queued = await queueSupersededAdditionalIntentCancellations({
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });
    expect(queued).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.runNow).not.toHaveBeenCalled();
  });
});
