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
  INSIDE the cancel helper; it calls that helper directly and therefore cannot
  see this ordering at all. This file watches the MINTER, which is the only
  place the order is decided.

  #3341: THE SUPERSEDE HELPER RUNS FOR REAL HERE. It used to be mocked, which
  `INV-OPS-015` forbids in a suite that asserts the ask: the order is now read
  off the helper's own ledger query and cancellation enqueue, over a ledger that
  holds the $70 ask this mint retires.

  Frozen clock inherited; nothing here reads a date.
*/

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  supersedeRead: vi.fn(),
  enqueueCancel: vi.fn(),
  cancelNow: vi.fn(),
  enqueueRecovery: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  enqueueRefundRecovery: vi.fn(),
  processRecovery: vi.fn(),
  sizingRead: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  findOrCreateCustomer: mocks.findOrCreateCustomer,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
  lockPaymentForRefundedTotal: vi.fn(),
  PartialRefundError: class PartialRefundError extends Error {},
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (write: (store: unknown) => Promise<unknown>) => {
      const { prisma } = await import("@/lib/prisma");
      return write(prisma);
    },
    $executeRaw: vi.fn(),
    payment: { findUnique: mocks.sizingRead },
    paymentTransaction: {
      findMany: mocks.supersedeRead,
      // #3954 round 7: the door re-reads its new intent's row before queueing
      // on it (`isMintedAskStillLive`); here it is still the live ask.
      findUnique: async () => ({ status: "PENDING", withdrawnAt: null }),
    },
  },
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueuePaymentIntentCancellationRecovery: mocks.enqueueCancel,
  runPaymentRecoveryOperationNow: mocks.cancelNow,
  enqueueAdditionalPaymentIntentRecovery: mocks.enqueueRecovery,
  enqueueBookingModificationRefundRecovery: mocks.enqueueRefundRecovery,
  processPaymentRecoveryOperations: mocks.processRecovery,
}));

// Invoice movement has its own contract suites; this suite observes the queue boundary.
vi.mock("@/lib/superseded-ask-invoice-carry", () => ({
  followSupersededAskInvoicesSafely: async () => null,
}));

import { resolveClubFormat } from "@/lib/club-format";
import { sizeAdditionalAsk } from "@/lib/additional-payment-ask";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CONTEXT = {
  pendingRefundAmountCents: 0,
  organiserChildRefund: null,
  paymentId: "payment_1",
  // #3371: the minter takes the ask as ONE value carrying what minting it will
  // absorb, so the fixture builds it the way a door does - through the one home
  // - rather than asserting a number the production path can no longer pass.
  additionalAsk: sizeAdditionalAsk({
    priceDiffCents: 7000,
    changeFeeCents: 0,
    payment: { additionalAmountCents: 7000, additionalPaymentStatus: "PENDING" },
  }),
  // #3954: an increase retires nothing by reduction.
  retiredAdditionalAsks: [],
  hasSucceededPayment: true,
  hasIssuedXeroInvoice: false,
  paymentCustomerId: "cus_1",
  memberEmail: "member@example.test",
  memberName: "Ada Member",
  memberFirstName: "Ada Member",
  memberId: "member_1",
  bookingModificationId: "mod_1",
  priceLines: null,
};

let order: string[] = [];

beforeEach(() => {
  order = [];
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.sizingRead.mockResolvedValue({ additionalAmountCents: 7000, additionalPaymentStatus: "PENDING" });
  mocks.createPaymentIntent.mockImplementation(async () => {
    order.push("createPaymentIntent");
    return { id: "pi_new", client_secret: "pi_new_secret" };
  });
  mocks.upsertPaymentIntentTransaction.mockImplementation(async () => {
    order.push("upsertPaymentIntentTransaction");
  });
  // The ledger the real supersede helper reads: the first edit's unpaid $70.
  mocks.supersedeRead.mockImplementation(async () => {
    order.push("supersedeRead");
    return [{ id: "txn_old", stripePaymentIntentId: "pi_old", amountCents: 7000 }];
  });
  mocks.enqueueCancel.mockImplementation(async () => {
    order.push("enqueueCancel");
    return { id: "op_old" };
  });
  mocks.cancelNow.mockResolvedValue("succeeded");
  mocks.enqueueRecovery.mockResolvedValue(undefined);
});

