import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #4316 (`INV-ADDPAY-044`): AN ORDINARY EDIT'S AFTER-COMMIT MINT NEVER LEAVES A
  LIVE ASK ON A BOOKING THAT HAS ENDED.

  The edit doors decide to ask the card inside their transaction, under
  `lock(1)`, but `createModificationAdditionalPaymentIntent` creates the Stripe
  intent after the commit. A cancel can land in that gap, in two places:

   - BEFORE the provider call: the minter re-reads the booking and mints
     nothing (CANCELLED or BUMPED), and keeps no debt - nothing is owed.
   - AFTER the provider call but before the new row is written: the cancel's
     claim read a mirror with no such intent on it and could not retire it. The
     minter re-reads the booking after its row write and retires the ask itself,
     through the routine the paid cancel's claim runs
     (`failOutstandingAdditionalAskInClaim`), under the `Payment` row lock.

  The supersede and retirement helpers (`booking-payment-cleanup.ts`) run for
  real here; only their collaborators are doubled. The real-PostgreSQL proof of
  the interleaving is `ended-booking-ask-mint-race.realdb.test.ts`.

  Frozen clock inherited; nothing here reads a date.
*/

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  markFailed: vi.fn(),
  lockPayment: vi.fn(),
  supersedeRead: vi.fn(),
  enqueueCancel: vi.fn(),
  cancelNow: vi.fn(),
  enqueueRecovery: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  enqueueRefundRecovery: vi.fn(),
  processRecovery: vi.fn(),
  bookingRead: vi.fn(),
  paymentRead: vi.fn(),
  paymentUpdate: vi.fn(),
  transactionFindFirst: vi.fn(),
  transaction: vi.fn(),
  followSuperseded: vi.fn(),
  askRowStatus: { value: "PENDING" },
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  findOrCreateCustomer: mocks.findOrCreateCustomer,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
  markPaymentIntentTransactionFailed: mocks.markFailed,
  lockPaymentForRefundedTotal: mocks.lockPayment,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
  PartialRefundError: class PartialRefundError extends Error {},
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/prisma", () => {
  const client = {
    $executeRaw: vi.fn(),
    booking: { findUnique: mocks.bookingRead },
    payment: { findUnique: (args: { select?: { additionalAmountCents?: boolean } }) => args.select?.additionalAmountCents
      ? Promise.resolve({ additionalAmountCents: 0, additionalPaymentStatus: null })
      : mocks.paymentRead(args), update: mocks.paymentUpdate },
    paymentTransaction: {
      findMany: mocks.supersedeRead,
      findFirst: mocks.transactionFindFirst,
      // #3954 round 7: the door re-reads its new intent's row before queueing
      // on it (`isMintedAskStillLive`); here it is still the live ask. #4316:
      // the retirement reads it too, to queue its cancellation durably first.
      findUnique: async () => ({ id: "txn_new", paymentId: "payment_1", amountCents: 8000, status: mocks.askRowStatus.value, withdrawnAt: null }),
    },
    $transaction: mocks.transaction,
  };
  return { prisma: client };
});
// #3403: the superseded asks' invoices follow this mint's intent; its own module is tested on its own.
vi.mock("@/lib/superseded-ask-invoice-carry", () => ({
  followSupersededAskInvoicesSafely: mocks.followSuperseded,
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueuePaymentIntentCancellationRecovery: mocks.enqueueCancel,
  runPaymentRecoveryOperationNow: mocks.cancelNow,
  enqueueAdditionalPaymentIntentRecovery: mocks.enqueueRecovery,
  enqueueBookingModificationRefundRecovery: mocks.enqueueRefundRecovery,
  processPaymentRecoveryOperations: mocks.processRecovery,
}));

