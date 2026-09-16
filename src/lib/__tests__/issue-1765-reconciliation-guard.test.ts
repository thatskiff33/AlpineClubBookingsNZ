import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

// #1765 — the choke-point guard: markBookingPaymentSucceeded is the single
// function every settlement path (intent-route recovery, confirm-payment,
// Stripe webhook, payment link, saved-method charge, cron) flows through, so
// refund-history re-admission is blocked HERE, not only in the intent route.
// Also locks in that queueSupersededPrimaryIntentCancellations can never
// select a succeeded/refunded transaction for cancellation.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  sendAdminPaymentFailureAlert: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
  lodgeFindFirst: vi.fn(),
  enqueuePaymentIntentCancellationRecovery: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mocks.upsertPaymentIntentTransaction(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mocks.findPaymentTransactionByIntentId(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
}));

vi.mock("@/lib/member-credit", () => ({
  restoreCreditFromBooking: (...args: unknown[]) =>
    mocks.restoreCreditFromBooking(...args),
  deriveBookingAppliedCreditCents: (...args: unknown[]) =>
    mocks.deriveBookingAppliedCreditCents(...args),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mocks.sendAdminPaymentFailureAlert(...args),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: (...args: unknown[]) =>
    mocks.reconcileBedAllocationsForBooking(...args),
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...args: unknown[]) => mocks.recordBookingEvent(...args),
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueuePaymentIntentCancellationRecovery: (...args: unknown[]) =>
    mocks.enqueuePaymentIntentCancellationRecovery(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// #2576 §9. Mocked at the module boundary, like the other collaborators this suite
// already stubs. The real seam reads the booking and the lodge policy through the
// CONFIRMING transaction's client, and this suite drives that transaction with a fake
// that carries only the delegates the money path itself needs — so without this the
// enqueue throws and the settlement fails. Failing closed is the correct production
// behaviour (§8 wants the obligation to commit WITH the transition), so the fixture is
// what changes. Whether an uncovered booking becomes an incident belongs to the hosting
// suites; that this path reaches a seam at all is pinned tree-wide by
// `adult-member-hosting-call-sites.test.ts`.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: vi.fn(async () => null),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));


import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { queueSupersededPrimaryIntentCancellations } from "@/lib/booking-payment-cleanup";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  $queryRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  lodge: {
    findFirst: (...args: unknown[]) => mocks.lodgeFindFirst(...args),
  },
  // #2286: the capacity engines read bed-holding hut-leader assignments
  // (custodian occupancy). None in these cases.
  hutLeaderAssignment: { findMany: vi.fn().mockResolvedValue([]) },
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    findMany: (...args: unknown[]) => mocks.bookingFindMany(...args),
    update: (...args: unknown[]) => mocks.bookingUpdate(...args),
    updateMany: (...args: unknown[]) => mocks.bookingUpdateMany(...args),
  },
  payment: {
    upsert: (...args: unknown[]) => mocks.paymentUpsert(...args),
  },
};

function makePayableBooking(status: BookingStatus = BookingStatus.PAYMENT_PENDING) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status,
    lodgeId: "lodge-1",
    checkIn: parseDateOnly("2026-08-10"),
    checkOut: parseDateOnly("2026-08-12"),
    finalPriceCents: 9000,
    guests: [],
    member: {
      firstName: "Alice",
      lastName: "Member",
      email: "alice@example.com",
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.bookingFindUnique.mockResolvedValue(makePayableBooking());
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);
  mocks.bookingUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.restoreCreditFromBooking.mockResolvedValue(undefined);
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
  mocks.refundPaymentTransactions.mockResolvedValue({});
  mocks.recordBookingEvent.mockResolvedValue(undefined);
});