describe("createModificationAdditionalPaymentIntent ordering (#3340)", () => {
  it("writes the new intent's ADDITIONAL row BEFORE queueing the supersede", async () => {
    const result = await createModificationAdditionalPaymentIntent({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking_1",
      result: CONTEXT,
      door: "guestAdd",
      failureMessage: "boom",
    });

    expect(order).toEqual([
      "createPaymentIntent",
      // The row the reconcile inside the cancel will read as "latest".
      "upsertPaymentIntentTransaction",
      "supersedeRead",
      "enqueueCancel",
    ]);
    expect(result.additionalPaymentIntentId).toBe("pi_new");
    expect(result.additionalPaymentClientSecret).toBe("pi_new_secret");
  });

  it("writes that row for the NEW intent id and the FULL sized ask", async () => {
    await createModificationAdditionalPaymentIntent({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking_1",
      result: CONTEXT,
      door: "guestAdd",
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
      // #3954 round 7: the edit's own invoice answer, stamped on its row.
      hadIssuedXeroInvoice: false,
      // Round 8: and the edit itself, which a reduction that retires it names.
      bookingModificationId: CONTEXT.bookingModificationId,
      store: expect.anything(),
    });
    // …and the supersede excludes the NEW intent, so the row written a moment
    // earlier cannot select itself, then retires the old ask it carried.
    expect(mocks.supersedeRead).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentId: "payment_1",
          kind: PaymentTransactionKind.ADDITIONAL,
          stripePaymentIntentId: { not: "pi_new" },
        }),
      }),
    );
    expect(mocks.enqueueCancel).toHaveBeenCalledWith({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentTransactionId: "txn_old",
      paymentIntentId: "pi_old",
      amountCents: 7000,
      store: expect.anything(),
    });
    expect(mocks.cancelNow).toHaveBeenCalledWith("op_old", CLUB_FORMAT_TEST);
  });

  it("withholds B's secret and keeps the retry when A captured since sizing", async () => {
    mocks.sizingRead.mockResolvedValue({ additionalAmountCents: 7000, additionalPaymentStatus: "SUCCEEDED" });
    const result = await createModificationAdditionalPaymentIntent({
      format: CLUB_FORMAT_TEST, bookingId: "booking_1", result: CONTEXT, door: "guestAdd", failureMessage: "boom",
    });
    expect(result.additionalPaymentClientSecret).toBeUndefined();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.enqueueCancel).not.toHaveBeenCalled();
    expect(mocks.enqueueRecovery).toHaveBeenCalled();
  });

  it("withholds the secret and keeps the retry when queueing fails", async () => {
    mocks.supersedeRead.mockRejectedValue(new Error("the queue is down"));
    const result = await createModificationAdditionalPaymentIntent({
      format: CLUB_FORMAT_TEST, bookingId: "booking_1", result: CONTEXT, door: "guestAdd", failureMessage: "boom",
    });
    expect(result.additionalPaymentClientSecret).toBeUndefined();
    expect(mocks.enqueueRecovery).toHaveBeenCalled();
  });
});

describe("a refused increase keeps its debt (#3567 re-review)", () => {
  it("with a stored JPY club: mints nothing, looks up no customer, and writes the durable recovery row", async () => {
    const stored = resolveClubFormat({ currencyCode: "JPY", locale: "en-NZ" }, null);
    const result = await createModificationAdditionalPaymentIntent({
      format: stored,
      bookingId: "booking_1",
      result: CONTEXT,
      door: "guestAdd",
      failureMessage: "boom",
    });

    expect(result.additionalPaymentIntentId).toBeUndefined();
    expect(mocks.findOrCreateCustomer).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    // The debt survives: the recovery runner leaves it unclaimed until the
    // currency is fixed, then mints it under the same keys.
    expect(mocks.enqueueRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_1",
        paymentId: "payment_1",
        amountCents: 14000,
        stripeIdempotencyKey: "mod_guest_booking_1_mod_1",
      }),
    );
  });
});