import { sizeAdditionalAsk } from "@/lib/additional-payment-ask";
import { prisma } from "@/lib/prisma";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CONTEXT = {
  pendingRefundAmountCents: 0,
  organiserChildRefund: null,
  paymentId: "payment_1",
  // The +$80 guest add of the issue, with no earlier ask to carry.
  additionalAsk: sizeAdditionalAsk({
    priceDiffCents: 8000,
    changeFeeCents: 0,
    payment: { additionalAmountCents: 0, additionalPaymentStatus: null },
  }),
  retiredAdditionalAsks: [],
  hasSucceededPayment: true,
  hasIssuedXeroInvoice: false,
  paymentCustomerId: "cus_1",
  memberEmail: "member@example.test",
  memberName: "Ada Member",
  memberFirstName: "Ada",
  memberId: "member_1",
  bookingModificationId: "mod_1",
  priceLines: null,
};

function mint() {
  return createModificationAdditionalPaymentIntent({
    format: CLUB_FORMAT_TEST,
    bookingId: "booking_1",
    result: CONTEXT,
    door: "guestAdd",
    failureMessage: "boom",
  });
}

/** The booking's status at each re-read, in order: before the mint, then after the row write. */
function bookingStatuses(...statuses: string[]) {
  for (const status of statuses) mocks.bookingRead.mockResolvedValueOnce({ status });
}

let order: string[] = [];

beforeEach(() => {
  order = [];
  for (const mock of Object.values(mocks)) if (typeof mock === "function") mock.mockReset();
  mocks.askRowStatus.value = "PENDING";
  mocks.bookingRead.mockImplementation(async () => {
    order.push("bookingRead");
    return { status: "PAID" };
  });
  mocks.createPaymentIntent.mockImplementation(async () => {
    order.push("createPaymentIntent");
    return { id: "pi_new", client_secret: "pi_new_secret" };
  });
  mocks.upsertPaymentIntentTransaction.mockImplementation(async () => {
    order.push("upsertPaymentIntentTransaction");
  });
  // Nothing else outstanding on the payment: the supersede finds nothing.
  mocks.supersedeRead.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
    order.push("transaction");
    return fn(prisma);
  });
  mocks.lockPayment.mockImplementation(async () => {
    order.push("lockPayment");
  });
  // The mirror the upsert's reconcile derived: this mint's ask, outstanding.
  mocks.paymentRead.mockImplementation(async () => {
    order.push("paymentRead");
    return { id: "payment_1", additionalPaymentIntentId: "pi_new", additionalPaymentStatus: "PENDING" };
  });
  mocks.paymentUpdate.mockImplementation(async () => {
    order.push("paymentUpdate");
  });
  mocks.markFailed.mockImplementation(async () => {
    order.push("markFailed");
  });
  mocks.transactionFindFirst.mockResolvedValue({ id: "txn_new", amountCents: 8000 });
  mocks.enqueueCancel.mockImplementation(async () => {
    order.push("enqueueCancel");
    return { id: "op_new" };
  });
  mocks.cancelNow.mockImplementation(async () => {
    order.push("cancelNow");
    return "succeeded";
  });
  mocks.enqueueRecovery.mockResolvedValue(undefined);
  mocks.followSuperseded.mockImplementation(async () => {
    order.push("followSuperseded");
    return null;
  });
});

describe("a booking that ended BEFORE the mint is asked nothing (#4316)", () => {
  it.each(["CANCELLED", "BUMPED"])("%s: no intent, no row, no recovery, and nothing named as due", async (status) => {
    bookingStatuses(status);

    const result = await mint();

    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.findOrCreateCustomer).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    // Nothing is owed on an ended booking, so no recovery row keeps a debt.
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
      additionalAskRetired: true,
    });
  });

  it("a live booking is minted for as before, and its ask offered", async () => {
    const result = await mint();

    // #3403: the superseded asks' waiting invoices are moved onto this intent
    // after its cancels and before its secret is offered.
    expect(order).toEqual(["bookingRead", "createPaymentIntent", "transaction", "lockPayment", "upsertPaymentIntentTransaction", "followSuperseded", "bookingRead"]);
    expect(mocks.followSuperseded).toHaveBeenCalledWith({ paymentId: "payment_1", carrierPaymentIntentId: "pi_new" });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      additionalPaymentClientSecret: "pi_new_secret",
      additionalPaymentIntentId: "pi_new",
      additionalAskRetired: false,
    });
  });
});

