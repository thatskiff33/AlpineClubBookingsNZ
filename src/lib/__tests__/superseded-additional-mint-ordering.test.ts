import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #3340 FIX ROUND — THE NEW INTENT'S OWN LEDGER ROW IS WRITTEN BEFORE THE OLD
  ONE IS RETIRED.

  Cancelling a superseded ADDITIONAL intent reconciles the payment aggregates:
  both terminal branches of the cancel processor call
  `reconcilePaymentAggregates`, which mirrors the LATEST ADDITIONAL transaction
  into `Payment.additionalAmountCents` and `Payment.additionalPaymentIntentId`.
  Run the cancel first and the latest ADDITIONAL row is still the one being
  retired, so the reconcile writes the OLD, smaller ask back over the payment and
  points it at an intent that has just been cancelled. The upsert that follows
  normally corrects that a moment later — but only if the process survives to
  reach it, and a serverless kill between the two leaves a booking whose price
  has risen reading the superseded figure with no live instrument behind it.

  `superseded-additional-intent-cancel.test.ts` is the sibling for what happens
  INSIDE the cancel helper, and it mocks that helper's own collaborators; it
  therefore cannot see this ordering at all. This file mocks the helper itself
  and watches the two calls the MINTER makes, which is the only place the order
  is decided.

  Frozen clock inherited; nothing here reads a date.
*/

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  queueSuperseded: vi.fn(),
  enqueueRecovery: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  enqueueRefundRecovery: vi.fn(),
  processRecovery: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  findOrCreateCustomer: mocks.findOrCreateCustomer,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
  PartialRefundError: class PartialRefundError extends Error {},
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations: mocks.queueSuperseded,
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: mocks.enqueueRecovery,
  enqueueBookingModificationRefundRecovery: mocks.enqueueRefundRecovery,
  processPaymentRecoveryOperations: mocks.processRecovery,
}));

import { sizeAdditionalAsk } from "@/lib/additional-payment-ask";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";

const CONTEXT = {
  pendingRefundAmountCents: 0,
  paymentId: "payment_1",
  // #3371: the minter takes the ask as ONE value carrying what minting it will
  // absorb, so the fixture builds it the way a door does - through the one home
  // - rather than asserting a number the production path can no longer pass.
  additionalAsk: sizeAdditionalAsk({
    priceDiffCents: 7000,
    changeFeeCents: 0,
    payment: { additionalAmountCents: 7000, additionalPaymentStatus: "PENDING" },
  }),
  hasSucceededPayment: true,
  hasIssuedXeroInvoice: false,
  paymentCustomerId: "cus_1",
  memberEmail: "member@example.test",
  memberName: "Ada Member",
  memberId: "member_1",
  bookingModificationId: "mod_1",
};

let order: string[] = [];

beforeEach(() => {
  order = [];
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createPaymentIntent.mockImplementation(async () => {
    order.push("createPaymentIntent");
    return { id: "pi_new", client_secret: "pi_new_secret" };
  });
  mocks.upsertPaymentIntentTransaction.mockImplementation(async () => {
    order.push("upsertPaymentIntentTransaction");
  });
  mocks.queueSuperseded.mockImplementation(async () => {
    order.push("queueSuperseded");
    return [];
  });
  mocks.enqueueRecovery.mockResolvedValue(undefined);
});

describe("createModificationAdditionalPaymentIntent ordering (#3340)", () => {
  it("writes the new intent's ADDITIONAL row BEFORE queueing the supersede", async () => {
    const result = await createModificationAdditionalPaymentIntent({
      bookingId: "booking_1",
      result: CONTEXT,
      reason: "guest_add_price_increase",
      idempotencyKey: "mod_guest_booking_1_mod_1",
      failureMessage: "boom",
    });

    expect(order).toEqual([
      "createPaymentIntent",
      // The row the reconcile inside the cancel will read as "latest".
      "upsertPaymentIntentTransaction",
      "queueSuperseded",
    ]);
    expect(result.additionalPaymentIntentId).toBe("pi_new");
    expect(result.additionalPaymentClientSecret).toBe("pi_new_secret");
  });

  it("writes that row for the NEW intent id and the FULL sized ask", async () => {
    await createModificationAdditionalPaymentIntent({
      bookingId: "booking_1",
      result: CONTEXT,
      reason: "guest_add_price_increase",
      idempotencyKey: "mod_guest_booking_1_mod_1",
      failureMessage: "boom",
    });

    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith({
      paymentId: "payment_1",
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: "pi_new",
      amountCents: 14000,
      // #3371: written in the SAME upsert as the amount, from the same value,
      // because the intents it came from are about to be cancelled and the
      // figure is then recoverable from nothing.
      carriedAskCents: 7000,
      status: PaymentStatus.PENDING,
      reason: "guest_add_price_increase",
      stripeCustomerId: "cus_1",
    });
    // …and the supersede is told which intent NOT to retire, so the row written
    // a moment earlier cannot select itself.
    expect(mocks.queueSuperseded).toHaveBeenCalledWith({
      bookingId: "booking_1",
      paymentId: "payment_1",
      newPaymentIntentId: "pi_new",
    });
  });

  it("still returns the secret when the supersede queue fails after the row exists", async () => {
    mocks.queueSuperseded.mockImplementation(async () => {
      order.push("queueSuperseded");
      throw new Error("the queue is down");
    });

    const result = await createModificationAdditionalPaymentIntent({
      bookingId: "booking_1",
      result: CONTEXT,
      reason: "guest_add_price_increase",
      idempotencyKey: "mod_guest_booking_1_mod_1",
      failureMessage: "boom",
    });

    expect(result.additionalPaymentIntentId).toBe("pi_new");
    // The ledger already points at the live intent, which is the state that
    // matters: the retired one is chased by the durable recovery row.
    expect(order).toEqual([
      "createPaymentIntent",
      "upsertPaymentIntentTransaction",
      "queueSuperseded",
    ]);
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
  });
});