describe("#1765 markBookingPaymentSucceeded refund-history guard", () => {
  it("throws and leaves the ledger untouched when a REFUNDED intent is re-admitted on a payable booking", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-refunded",
      status: PaymentStatus.REFUNDED,
      amountCents: 19500,
      refundedAmountCents: 19500,
    });

    await expect(
      markBookingPaymentSucceeded({
        bookingId: "booking-1",
        // Same-price replay: without the guard this settles the booking at
        // zero net cash (the amount check passes at 9000 === 9000).
        paymentIntentId: "pi_refunded",
        amountCents: 9000,
        paymentMethodId: "pm_1",
      })
    ).rejects.toThrow(/cannot be re-admitted as settlement/);

    // The refunded transaction row is never clobbered back to SUCCEEDED and
    // the booking is never paid.
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("PARTIALLY_REFUNDED transaction history also refuses settlement", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-partial",
      status: PaymentStatus.PARTIALLY_REFUNDED,
      amountCents: 19500,
      refundedAmountCents: 5000,
    });

    await expect(
      markBookingPaymentSucceeded({
        bookingId: "booking-1",
        paymentIntentId: "pi_partial",
        amountCents: 9000,
        paymentMethodId: "pm_1",
      })
    ).rejects.toThrow(/cannot be re-admitted as settlement/);
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
  });

  it("returns already_paid without clobbering the refund marker when the booking is already PAID", async () => {
    // A redelivered success event after a partial goodwill refund on a PAID
    // booking: benign, but the transaction row must keep its refund status.
    mocks.bookingFindUnique.mockResolvedValue(
      makePayableBooking(BookingStatus.PAID)
    );
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-partial",
      status: PaymentStatus.PARTIALLY_REFUNDED,
      amountCents: 9000,
      refundedAmountCents: 2000,
    });

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_replayed",
      amountCents: 9000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("already_paid");
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
  });

  it("still reconciles crashed-webhook recovery: a PROCESSING transaction settles as before", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-stuck",
      status: PaymentStatus.PROCESSING,
      amountCents: 9000,
      refundedAmountCents: 0,
    });

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_stuck",
      amountCents: 9000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("paid");
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_stuck",
        status: PaymentStatus.SUCCEEDED,
      })
    );
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking-1",
        status: {
          in: [
            BookingStatus.PAYMENT_PENDING,
            BookingStatus.CONFIRMED,
            BookingStatus.PENDING,
            BookingStatus.DRAFT,
          ],
        },
      },
      data: { status: BookingStatus.PAID, draftExpiresAt: null },
    });
  });

  it("a fresh intent with no prior transaction row settles as before", async () => {
    mocks.findPaymentTransactionByIntentId.mockResolvedValue(null);

    const result = await markBookingPaymentSucceeded({
      bookingId: "booking-1",
      paymentIntentId: "pi_fresh",
      amountCents: 9000,
      paymentMethodId: "pm_1",
    });

    expect(result.outcome).toBe("paid");
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalled();
  });
});

describe("#1765 queueSupersededPrimaryIntentCancellations refunded-intent safety", () => {
  it("only ever queries PENDING/PROCESSING transactions, so a succeeded (refunded) intent can never be queued for cancellation", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const stubTx = { paymentTransaction: { findMany } };

    await queueSupersededPrimaryIntentCancellations(
      stubTx as never,
      {
        bookingId: "booking-1",
        paymentId: "payment-1",
        newFinalPriceCents: 9000,
      }
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({
      in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING],
    });
    expect(where.kind).toBe("PRIMARY");
    expect(where.source).toBe(PaymentSource.STRIPE);
    expect(mocks.enqueuePaymentIntentCancellationRecovery).not.toHaveBeenCalled();
  });

  it("queues only the returned (pending) transactions for cancellation", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "txn-stale-pending",
        stripePaymentIntentId: "pi_stale_pending",
        amountCents: 19500,
      },
    ]);
    const stubTx = { paymentTransaction: { findMany } };

    const superseded = await queueSupersededPrimaryIntentCancellations(
      stubTx as never,
      {
        bookingId: "booking-1",
        paymentId: "payment-1",
        newFinalPriceCents: 9000,
      }
    );

    expect(superseded).toEqual([
      {
        paymentTransactionId: "txn-stale-pending",
        paymentIntentId: "pi_stale_pending",
        amountCents: 19500,
      },
    ]);
    expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_stale_pending" })
    );
  });
});