describe("a booking that ended AFTER the provider call is caught after the row write (#4316)", () => {
  it("retires the ask it wrote as the paid cancel's claim would: mirror and row FAILED, a durable cancellation queued, then run now", async () => {
    bookingStatuses("PAID", "CANCELLED");

    const result = await mint();

    expect(order).toEqual([
      "createPaymentIntent",
      "transaction",
      "lockPayment",
      "upsertPaymentIntentTransaction",
      // #3403: the move runs first and refuses an ended booking itself.
      "followSuperseded",
      // The re-read comes AFTER the row write: that write took the Payment row
      // lock the cancel's claim takes before it reads the mirror. Review round
      // 2: the intent's cancellation is queued on its own FIRST, so a failed
      // retirement transaction still leaves it durable.
      "enqueueCancel",
      "transaction",
      "lockPayment",
      "paymentRead",
      "paymentUpdate",
      "markFailed",
      "enqueueCancel",
      "cancelNow",
    ]);
    expect(mocks.lockPayment).toHaveBeenCalledWith(prisma, "payment_1");
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_1" },
      data: { additionalPaymentStatus: "FAILED" },
    });
    expect(mocks.markFailed).toHaveBeenCalledWith({ paymentIntentId: "pi_new", store: prisma });
    expect(mocks.enqueueCancel.mock.calls[0]![0]).toEqual({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentTransactionId: "txn_new",
      paymentIntentId: "pi_new",
      amountCents: 8000,
    });
    expect(mocks.enqueueCancel).toHaveBeenCalledWith({
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentTransactionId: "txn_new",
      paymentIntentId: "pi_new",
      amountCents: 8000,
      store: prisma,
    });
    expect(mocks.cancelNow).toHaveBeenCalledWith("op_new", CLUB_FORMAT_TEST);
    // No secret for a booking that has ended, and no intent id: the Xero leg
    // raises no supplementary invoice and a review charge takes its cancelled
    // path. No recovery row: nothing is owed.
    expect(result).toEqual({
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
      additionalAskRetired: true,
    });
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
  });

  it("leaves an ask the cancel already retired to the cancel, and still offers nothing", async () => {
    bookingStatuses("PAID", "CANCELLED");
    // The cancel took the Payment row after the row write, read this intent on
    // the mirror and failed it itself.
    mocks.askRowStatus.value = "FAILED";
    mocks.paymentRead.mockResolvedValue({
      id: "payment_1",
      additionalPaymentIntentId: "pi_new",
      additionalPaymentStatus: "FAILED",
    });

    const result = await mint();

    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.enqueueCancel).not.toHaveBeenCalled();
    expect(mocks.cancelNow).not.toHaveBeenCalled();
    expect(result.additionalPaymentClientSecret).toBeUndefined();
    expect(result.additionalAskRetired).toBe(true);
  });

  it("a failed retirement is logged and still offers no secret - and its cancellation was already queued durably", async () => {
    bookingStatuses("PAID", "BUMPED");
    mocks.transaction.mockImplementationOnce(async (write: (tx: typeof prisma) => unknown) => write(prisma))
      .mockRejectedValueOnce(new Error("deadlock detected"));

    const result = await mint();

    // Review round 2: queued on its own before the transaction that failed, so
    // the recovery cron cancels the intent at Stripe and marks its row FAILED.
    expect(mocks.enqueueCancel).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueCancel.mock.calls[0]![0]).toMatchObject({ paymentIntentId: "pi_new", paymentTransactionId: "txn_new" });
    expect(mocks.enqueueCancel.mock.calls[0]![0]).not.toHaveProperty("store");

    expect(result).toEqual({
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
      additionalAskRetired: true,
    });
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
  });

  it("a failed re-read after the row write offers the ask as live, as before #4316", async () => {
    mocks.bookingRead.mockResolvedValueOnce({ status: "PAID" }).mockRejectedValueOnce(new Error("connection reset"));

    const result = await mint();

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(result.additionalPaymentClientSecret).toBe("pi_new_secret");
  });
});
