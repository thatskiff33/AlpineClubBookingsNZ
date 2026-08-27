import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // A PartialRefundError stand-in that actually carries completedRefundCents
  // so the card retry test can freeze amount=50, completed=40 -> remainder 10.
  class MockPartialRefundError extends Error {
    completedRefundCents: number;
    constructor(completedRefundCents: number) {
      super("partial refund");
      this.name = "PartialRefundError";
      this.completedRefundCents = completedRefundCents;
    }
  }
  return {
  PartialRefundError: MockPartialRefundError,
  bookingFindUnique: vi.fn(),
  // The tx1 single-flight re-read under the advisory lock (#1160). Kept
  // separate from the outer read so a test can make the re-read see a
  // CANCELLED booking (the race loser) while the outer read still saw PAID.
  txBookingFindUnique: vi.fn(),
  txExecuteRaw: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  bookingRequestUpdateMany: vi.fn(),
  promoRedemptionFindUnique: vi.fn(),
  // #3123: the club's day is resolved once, before the claim transaction opens.
  // The delegate is NOT optional on this mock: `getClubTimeZone` is fail-soft on
  // a missing one and degrades silently to the environment, so leaving it off
  // would mean this suite could never see a wrong day at all (A4's trap).
  clubTimeSettingsFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  calculateRefundAmount: vi.fn(),
  calculateAppliedCreditRestore: vi.fn(),
  daysUntilDate: vi.fn(),
  loadCancellationPolicy: vi.fn(),
  sendBookingCancelledEmail: vi.fn(),
  logAudit: vi.fn(),
  createCancellationCredit: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  // #1547: the CANCELLED narrative event, so the credit-restore sentence in the
  // event reason can be asserted. booking-events is fire-and-swallow in prod.
  recordBookingEvent: vi.fn(),
  processWaitlistForDates: vi.fn(),
  isXeroConnected: vi.fn(),
  enqueueXeroAccountCreditNoteOperation: vi.fn(),
  enqueueXeroModificationCreditNoteOperation: vi.fn(),
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  processRefund: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  markPaymentIntentTransactionFailed: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueueBookingCancellationRefundRecovery: vi.fn(),
  enqueuePaymentIntentCancellationRecovery: vi.fn(),
  markBookingCancellationRefundRecoverySucceeded: vi.fn(),
  recordBookingCancellationRefundRecoveryInlineError: vi.fn(),
  txPaymentTransactionFindFirst: vi.fn(),
  // #1491: the fold-materialization reads/writes inside the claim tx.
  txPaymentTransactionFindMany: vi.fn(),
  txPaymentTransactionUpdate: vi.fn(),
  // #1473: the captured-ledger lookup in the not-SUCCEEDED cancel branch.
  paymentTransactionFindFirst: vi.fn(),
  // #1547: the under-lock Xero-linked applied-credit aggregate in the
  // never-captured claim tx (A1).
  txMemberCreditAggregate: vi.fn(),
  findUnconvergedAppliedCreditDeallocation: vi.fn(),
  repairLegacyAppliedCreditNoteAllocationsForBooking: vi.fn(),
  // #1406: spy on the payment-link revoke so the guard test can prove a
  // just-accepted booking's brand-new payment links are NEVER revoked.
  revokePaymentLinksForBooking: vi.fn(),
  // #1547: promo cleanup, so a credit-carrying cancel can prove restore does
  // not disturb the promo lifecycle.
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  // The tx client handed to the paid-path claim callback, captured so tests
  // can prove the #1349 recovery enqueue ran INSIDE the claim transaction.
  lastTx: null as unknown,
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
      updateMany: mocks.bookingUpdateMany,
      // Split-booking cascade (#738) looks for linked provisional children
      // after a successful cancel; none here.
      findMany: vi.fn().mockResolvedValue([]),
    },
    bookingRequest: {
      updateMany: mocks.bookingRequestUpdateMany,
    },
    payment: {
      update: mocks.paymentUpdate,
    },
    paymentTransaction: {
      findFirst: mocks.paymentTransactionFindFirst,
    },
    promoRedemption: {
      findUnique: mocks.promoRedemptionFindUnique,
    },
    promoCode: {
      update: vi.fn(),
    },
    clubTimeSettings: {
      findUnique: mocks.clubTimeSettingsFindUnique,
    },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock("@/lib/cancellation", () => ({
  calculateRefundAmount: mocks.calculateRefundAmount,
  calculateAppliedCreditRestore: mocks.calculateAppliedCreditRestore,
  daysUntilDate: mocks.daysUntilDate,
  loadCancellationPolicy: mocks.loadCancellationPolicy,
}));

vi.mock("@/lib/email", () => ({
  sendBookingCancelledEmail: mocks.sendBookingCancelledEmail,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/member-credit", () => ({
  createCancellationCredit: mocks.createCancellationCredit,
  lockMemberCreditLedger: mocks.lockMemberCreditLedger,
  restoreCreditFromBooking: mocks.restoreCreditFromBooking,
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));

vi.mock("@/lib/waitlist", () => ({
  processWaitlistForDates: mocks.processWaitlistForDates,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroAccountCreditNoteOperation: mocks.enqueueXeroAccountCreditNoteOperation,
  enqueueXeroModificationCreditNoteOperation:
    mocks.enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation: mocks.enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: mocks.processRefund,
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntentIfCancellable,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/payment-transactions", () => ({
  PartialRefundError: mocks.PartialRefundError,
  applyLocalRefundAllocation: mocks.applyLocalRefundAllocation,
  markPaymentIntentTransactionFailed: mocks.markPaymentIntentTransactionFailed,
  refundPaymentTransactions: mocks.refundPaymentTransactions,
  planStripeRefundAllocation: mocks.planStripeRefundAllocation,
}));

vi.mock("@/lib/payment-recovery", async () => {
  // buildBookingCancellationRefundMetadata is a pure (Prisma-free) builder in
  // payment-recovery-keys; use the REAL implementation so this test exercises
  // the genuine inline metadata shape (#1494) rather than a stale copy.
  const keys = await vi.importActual<
    typeof import("@/lib/payment-recovery-keys")
  >("@/lib/payment-recovery-keys");
  return {
    buildBookingCancellationRefundMetadata:
      keys.buildBookingCancellationRefundMetadata,
    enqueueBookingCancellationRefundRecovery:
      mocks.enqueueBookingCancellationRefundRecovery,
    enqueuePaymentIntentCancellationRecovery:
      mocks.enqueuePaymentIntentCancellationRecovery,
    markBookingCancellationRefundRecoverySucceeded:
      mocks.markBookingCancellationRefundRecoverySucceeded,
    recordBookingCancellationRefundRecoveryInlineError:
      mocks.recordBookingCancellationRefundRecoveryInlineError,
  };
});

vi.mock("@/lib/payment-link", () => ({
  revokePaymentLinksForBooking: mocks.revokePaymentLinksForBooking,
}));

vi.mock("@/lib/promo", () => ({
  deletePromoRedemptionAndAdjustCount: mocks.deletePromoRedemptionAndAdjustCount,
}));

vi.mock("@/lib/xero-applied-credit-operation-serialization", () => ({
  findUnconvergedAppliedCreditDeallocation:
    mocks.findUnconvergedAppliedCreditDeallocation,
}));

vi.mock("@/lib/xero-applied-credit-allocation-repair", () => ({
  repairLegacyAppliedCreditNoteAllocationsForBooking:
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking,
}));

import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";
import { cancelBooking } from "@/lib/booking-cancel";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

/** The club's zone, named rather than taken from a helper default (#3123). */
const CLUB_ZONE = "Pacific/Auckland";

describe("cancelBooking credit refunds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #3123: a persisted club zone the environment does not hold, so a wrong
    // day would be visible rather than accidentally right.
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "America/Denver",
    });
    const defaultPaidBooking = {
      id: "booking_1",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_1",
        bookingId: "booking_1",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_1",
      },
    };
    mocks.bookingFindUnique.mockResolvedValue(defaultPaidBooking);
    // By default the tx1 re-read sees the same still-cancellable, still-paid
    // booking. Tests that model a lost claim override this to CANCELLED.
    mocks.txBookingFindUnique.mockResolvedValue(defaultPaidBooking);
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    // The cancel service uses two $transaction shapes: the callback form for
    // the paid single-flight critical section (#1160) and the array form for
    // the pre-payment branches. Support both.
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          // #2619: the hosting participant fence locks the participant Member
          // rows and then re-reads them, plus each source booking's owner and
          // lodge, to detect drift under the lock. Model both reads — the
          // booking side replays whatever this tx's own findUnique served, so
          // the no-drift case matches by construction.
          const fenceBooking = recordingBookingDouble((args) =>
            mocks.txBookingFindUnique(args),
          );
          const mockTx = {
            $executeRaw: mocks.txExecuteRaw,
            member: { findMany: fenceMemberFindMany() },
            // #2623 T5: the seam reads the lodge's hosting mode before the fence, so
            // the double answers with an ACTIVE one and the fence above stays on the
            // path. See `fenceHostingPolicyFindMany`.
            adultMemberHostingPolicy: { findMany: fenceHostingPolicyFindMany() },
            booking: {
              findUnique: fenceBooking.findUnique,
              findMany: fenceBooking.findMany,
              update: mocks.bookingUpdate,
              updateMany: mocks.bookingUpdateMany,
            },
            payment: {
              update: mocks.paymentUpdate,
            },
            paymentTransaction: {
              findFirst: mocks.txPaymentTransactionFindFirst,
              findMany: mocks.txPaymentTransactionFindMany,
              update: mocks.txPaymentTransactionUpdate,
            },
            // #1547: the never-captured claim (A1) reads Xero-linked applied
            // credit under the lock to floor the invoice-clearing amount.
            memberCreditNoteAllocation: {
              aggregate: mocks.txMemberCreditAggregate,
            },
          };
          mocks.lastTx = mockTx;
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
    );
    mocks.paymentUpdate.mockResolvedValue({});
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    // #1473: default = no captured transaction rows on the ledger.
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    // #1547: default = no Xero-linked applied-credit allocations under the lock.
    mocks.txMemberCreditAggregate.mockResolvedValue({ _sum: { amountCents: null } });
    mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValue(null);
    mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mockResolvedValue(0);
    // #1491: fold materialization defaults — no captured rows to attribute to.
    mocks.txPaymentTransactionFindMany.mockResolvedValue([]);
    mocks.txPaymentTransactionUpdate.mockResolvedValue({});
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.daysUntilDate.mockReturnValue(30);
    mocks.loadCancellationPolicy.mockResolvedValue({
      fullRefundDays: 60,
      partialRefundDays: 14,
      partialRefundPercentage: 50,
      creditRefundPercentage: 100,
    });
    mocks.calculateRefundAmount.mockReturnValue({
      refundAmountCents: 5000,
      refundPercentage: 50,
    });
    // Tiered applied-credit restore (#1164). Default 0; the credit-restore test
    // overrides it to a deterministic tiered amount.
    mocks.calculateAppliedCreditRestore.mockReturnValue({
      creditRestoredCents: 0,
      creditRestorePercentage: 50,
    });
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
    mocks.lockMemberCreditLedger.mockResolvedValue(undefined);
    mocks.recordBookingEvent.mockResolvedValue(undefined);
    mocks.createCancellationCredit.mockResolvedValue(undefined);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.enqueueXeroAccountCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_account_credit_1",
      message: "queued",
    });
    mocks.enqueueXeroModificationCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_mod_credit_1",
      message: "queued",
    });
    mocks.enqueueXeroRefundCreditNoteOperation.mockResolvedValue({
      queueOperationId: "op_refund_credit_1",
      message: "queued",
    });
    mocks.enqueueBookingCancellationRefundRecovery.mockResolvedValue({
      id: "recovery_op_1",
    });
    mocks.enqueuePaymentIntentCancellationRecovery.mockResolvedValue({
      id: "recovery_cancel_op_1",
    });
    // The tx1 lookup of the outstanding ADDITIONAL transaction (#1350).
    mocks.txPaymentTransactionFindFirst.mockResolvedValue({
      id: "ptx_additional_1",
      amountCents: 2500,
    });
    // #1349: the claim tx freezes the refund plan before any Stripe call. The
    // default echoes the requested amount as a single fully-refundable slice.
    mocks.planStripeRefundAllocation.mockImplementation(
      async ({ amountCents }: { amountCents: number }) => ({
        slices: [{ paymentTransactionId: "ptx_1", amountCents }],
        plannedAmountCents: amountCents,
        totalRefundableCents: amountCents,
      }),
    );
    mocks.markBookingCancellationRefundRecoverySucceeded.mockResolvedValue({
      count: 1,
    });
    mocks.recordBookingCancellationRefundRecoveryInlineError.mockResolvedValue({
      count: 1,
    });
    mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(null);
    mocks.applyLocalRefundAllocation.mockResolvedValue(undefined);
    mocks.markPaymentIntentTransactionFailed.mockResolvedValue(undefined);
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_1", paymentIntentId: "pi_1", amountCents: 5000 }],
    });
  });

  it("creates the local credit first, then queues the Xero account-credit note", async () => {
    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 5000,
        refundMethod: "credit",
        creditAmountCents: 5000,
      }),
    });

    // Credit ledger writes now run inside the tx1 claim: the writers receive
    // the transaction client (#1160).
    expect(mocks.createCancellationCredit).toHaveBeenCalledWith(
      "member_1",
      5000,
      "booking_1",
      undefined,
      expect.anything()
    );
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment_1",
      amountCents: 5000,
      store: expect.anything(),
    });
    expect(mocks.enqueueXeroAccountCreditNoteOperation).toHaveBeenCalledWith(
      "payment_1",
      5000,
      {
        createdByMemberId: "member_1",
      }
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
    expect(
      mocks.createCancellationCredit.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.enqueueXeroAccountCreditNoteOperation.mock.invocationCallOrder[0]
    );
  });

  it("#3123: the refund tier is the CLUB's day, and it is read BEFORE the claim transaction", async () => {
    /*
      Two facts, and `INV-LOCK-004` is why they have to be asserted together.

      The refund tier is `daysUntilDate(checkIn, todayAtClub)`, so WHICH day is
      supplied decides how much money a member gets back. It used to be
      `new Date()` projected through `APP_TIME_ZONE` — the container's zone. Here
      the persisted zone is `America/Denver` and the frozen instant is
      `2026-07-01T00:00:00.000Z`, so the club's own day is 30 JUNE while the
      container's is 1 July: the two cannot agree by coincidence.

      And the read has to happen where it is safe. The paid-path claim below
      opens `prisma.$transaction` and immediately takes
      `pg_advisory_xact_lock(1)`; a `clubTimeSettings.findUnique` inside that span
      would hold a second pooled connection behind the global cohort key. The
      ordering assertion is what makes "resolved before the transaction opens"
      a measured property of this path rather than a comment.
    */
    await cancelBooking("booking_1", "member_1", "MEMBER", "127.0.0.1", "credit");

    expect(mocks.daysUntilDate).toHaveBeenCalledWith(
      expect.anything(),
      "2026-06-30",
    );
    expect(mocks.daysUntilDate).not.toHaveBeenCalledWith(
      expect.anything(),
      "2026-07-01",
    );

    expect(mocks.clubTimeSettingsFindUnique).toHaveBeenCalledTimes(1);
    expect(
      mocks.clubTimeSettingsFindUnique.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.prismaTransaction.mock.invocationCallOrder[0]);
  });

  it("marks unpaid cancelled bookings as failed and clears the Xero invoice with a credit note", async () => {
    const booking2 = {
      id: "booking_2",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CONFIRMED",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_2",
        bookingId: "booking_2",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "PROCESSING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_2",
        xeroInvoiceId: "inv_2",
        additionalPaymentStatus: null,
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(booking2);
    // #1547: the never-captured claim re-reads under lock(1); mirror the outer
    // read and keep the ledger showing no capture so the payment flattens.
    mocks.txBookingFindUnique.mockResolvedValueOnce(booking2);
    mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);

    const result = await cancelBooking(
      "booking_2",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 0,
      }),
    });

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_2" },
      data: { status: "FAILED" },
    });
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "booking_2",
        refundAmountCents: 10000,
      },
      {
        createdByMemberId: "member_1",
      }
    );
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_2");
    expect(mocks.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_2",
    });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({
      limit: 1,
    });
  });

  it("clears only the reduced outstanding balance on an unpaid invoice already credited by a prior reduction (#1015)", async () => {
    // A prior guest removal issued a full-delta modification credit note
    // against the primary invoice (finalPrice 10000 -> 5000) but never
    // reissued it, so payment.amountCents stays at the original 10000 and
    // refundedAmountCents is still 0 until async Xero reconciliation folds in
    // the credit note. Cancelling in that window must clear the true
    // outstanding (finalPrice 5000), not the stale amountCents (10000), or the
    // total credit notes exceed the invoice.
    const booking3 = {
      id: "booking_3",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CONFIRMED",
      finalPriceCents: 5000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_3",
        bookingId: "booking_3",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "PROCESSING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_3",
        xeroInvoiceId: "inv_3",
        additionalPaymentStatus: null,
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(booking3);
    mocks.txBookingFindUnique.mockResolvedValueOnce(booking3);
    mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);

    const result = await cancelBooking(
      "booking_3",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "booking_3",
        refundAmountCents: 5000,
      },
      {
        createdByMemberId: "member_1",
      }
    );
  });

  // #1473: a (PARTIALLY_)REFUNDED payment captured real money. It reaches the
  // "no successful payment" branch (only SUCCEEDED takes the paid path), but
  // its aggregate status is money truth: the cancel must not flatten it to
  // FAILED, must not try to cancel the captured Stripe intent, and must not
  // queue an invoice-clearing credit note against a paid invoice.
  // #1491 (owner decision, Option 1): a genuinely captured PARTIALLY_REFUNDED
  // payment no longer parks in the preserve branch — it takes the paid path
  // and the member gets the policy tier of the REMAINING captured value.
  it("routes a captured PARTIALLY_REFUNDED payment through the tiered paid path — credit method (#1491)", async () => {
    const bookingPr = {
      id: "booking_pr",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_pr",
        bookingId: "booking_pr",
        amountCents: 10000,
        refundedAmountCents: 3000,
        status: "PARTIALLY_REFUNDED",
        source: "STRIPE",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_pr",
        additionalPaymentIntentId: null,
        additionalPaymentStatus: null,
        xeroInvoiceId: "inv_pr",
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(bookingPr);
    mocks.txBookingFindUnique.mockResolvedValueOnce(bookingPr);
    // Capture evidence on the outer gate (and the under-lock re-check rides
    // the tx client's default truthy findFirst).
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ptx_pr" });
    mocks.calculateRefundAmount.mockReturnValue({
      refundAmountCents: 3500,
      refundPercentage: 50,
    });

    const result = await cancelBooking(
      "booking_pr",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        refundAmountCents: 3500,
        refundPercentage: 50,
      }),
    });
    // The tier was computed off the REMAINING captured value (10000 − 3000).
    expect(mocks.calculateRefundAmount).toHaveBeenCalledWith(
      7000,
      30,
      expect.anything(),
      "credit"
    );
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_pr", amountCents: 3500 })
    );
    expect(mocks.createCancellationCredit).toHaveBeenCalledWith(
      "member_1",
      3500,
      "booking_pr",
      undefined,
      expect.anything()
    );
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking_pr" },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    // No FAILED flattening and no unpaid-branch clearing note.
    for (const [args] of mocks.paymentUpdate.mock.calls) {
      expect(args.data.status).toBeUndefined();
    }
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("routes a captured PARTIALLY_REFUNDED payment through the tiered paid path — card method with frozen recovery plan (#1491)", async () => {
    const bookingPr = {
      id: "booking_prc",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_prc",
        bookingId: "booking_prc",
        amountCents: 10000,
        refundedAmountCents: 3000,
        status: "PARTIALLY_REFUNDED",
        source: "STRIPE",
        changeFeeCents: 500,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_prc",
        additionalPaymentIntentId: null,
        additionalPaymentStatus: null,
        xeroInvoiceId: "inv_prc",
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(bookingPr);
    mocks.txBookingFindUnique.mockResolvedValueOnce(bookingPr);
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ptx_prc" });
    mocks.calculateRefundAmount.mockReturnValue({
      refundAmountCents: 3250,
      refundPercentage: 50,
    });

    const result = await cancelBooking(
      "booking_prc",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    // Change fee stays non-refundable (INV-PAY-018): base =
    // min(10000 − 3000, 10000 + 500) − 500 = 6500.
    expect(mocks.calculateRefundAmount).toHaveBeenCalledWith(
      6500,
      30,
      expect.anything(),
      "card"
    );
    // The card plan is frozen in tx1 as the durable refund decision (#1349) —
    // this is also the artifact the repair pass reads as "policy retained".
    expect(mocks.planStripeRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_prc", amountCents: 3250 })
    );
    expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_prc",
        paymentId: "payment_prc",
        amountCents: 3250,
      })
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("coerces a captured IB PARTIALLY_REFUNDED cancel to the credit method and materializes the folded refund into the ledger (#1491)", async () => {
    // Captured bank-transfer payment whose modification refund was FOLDED into
    // the mirror only (ledger row still shows refunded 0). A "card" cancel
    // must (a) route on the ledger row alone (no STRIPE mirror arm), (b)
    // coerce to the credit method BEFORE the tier is computed, and (c) seed
    // the fold into the ledger so the post-refund aggregate reconcile cannot
    // erase it.
    const bookingIb = {
      id: "booking_ibpr",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_ibpr",
        bookingId: "booking_ibpr",
        amountCents: 10000,
        refundedAmountCents: 3000,
        status: "PARTIALLY_REFUNDED",
        source: "INTERNET_BANKING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: null,
        additionalPaymentIntentId: null,
        additionalPaymentStatus: null,
        xeroInvoiceId: "inv_ibpr",
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(bookingIb);
    mocks.txBookingFindUnique.mockResolvedValueOnce(bookingIb);
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ptx_ibpr" });
    mocks.txPaymentTransactionFindMany.mockResolvedValue([
      {
        id: "ptx_ibpr",
        amountCents: 10000,
        refundedAmountCents: 0,
      },
    ]);
    mocks.calculateRefundAmount.mockReturnValue({
      refundAmountCents: 3500,
      refundPercentage: 50,
    });

    const result = await cancelBooking(
      "booking_ibpr",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    // Coercion proven: the tier was computed for the CREDIT method.
    expect(mocks.calculateRefundAmount).toHaveBeenCalledWith(
      7000,
      30,
      expect.anything(),
      "credit"
    );
    // The folded 3000 was attributed to the captured ledger row in tx1.
    expect(mocks.txPaymentTransactionUpdate).toHaveBeenCalledWith({
      where: { id: "ptx_ibpr" },
      data: { refundedAmountCents: 3000 },
    });
    // Credit path executed; no Stripe planning, no phantom card refund.
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_ibpr", amountCents: 3500 })
    );
    expect(mocks.createCancellationCredit).toHaveBeenCalledWith(
      "member_1",
      3500,
      "booking_ibpr",
      undefined,
      expect.anything()
    );
    expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.enqueueBookingCancellationRefundRecovery).not.toHaveBeenCalled();
  });

  it("keeps a fully REFUNDED payment in the preserve branch — no writes, no clearing note (#1473/#1491)", async () => {
    const bookingFr = {
      id: "booking_fr",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CONFIRMED",
      finalPriceCents: 7000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_fr",
        bookingId: "booking_fr",
        amountCents: 10000,
        refundedAmountCents: 10000,
        status: "REFUNDED",
        source: "STRIPE",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_fr",
        xeroInvoiceId: "inv_fr",
        additionalPaymentStatus: null,
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(bookingFr);
    // #1547: the preserve-branch claim re-reads under lock(1); capture evidence
    // is the STRIPE refund mirror, so the payment is NOT flattened.
    mocks.txBookingFindUnique.mockResolvedValueOnce(bookingFr);
    // Ledger evidence: the capture's refunded PRIMARY row.
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ptx_fr" });

    const result = await cancelBooking(
      "booking_fr",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 0,
        message: expect.stringContaining("refund history is unchanged"),
      }),
    });

    // The booking is cancelled, but the payment row is untouched — no status
    // write of any kind.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "booking_fr",
        status: { in: ["PAYMENT_PENDING", "CONFIRMED", "PAID"] },
      },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    // No clearing note against a settled invoice, and no Stripe cancel of a
    // captured intent.
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.cancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
    expect(mocks.markPaymentIntentTransactionFailed).not.toHaveBeenCalled();
  });

  it("treats a pre-ledger STRIPE refund mirror as captured even when the status was already flattened (#1473)", async () => {
    // Defense-in-depth for legacy mirror-only STRIPE rows (no transaction
    // ledger): a Stripe refund requires a captured charge, so
    // refundedAmountCents > 0 on a STRIPE payment is capture evidence even
    // after the old defect flattened the status. (No live flow re-cancels a
    // CANCELLED booking today; this arm exists so any future path over these
    // rows cannot repeat the damage.)
    const bookingLegacy = {
      id: "booking_legacy",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CONFIRMED",
      finalPriceCents: 7000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_legacy",
        bookingId: "booking_legacy",
        amountCents: 10000,
        refundedAmountCents: 3000,
        status: "FAILED",
        source: "STRIPE",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_legacy",
        xeroInvoiceId: "inv_legacy",
        additionalPaymentStatus: null,
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(bookingLegacy);
    mocks.txBookingFindUnique.mockResolvedValueOnce(bookingLegacy);
    // No ledger rows at all — the STRIPE mirror arm must carry it, both on the
    // outer read and under the claim lock (#1547).
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);

    const result = await cancelBooking(
      "booking_legacy",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mocks.cancelPaymentIntentIfCancellable).not.toHaveBeenCalled();
  });

  it("still flattens and clears a never-captured IB payment whose mirror was folded to PARTIALLY_REFUNDED (#1473)", async () => {
    // The mirror lies: inbound reconciliation folds an invoice-applied
    // modification credit note into refundedAmountCents/PARTIALLY_REFUNDED on
    // an IB payment that never captured a cent (reduced-then-cancelled unpaid
    // booking). With no captured ledger row, the cancel must treat it as
    // never-captured: flatten to FAILED and clear the invoice's true
    // outstanding (finalPrice, per #1015) — NOT strand the invoice open.
    const bookingFold = {
      id: "booking_fold",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CONFIRMED",
      finalPriceCents: 7000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_fold",
        bookingId: "booking_fold",
        amountCents: 10000,
        refundedAmountCents: 3000,
        status: "PARTIALLY_REFUNDED",
        source: "INTERNET_BANKING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: null,
        xeroInvoiceId: "inv_fold",
        additionalPaymentStatus: null,
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(bookingFold);
    mocks.txBookingFindUnique.mockResolvedValueOnce(bookingFold);
    // No captured ledger row on the outer read OR under the claim lock, so the
    // folded PARTIALLY_REFUNDED mirror is treated as never-captured (#1547):
    // eligibility stays false and the payment flattens to FAILED.
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    mocks.txPaymentTransactionFindFirst.mockResolvedValue(null);

    const result = await cancelBooking(
      "booking_fold",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    expect(mocks.paymentTransactionFindFirst).toHaveBeenCalledWith({
      where: {
        paymentId: "payment_fold",
        status: { in: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"] },
      },
      select: { id: true },
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_fold" },
      data: { status: "FAILED" },
    });
    expect(mocks.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      {
        bookingId: "booking_fold",
        refundAmountCents: 7000,
      },
      {
        createdByMemberId: "member_1",
      }
    );
  });

  it("flips only the outstanding additional intent while preserving a captured primary's status (#1473)", async () => {
    // Fully REFUNDED captured primary (ledger row) + an outstanding additional
    // intent from a pending price increase: the additional flips FAILED and is
    // cancelled at Stripe, but the aggregate status write is omitted. (A
    // PARTIALLY_REFUNDED captured payment now takes the paid path instead —
    // #1491.)
    const bookingAddl = {
      id: "booking_addl",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CONFIRMED",
      finalPriceCents: 12000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_addl",
        bookingId: "booking_addl",
        amountCents: 10000,
        refundedAmountCents: 10000,
        status: "REFUNDED",
        source: "STRIPE",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_addl_primary",
        additionalPaymentIntentId: "pi_addl_extra",
        additionalPaymentStatus: "PENDING",
        xeroInvoiceId: "inv_addl",
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(bookingAddl);
    mocks.txBookingFindUnique.mockResolvedValueOnce(bookingAddl);
    mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "ptx_addl" });

    const result = await cancelBooking(
      "booking_addl",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_addl" },
      data: { additionalPaymentStatus: "FAILED" },
    });
    // Only the outstanding additional intent is cancelled at Stripe; the
    // captured primary is left alone.
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledTimes(1);
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_addl_extra");
    expect(mocks.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("waits for Stripe cancellation before finalising an unpaid booking cancellation", async () => {
    let releaseCancellation: (() => void) | null = null;

    const booking3Unpaid = {
      id: "booking_3",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CONFIRMED",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_3",
        bookingId: "booking_3",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "PROCESSING",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_3",
        xeroInvoiceId: null,
        additionalPaymentIntentId: null,
        additionalPaymentStatus: null,
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(booking3Unpaid);
    // #1547: the never-captured claim runs AFTER the (blocking) Stripe intent
    // cancel; it re-reads under lock(1) and flattens the payment to FAILED.
    mocks.txBookingFindUnique.mockResolvedValueOnce(booking3Unpaid);
    mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);
    mocks.cancelPaymentIntentIfCancellable.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCancellation = () => resolve(null);
        })
    );

    const resultPromise = cancelBooking(
      "booking_3",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    // Wait until the cancel path has REACHED the Stripe intent cancel, without
    // resolving it — that is the state this test exists to observe.
    //
    // #3123: this used to flush a FIXED count of microtasks, which is a count of
    // the awaits between the entry point and this line, and every await added
    // anywhere upstream silently invalidates it. Adding the club-day read broke
    // it, and — worse — the failure CASCADED: an unresolved `resultPromise` left
    // behind by this test went on consuming the `mockResolvedValueOnce` queues
    // of the next three. Waiting on the CONDITION instead is the same assertion
    // with nothing to keep in step.
    for (let i = 0; i < 50 && releaseCancellation === null; i += 1) {
      await Promise.resolve();
    }
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(releaseCancellation).not.toBeNull();

    (releaseCancellation as (() => void) | null)?.();
    await resultPromise;

    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_3" },
      data: { status: "FAILED" },
    });
    expect(mocks.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_3",
    });
  });

  it("caps the refundable base at the booking's current value (#1031)", async () => {
    // A prior reduction left the Payment mirror stale: amountCents 30000,
    // refundedAmountCents 0, but the booking is now worth 20000. The refund
    // base must be 20000, not 30000.
    const booking5 = {
      id: "booking_5",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 20000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_5",
        bookingId: "booking_5",
        amountCents: 30000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_5",
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(booking5);
    // The frozen refund plan reads from the tx1 re-read, so it must see the
    // same stale-mirror booking.
    mocks.txBookingFindUnique.mockResolvedValueOnce(booking5);
    mocks.calculateRefundAmount.mockReturnValueOnce({
      refundAmountCents: 20000,
      refundPercentage: 100,
    });

    const result = await cancelBooking(
      "booking_5",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(200);
    expect(mocks.calculateRefundAmount).toHaveBeenCalledWith(
      20000,
      expect.anything(),
      expect.anything(),
      "card"
    );
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_5", amountCents: 20000 })
    );
  });

  it("cancels outstanding additional payment intents and marks them failed on credit refunds", async () => {
    const booking4 = {
      id: "booking_4",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_4",
        bookingId: "booking_4",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_4",
        additionalPaymentIntentId: "pi_4_additional",
        additionalPaymentStatus: "PENDING",
      },
    };
    mocks.bookingFindUnique.mockResolvedValueOnce(booking4);
    mocks.txBookingFindUnique.mockResolvedValueOnce(booking4);

    await cancelBooking(
      "booking_4",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );

    // The Stripe cancel of the additional intent now runs best-effort in
    // Phase 2 via cancelOutstandingPaymentIntents (which marks the tx row
    // failed without a store), after tx1 already flipped the payment-level
    // additionalPaymentStatus to FAILED.
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
      "pi_4_additional"
    );
    expect(mocks.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_4_additional",
    });
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment_4" },
      data: { additionalPaymentStatus: "FAILED" },
    });
    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment_4",
      amountCents: 5000,
      store: expect.anything(),
    });
  });

  it("returns 409 and moves no money when the tx1 re-read finds the booking already cancelled (#1160)", async () => {
    // The outer read still saw PAID (it passes the initial guards), but under
    // the advisory lock the single-flight re-read sees CANCELLED: a concurrent
    // cancel already claimed it. The loser must be a pure no-op.
    mocks.txBookingFindUnique.mockResolvedValueOnce({
      id: "booking_1",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "CANCELLED",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_1",
        bookingId: "booking_1",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 5000,
        stripePaymentIntentId: "pi_1",
      },
    });

    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result.status).toBe(409);
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.createCancellationCredit).not.toHaveBeenCalled();
    expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
    // No status flip, no downstream child/group cleanup.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("keeps the booking CANCELLED and leaves the pre-persisted recovery op to replay when a card refund fails partway (#1160/#1349)", async () => {
    // Frozen refund = 50c; Stripe refunded and recorded 40c before failing.
    mocks.calculateRefundAmount.mockReturnValueOnce({
      refundAmountCents: 50,
      refundPercentage: 100,
    });
    mocks.refundPaymentTransactions.mockRejectedValueOnce(
      new mocks.PartialRefundError(40)
    );

    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    // The claim stands; the failure does not rethrow.
    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 50,
        refundMethod: "card",
      }),
    });
    // #1349: the debt was persisted inside tx1 with the FULL frozen plan; the
    // catch must NOT re-enqueue a remainder-sized operation — the cron replays
    // the identical slices/keys, so the completed 40c is replayed by Stripe
    // (not repeated) and only the outstanding 10c moves money.
    expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledWith({
      bookingId: "booking_1",
      paymentId: "payment_1",
      amountCents: 50,
      allocationPlan: [{ paymentTransactionId: "ptx_1", amountCents: 50 }],
      store: mocks.lastTx,
    });
    // The operation is NOT closed, and the inline failure is recorded on it.
    expect(
      mocks.markBookingCancellationRefundRecoverySucceeded
    ).not.toHaveBeenCalled();
    expect(
      mocks.recordBookingCancellationRefundRecoveryInlineError
    ).toHaveBeenCalledWith({
      bookingId: "booking_1",
      message: expect.any(String),
    });
    // Status flipped exactly once, inside tx1.
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking_1" },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // F1 (#1350): an outstanding ADDITIONAL payment intent gets a durable
  // CANCEL_PAYMENT_INTENT recovery operation INSIDE the claim transaction, so
  // the recovery cron (and the webhook's superseded-intent hook) cancel or
  // refund it even when the Phase-2 best-effort Stripe cancel fails.
  // ---------------------------------------------------------------------------
  describe("durable additional-intent cancellation recovery (#1350)", () => {
    const bookingWithOutstandingAdditional = {
      id: "booking_1",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: {
        id: "payment_1",
        bookingId: "booking_1",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_1",
        additionalPaymentIntentId: "pi_additional_1",
        additionalPaymentStatus: "PENDING",
      },
    };

    it("enqueues the durable cancellation op inside tx1, keyed to the additional transaction", async () => {
      mocks.bookingFindUnique.mockResolvedValueOnce(bookingWithOutstandingAdditional);
      mocks.txBookingFindUnique.mockResolvedValueOnce(bookingWithOutstandingAdditional);

      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      expect(mocks.txPaymentTransactionFindFirst).toHaveBeenCalledWith({
        where: {
          paymentId: "payment_1",
          stripePaymentIntentId: "pi_additional_1",
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, amountCents: true },
      });
      expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith({
        bookingId: "booking_1",
        paymentId: "payment_1",
        paymentTransactionId: "ptx_additional_1",
        paymentIntentId: "pi_additional_1",
        amountCents: 2500,
        store: mocks.lastTx,
      });
      // Ordered before any external Stripe work.
      expect(
        mocks.enqueuePaymentIntentCancellationRecovery.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mocks.cancelPaymentIntentIfCancellable.mock.invocationCallOrder[0]
      );
    });

    it("keeps the durable op even when the Phase-2 best-effort Stripe cancel fails", async () => {
      mocks.bookingFindUnique.mockResolvedValueOnce(bookingWithOutstandingAdditional);
      mocks.txBookingFindUnique.mockResolvedValueOnce(bookingWithOutstandingAdditional);
      mocks.cancelPaymentIntentIfCancellable.mockRejectedValueOnce(
        new Error("stripe unavailable")
      );

      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      // The claim stands and the debt to cancel the intent is durable.
      expect(result.status).toBe(200);
      expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledTimes(1);
    });

    it("does not enqueue when there is no outstanding additional intent", async () => {
      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      expect(mocks.enqueuePaymentIntentCancellationRecovery).not.toHaveBeenCalled();
    });

    it("skips the enqueue (webhook guard remains the backstop) when no transaction row exists for the intent", async () => {
      mocks.bookingFindUnique.mockResolvedValueOnce(bookingWithOutstandingAdditional);
      mocks.txBookingFindUnique.mockResolvedValueOnce(bookingWithOutstandingAdditional);
      mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);

      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      expect(mocks.enqueuePaymentIntentCancellationRecovery).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // F2 (#1349): the refund debt is persisted INSIDE the claim transaction,
  // BEFORE any external call, so a process death between the claim commit and
  // the Stripe refund leaves a pending recovery operation (with the frozen
  // allocation plan) instead of a silently lost refund. The processor-side
  // replay of that operation is covered in payment-recovery.test.ts.
  // ---------------------------------------------------------------------------
  describe("card refund debt persisted inside the claim transaction (#1349)", () => {
    it("enqueues the recovery operation with the frozen plan inside tx1, before the Stripe call", async () => {
      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      // Enqueued exactly once, ON THE TX CLIENT (atomic with the CANCELLED
      // flip), carrying the plan frozen from the under-lock read.
      expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledWith({
        bookingId: "booking_1",
        paymentId: "payment_1",
        amountCents: 5000,
        allocationPlan: [{ paymentTransactionId: "ptx_1", amountCents: 5000 }],
        store: mocks.lastTx,
      });
      // The plan derivation also ran on the tx client.
      expect(mocks.planStripeRefundAllocation).toHaveBeenCalledWith({
        paymentId: "payment_1",
        amountCents: 5000,
        store: mocks.lastTx,
      });
      // Ordering: debt persisted BEFORE the external Stripe call.
      expect(
        mocks.enqueueBookingCancellationRefundRecovery.mock
          .invocationCallOrder[0]
      ).toBeLessThan(
        mocks.refundPaymentTransactions.mock.invocationCallOrder[0]
      );
      // The inline refund executes the SAME frozen slices, so inline and cron
      // replay mint identical Stripe idempotency keys — AND (#1494) send a
      // byte-identical request body: the metadata is the shared
      // { bookingId, reason: "cancellation" } shape with NO refundPercentage,
      // so the cron replay (which cannot reconstruct that per-cancellation
      // value) matches this original and Stripe replays instead of rejecting
      // the reused key with idempotency_error. Asserted as an exact object.
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith({
        paymentId: "payment_1",
        amountCents: 5000,
        allocation: [{ paymentTransactionId: "ptx_1", amountCents: 5000 }],
        metadata: {
          bookingId: "booking_1",
          reason: "cancellation",
        },
        idempotencyKeyPrefix: "booking_cancel_refund_booking_1",
      });
      // Happy path closes the operation.
      expect(
        mocks.markBookingCancellationRefundRecoverySucceeded
      ).toHaveBeenCalledWith({ bookingId: "booking_1" });
      expect(
        mocks.markBookingCancellationRefundRecoverySucceeded.mock
          .invocationCallOrder[0]
      ).toBeGreaterThan(
        mocks.refundPaymentTransactions.mock.invocationCallOrder[0]
      );
    });

    it("simulated process death between claim commit and Stripe call: the debt already exists and nothing closes it (crash-window regression)", async () => {
      // The closest a unit test gets to a hard process kill: the Stripe call
      // never runs (rejects immediately). The invariant under test is that the
      // recovery operation was ALREADY persisted in tx1 — so a real crash at
      // this point leaves a PENDING op the cron replays — and that no code
      // path marks it SUCCEEDED or double-enqueues afterwards.
      mocks.refundPaymentTransactions.mockRejectedValueOnce(
        new Error("process died before the Stripe call")
      );

      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      // The cancel claim stands (booking CANCELLED)...
      expect(result.status).toBe(200);
      expect(mocks.bookingUpdate).toHaveBeenCalledWith({
        where: { id: "booking_1" },
        data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
      });
      // ...and the debt was persisted in-tx BEFORE the refund attempt, with
      // the plan the cron will replay under the same
      // booking_cancel_refund_<bookingId> Stripe key prefix.
      expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking_1",
          amountCents: 5000,
          allocationPlan: [{ paymentTransactionId: "ptx_1", amountCents: 5000 }],
          store: mocks.lastTx,
        })
      );
      expect(
        mocks.markBookingCancellationRefundRecoverySucceeded
      ).not.toHaveBeenCalled();
    });

    it("does not enqueue a recovery operation for credit refunds (ledger writes are already in-tx)", async () => {
      const credit = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "credit"
      );
      expect(credit.status).toBe(200);
      expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
      expect(mocks.enqueueBookingCancellationRefundRecovery).not.toHaveBeenCalled();
    });

    it("does not enqueue a recovery operation for a zero-refund cancel (nothing is due)", async () => {
      mocks.calculateRefundAmount.mockReturnValueOnce({
        refundAmountCents: 0,
        refundPercentage: 0,
      });

      const zero = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );
      expect(zero.status).toBe(200);
      expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
      expect(mocks.enqueueBookingCancellationRefundRecovery).not.toHaveBeenCalled();
    });

    it("refunds only what the ledger shows refundable when the frozen plan falls short of the policy-due amount (mirror drift)", async () => {
      // The Payment mirror says 5000c is due but the transaction ledger can
      // only cover 3000c. The plan freezes 3000c; the inline refund executes
      // exactly that; the shortfall is logged, never thrown.
      mocks.planStripeRefundAllocation.mockResolvedValueOnce({
        slices: [{ paymentTransactionId: "ptx_1", amountCents: 3000 }],
        plannedAmountCents: 3000,
        totalRefundableCents: 3000,
      });

      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      expect(mocks.enqueueBookingCancellationRefundRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 3000,
          allocationPlan: [{ paymentTransactionId: "ptx_1", amountCents: 3000 }],
        })
      );
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 3000,
          allocation: [{ paymentTransactionId: "ptx_1", amountCents: 3000 }],
        })
      );
    });

    it("enqueues nothing when the single-flight claim is lost (409 loser moves no money and records no debt)", async () => {
      mocks.txBookingFindUnique.mockResolvedValueOnce({
        id: "booking_1",
        memberId: "member_1",
        lodgeId: "lodge_1",
        status: "CANCELLED",
        finalPriceCents: 10000,
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
        payment: {
          id: "payment_1",
          bookingId: "booking_1",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
          changeFeeCents: 0,
          creditAppliedCents: 0,
          stripePaymentIntentId: "pi_1",
        },
      });

      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(409);
      expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
      expect(mocks.enqueueBookingCancellationRefundRecovery).not.toHaveBeenCalled();
    });
  });

  it("does not restore credit twice when a retry loses the single-flight claim (#1160)", async () => {
    const bookingWithCredit = {
      id: "booking_credit",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: {
        id: "payment_credit",
        bookingId: "booking_credit",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 3000,
        stripePaymentIntentId: "pi_credit",
      },
    };
    // Both attempts pass the outer guard on a stale PAID read.
    mocks.bookingFindUnique.mockResolvedValue(bookingWithCredit);
    // First attempt claims (re-read PAID); the retry's re-read sees CANCELLED.
    //
    // THREE stubs for two attempts, and the middle one is #2576's: the claim
    // transaction now also reconciles the hosting review, which re-reads the booking
    // through the same `tx`. A two-value sequence handed that read the CANCELLED row
    // during the FIRST attempt, so the retry fell through to the default and
    // returned 200 — the single-flight guard looked broken when only the double's
    // call ordering had moved. The tail value covers the retry and anything after
    // it, so this no longer counts reads.
    mocks.txBookingFindUnique
      .mockResolvedValueOnce(bookingWithCredit)
      .mockResolvedValueOnce(bookingWithCredit)
      .mockResolvedValue({ ...bookingWithCredit, status: "CANCELLED" });
    // The 3000 applied credit is tiered to 1500 (#1164); restoreCreditFromBooking
    // receives that tiered amount as its 4th (override) arg.
    mocks.calculateAppliedCreditRestore.mockReturnValue({
      creditRestoredCents: 1500,
      creditRestorePercentage: 50,
    });
    mocks.restoreCreditFromBooking.mockResolvedValue(1500);

    const first = await cancelBooking(
      "booking_credit",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );
    const second = await cancelBooking(
      "booking_credit",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
    // The restore now passes the tiered override (#1164) as the 4th arg.
    expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
      "member_1",
      "booking_credit",
      expect.anything(),
      1500
    );
    // The tiered restored amount is threaded to the cancellation email (7th arg)
    // so the member sees the policy-adjusted restore, not the full applied sum.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "booking_credit", recipientMemberId: "member_1" },
      "member@example.com",
      "Alice",
      expect.anything(),
      expect.anything(),
      5000,
      "card",
      1500,
      // The booking's lodge. This read `undefined` while the fixture carried no
      // lodgeId — which Booking.lodgeId being NOT NULL means never happens.
      "lodge_1"
    );
  });

  it("cancels a paid booking with a 0% refund policy inside the single-flight claim (#1160)", async () => {
    // The zero-refund branch's status flip now happens in tx1; no money
    // movement remains in Phase 2.
    mocks.calculateRefundAmount.mockReturnValueOnce({
      refundAmountCents: 0,
      refundPercentage: 0,
    });

    const result = await cancelBooking(
      "booking_1",
      "member_1",
      "MEMBER",
      "127.0.0.1",
      "card"
    );

    expect(result).toEqual({
      status: 200,
      data: expect.objectContaining({
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
      }),
    });
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking_1" },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Authorization widening + refund parity (issue #1313, owner-approved option
  // A2). A Booking Officer (bookings:edit) may cancel a booking they do not own
  // with the SAME authority as a Full Admin. `hasBookingsEditAccess` widens ONLY
  // the authorization gate; the refund plan keys off booking state + policy
  // tier, never the actor role, so an officer cancel and a Full-Admin cancel are
  // byte-identical in money, Stripe path, email, and audit (only the actor id
  // differs). These inherit the outer beforeEach (a PAID booking owned by
  // "member_1" with a fixed 50% / 5000c card refund plan).
  // -------------------------------------------------------------------------
  describe("authorization widening + refund parity (issue #1313 option A2)", () => {
    it("lets a non-owner Booking Officer (bookings:edit) cancel and refund exactly as the owner does", async () => {
      const result = await cancelBooking(
        "booking_1",
        "officer-1", // NOT the owner (member_1)
        "USER", // an officer keeps their honest legacy authorization role
        "127.0.0.1",
        "card",
        { hasBookingsEditAccess: true }
      );

      expect(result).toMatchObject({
        status: 200,
        data: expect.objectContaining({
          success: true,
          refundAmountCents: 5000,
          refundMethod: "card",
        }),
      });
      // Refund lands on the OWNER's original payment (payment_1), actor-independent.
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "payment_1", amountCents: 5000 })
      );
    });

    it("forbids a non-owner actor without bookings:edit (a plain member AND a read-only admin both resolve to role USER + flag false)", async () => {
      const result = await cancelBooking(
        "booking_1",
        "intruder-1",
        "USER",
        "127.0.0.1",
        "card"
        // No hasBookingsEditAccess: the member-facing route passes `false` for a
        // plain member and for a read-only admin (bookings:view, not :edit).
      );

      expect(result).toEqual({ status: 403, error: "Forbidden" });
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
      expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
      expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    });

    it("leaves the booking owner's cancel path unchanged", async () => {
      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "USER",
        "127.0.0.1",
        "card"
      );
      expect(result.status).toBe(200);
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "payment_1", amountCents: 5000 })
      );
    });

    it("leaves the Full-Admin (role ADMIN) cancel path unchanged", async () => {
      const result = await cancelBooking(
        "booking_1",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "card"
      );
      expect(result.status).toBe(200);
    });

    it("produces byte-identical refund, cancellation email, and audit for an officer cancel vs a Full-Admin cancel (only the actor id differs)", async () => {
      const officer = await cancelBooking(
        "booking_1",
        "officer-1",
        "USER",
        "127.0.0.1",
        "card",
        { hasBookingsEditAccess: true }
      );
      const admin = await cancelBooking(
        "booking_1",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "card"
      );

      // Same money outcome (the whole success payload matches).
      expect(officer.status).toBe(200);
      expect(admin.status).toBe(200);
      if (officer.status !== 200 || admin.status !== 200) {
        throw new Error("expected both cancels to succeed");
      }
      expect(officer.data).toEqual(admin.data);
      expect(officer.data.refundAmountCents).toBe(5000);

      // Same Stripe refund: same amount, same destination payment (payment_1).
      const refundCalls = mocks.refundPaymentTransactions.mock.calls;
      expect(refundCalls).toHaveLength(2);
      expect(refundCalls[0][0]).toMatchObject({
        paymentId: "payment_1",
        amountCents: 5000,
      });
      expect(refundCalls[1][0]).toMatchObject({
        paymentId: "payment_1",
        amountCents: 5000,
      });

      // Same cancellation email to the OWNER — identical args for both actors.
      const emailCalls = mocks.sendBookingCancelledEmail.mock.calls;
      expect(emailCalls).toHaveLength(2);
      expect(emailCalls[0]).toEqual(emailCalls[1]);
      expect(emailCalls[0][1]).toBe("member@example.com");
      expect(emailCalls[0][5]).toBe(5000);

      // Same audit — identical details + settlement metadata + subjectMemberId
      // (the booking owner); ONLY the actor `memberId` differs.
      const auditCalls = mocks.logAudit.mock.calls
        .map((call) => call[0])
        .filter((entry) => entry?.action === "booking.cancel");
      expect(auditCalls).toHaveLength(2);
      const [officerAudit, adminAudit] = auditCalls;
      expect(officerAudit.memberId).toBe("officer-1");
      expect(adminAudit.memberId).toBe("admin-1");
      expect(officerAudit.subjectMemberId).toBe("member_1");
      expect(adminAudit.subjectMemberId).toBe("member_1");
      expect(officerAudit.details).toEqual(adminAudit.details);
      expect(officerAudit.metadata).toEqual(adminAudit.metadata);
    });
  });

  // ── #1705: per-cancel member-email choice (#1696 semantics) ─────────────
  describe("per-cancel member-email choice (issue #1705)", () => {
    function cancelAuditEntry() {
      return mocks.logAudit.mock.calls
        .map((call) => call[0])
        .find((entry) => entry?.action === "booking.cancel");
    }

    it("suppresses the cancellation email, audits the choice, and still refunds when a Full Admin passes notifyMember: false", async () => {
      const result = await cancelBooking(
        "booking_1",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "card",
        { notifyMember: false }
      );

      expect(result.status).toBe(200);
      // The money outcome is independent of the email choice.
      expect(mocks.refundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "payment_1", amountCents: 5000 })
      );
      expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
      const audit = cancelAuditEntry();
      expect(audit).toBeDefined();
      expect(audit.metadata.notifyMember).toBe(false);
    });

    it("emails the member by default when an admin omits the flag (absent = notify, nothing extra recorded)", async () => {
      const result = await cancelBooking(
        "booking_1",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledTimes(1);
      expect(cancelAuditEntry()!.metadata).not.toHaveProperty("notifyMember");
    });

    it("honours the choice for a Booking Officer (bookings:edit) exactly as for a Full Admin", async () => {
      const result = await cancelBooking(
        "booking_1",
        "officer-1",
        "USER", // the officer keeps their honest legacy role (#1313 A2)
        "127.0.0.1",
        "card",
        { hasBookingsEditAccess: true, notifyMember: false }
      );

      expect(result.status).toBe(200);
      expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
      expect(cancelAuditEntry()!.metadata.notifyMember).toBe(false);
    });

    it("forces notify for the booking owner — a member can never suppress their own confirmation (defence in depth behind the route 403)", async () => {
      const result = await cancelBooking(
        "booking_1",
        "member_1",
        "USER",
        "127.0.0.1",
        "card",
        { notifyMember: false }
      );

      expect(result.status).toBe(200);
      expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledTimes(1);
      expect(cancelAuditEntry()!.metadata).not.toHaveProperty("notifyMember");
    });

    it("suppresses the email on the account-credit settlement branch too", async () => {
      const result = await cancelBooking(
        "booking_1",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "credit",
        { notifyMember: false }
      );

      expect(result.status).toBe(200);
      // The credit still lands; only the member-facing email is skipped.
      expect(mocks.createCancellationCredit).toHaveBeenCalled();
      expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
      expect(cancelAuditEntry()!.metadata.notifyMember).toBe(false);
    });

    it("suppresses the email on a PENDING (no-payment) admin cancel", async () => {
      const today = getTodayDateOnly(CLUB_ZONE);
      const pendingBooking = {
        id: "booking_pending",
        memberId: "member_1",
        lodgeId: "lodge_1",
        status: "PENDING",
        finalPriceCents: 10000,
        checkIn: addDaysDateOnly(today, 30),
        checkOut: addDaysDateOnly(today, 32),
        member: {
          id: "member_1",
          email: "member@example.com",
          firstName: "Alice",
        },
        payment: null,
      };
      mocks.bookingFindUnique.mockResolvedValue(pendingBooking);
      mocks.txBookingFindUnique.mockResolvedValue(pendingBooking);

      const result = await cancelBooking(
        "booking_pending",
        "admin-1",
        "ADMIN",
        "127.0.0.1",
        "card",
        { notifyMember: false }
      );

      expect(result.status).toBe(200);
      expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
      expect(cancelAuditEntry()!.metadata.notifyMember).toBe(false);
    });
  });

  // ── #1547: credit restore on never-captured / PENDING / no-payment cancels ──
  describe("#1547 credit lifecycle", () => {
    function neverCapturedBooking(
      overrides: Record<string, unknown> = {},
      paymentOverrides: Record<string, unknown> = {}
    ) {
      return {
        id: "bk_nc",
        memberId: "member_1",
        lodgeId: "lodge_1",
        status: "PAYMENT_PENDING",
        finalPriceCents: 8000,
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        member: {
          id: "member_1",
          email: "member@example.com",
          firstName: "Alice",
        },
        payment: {
          id: "payment_nc",
          bookingId: "bk_nc",
          amountCents: 8000,
          refundedAmountCents: 0,
          status: "PROCESSING",
          source: "STRIPE",
          changeFeeCents: 0,
          creditAppliedCents: 2000,
          stripePaymentIntentId: "pi_nc",
          xeroInvoiceId: null,
          additionalPaymentStatus: null,
          ...paymentOverrides,
        },
        ...overrides,
      };
    }

    function expectSuccess(result: Awaited<ReturnType<typeof cancelBooking>>) {
      if (result.status !== 200) {
        throw new Error(`expected 200, got ${result.status}`);
      }
      return result.data;
    }

    it("restores applied credit at 100% (no override) inside the claim on the owner's never-captured PAYMENT_PENDING scenario", async () => {
      const booking = neverCapturedBooking();
      mocks.bookingFindUnique.mockResolvedValueOnce(booking);
      mocks.txBookingFindUnique.mockResolvedValueOnce(booking);
      mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);
      mocks.restoreCreditFromBooking.mockResolvedValue(2000);

      const result = await cancelBooking(
        "bk_nc",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      const data = expectSuccess(result);
      // Restore ran exactly once, inside the claim tx (3 args — NO override).
      expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
      expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
        "member_1",
        "bk_nc",
        mocks.lastTx
      );
      expect(mocks.restoreCreditFromBooking.mock.calls[0]).toHaveLength(3);
      // Booking flipped + payment flattened inside the claim.
      expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "bk_nc",
          status: { in: ["PAYMENT_PENDING", "CONFIRMED", "PAID"] },
        },
        data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
      });
      expect(mocks.paymentUpdate).toHaveBeenCalledWith({
        where: { id: "payment_nc" },
        data: { status: "FAILED" },
      });
      // Response, audit metadata, event reason, and email all carry the amount.
      expect(data.creditRestoredCents).toBe(2000);
      const auditCall = mocks.logAudit.mock.calls.find(
        (call) => call[0]?.action === "booking.cancel"
      );
      expect(auditCall?.[0].metadata.creditRestoredCents).toBe(2000);
      expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CANCELLED",
          reason: expect.stringContaining(
            "NZ$20.00 of applied account credit was returned."
          ),
        })
      );
      const emailCall = mocks.sendBookingCancelledEmail.mock.calls[0];
      expect(emailCall[6]).toBe("card");
      expect(emailCall[7]).toBe(2000);
    });

    it("returns 409 and restores nothing when the under-lock re-read finds the booking already CANCELLED", async () => {
      mocks.bookingFindUnique.mockResolvedValueOnce(neverCapturedBooking());
      mocks.txBookingFindUnique.mockResolvedValueOnce({
        ...neverCapturedBooking(),
        status: "CANCELLED",
      });
      mocks.restoreCreditFromBooking.mockResolvedValue(2000);

      const result = await cancelBooking(
        "bk_nc",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(409);
      expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
      expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    });

    it("returns 409 and does NOT flatten the payment when a capture won the race under the lock", async () => {
      // Outer read: never-captured -> no-refund branch. Under lock: the capture
      // landed (SUCCEEDED), so paymentEligibleForPaidCancelPath is true and the
      // claim refuses; the retry routes into the paid path (never flattened).
      mocks.bookingFindUnique.mockResolvedValueOnce(neverCapturedBooking());
      mocks.txBookingFindUnique.mockResolvedValueOnce(
        neverCapturedBooking({}, { status: "SUCCEEDED" })
      );
      mocks.restoreCreditFromBooking.mockResolvedValue(2000);

      const result = await cancelBooking(
        "bk_nc",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(409);
      expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
      expect(mocks.paymentUpdate).not.toHaveBeenCalled();
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    });

    const pendingBooking = () => ({
      id: "bk_pending",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PENDING",
      finalPriceCents: 5000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      member: {
        id: "member_1",
        email: "member@example.com",
        firstName: "Alice",
      },
      payment: null,
    });

    it("restores applied credit once inside the claim on a PENDING cancel (winner)", async () => {
      const pending = pendingBooking();
      mocks.bookingFindUnique.mockResolvedValueOnce(pending);
      mocks.txBookingFindUnique.mockResolvedValueOnce(pending);
      mocks.restoreCreditFromBooking.mockResolvedValue(0);

      const result = await cancelBooking(
        "bk_pending",
        "member_1",
        "MEMBER",
        "127.0.0.1"
      );

      expect(result.status).toBe(200);
      expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
      expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
        "member_1",
        "bk_pending",
        mocks.lastTx
      );
    });

    it("409s on a PENDING cancel with NO side effects when a capture wins the lock (loser)", async () => {
      // A capture paid the PENDING booking (markBookingPaymentSucceeded) before
      // the lock -> under-lock status PAID -> 409, no clobber.
      mocks.bookingFindUnique.mockResolvedValueOnce(pendingBooking());
      mocks.txBookingFindUnique.mockResolvedValueOnce({
        ...pendingBooking(),
        status: "PAID",
      });

      const result = await cancelBooking(
        "bk_pending",
        "member_1",
        "MEMBER",
        "127.0.0.1"
      );

      expect(result.status).toBe(409);
      expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
      expect(mocks.revokePaymentLinksForBooking).not.toHaveBeenCalled();
    });

    it("still restores credit (100%) but does NOT flatten a fully-REFUNDED captured payment, and enqueues no clearing note", async () => {
      const booking = neverCapturedBooking(
        { finalPriceCents: 7000 },
        {
          amountCents: 10000,
          refundedAmountCents: 10000,
          status: "REFUNDED",
          source: "STRIPE",
          xeroInvoiceId: "inv_fr2",
        }
      );
      mocks.bookingFindUnique.mockResolvedValueOnce(booking);
      mocks.txBookingFindUnique.mockResolvedValueOnce(booking);
      // Capture evidence is the STRIPE refund mirror; leave the ledger empty.
      mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);
      mocks.restoreCreditFromBooking.mockResolvedValue(2000);

      const result = await cancelBooking(
        "bk_nc",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      // Restore still ran at 100% (no override), but the captured payment's
      // status is preserved and no invoice-clearing note is queued.
      expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
      expect(mocks.restoreCreditFromBooking.mock.calls[0]).toHaveLength(3);
      expect(mocks.paymentUpdate).not.toHaveBeenCalled();
      expect(
        mocks.enqueueXeroModificationCreditNoteOperation
      ).not.toHaveBeenCalled();
    });

    it("bills the FULL invoice price on the clearing note (never reduced by creditAppliedCents), less only Xero-linked applied allocations", async () => {
      // Case A: no Xero-linked applied rows -> clearing = finalPrice + changeFee,
      // NOT reduced by the applied credit mirror.
      const bookingA = neverCapturedBooking(
        { id: "bk_ib", finalPriceCents: 8000 },
        {
          id: "payment_ib",
          bookingId: "bk_ib",
          source: "INTERNET_BANKING",
          status: "PROCESSING",
          changeFeeCents: 500,
          creditAppliedCents: 2000,
          stripePaymentIntentId: null,
          xeroInvoiceId: "inv_ib",
        }
      );
      mocks.bookingFindUnique.mockResolvedValueOnce(bookingA);
      mocks.txBookingFindUnique.mockResolvedValueOnce(bookingA);
      mocks.txPaymentTransactionFindFirst.mockResolvedValue(null);
      mocks.txMemberCreditAggregate.mockResolvedValueOnce({
        _sum: { amountCents: null },
      });

      const resultA = await cancelBooking(
        "bk_ib",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );
      expect(resultA.status).toBe(200);
      expect(
        mocks.enqueueXeroModificationCreditNoteOperation
      ).toHaveBeenCalledWith(
        { bookingId: "bk_ib", refundAmountCents: 8500 },
        { createdByMemberId: "member_1" }
      );

      mocks.enqueueXeroModificationCreditNoteOperation.mockClear();

      // Case B: a Xero-linked applied allocation of 1500 already reduced the
      // invoice in Xero -> clearing = 8000 + 500 - 1500 = 7000 (floored at 0).
      const bookingB = neverCapturedBooking(
        { id: "bk_ib2", finalPriceCents: 8000 },
        {
          id: "payment_ib2",
          bookingId: "bk_ib2",
          source: "INTERNET_BANKING",
          status: "PROCESSING",
          changeFeeCents: 500,
          creditAppliedCents: 2000,
          stripePaymentIntentId: null,
          xeroInvoiceId: "inv_ib2",
        }
      );
      mocks.bookingFindUnique.mockResolvedValueOnce(bookingB);
      mocks.txBookingFindUnique.mockResolvedValueOnce(bookingB);
      mocks.txMemberCreditAggregate.mockResolvedValueOnce({
        _sum: { amountCents: 1500 },
      });

      const resultB = await cancelBooking(
        "bk_ib2",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );
      expect(resultB.status).toBe(200);
      expect(
        mocks.enqueueXeroModificationCreditNoteOperation
      ).toHaveBeenCalledWith(
        { bookingId: "bk_ib2", refundAmountCents: 7000 },
        { createdByMemberId: "member_1" }
      );
      expect(
        mocks.repairLegacyAppliedCreditNoteAllocationsForBooking
      ).toHaveBeenCalledWith("bk_ib2", "inv_ib2", mocks.lastTx);
      expect(mocks.lockMemberCreditLedger).toHaveBeenCalledWith(
        "member_1",
        mocks.lastTx,
      );
      expect(
        mocks.lockMemberCreditLedger.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.repairLegacyAppliedCreditNoteAllocationsForBooking.mock
          .invocationCallOrder[0],
      );
    });

    it("defers cancellation before any write when clamp deallocation has not converged", async () => {
      const booking = neverCapturedBooking(
        { id: "bk_dealloc", finalPriceCents: 8000 },
        {
          id: "payment_dealloc",
          bookingId: "bk_dealloc",
          source: "INTERNET_BANKING",
          status: "PROCESSING",
          stripePaymentIntentId: null,
          xeroInvoiceId: "inv_dealloc",
        },
      );
      mocks.bookingFindUnique.mockResolvedValueOnce(booking);
      mocks.txBookingFindUnique.mockResolvedValueOnce(booking);
      mocks.findUnconvergedAppliedCreditDeallocation.mockResolvedValueOnce({
        id: "op_dealloc",
        status: "PENDING",
      });

      const result = await cancelBooking(
        "bk_dealloc",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card",
      );

      expect(result).toEqual({
        status: 409,
        error:
          "Applied credit is still being reconciled with Xero; retry cancellation after it completes",
      });
      expect(mocks.bookingUpdate).not.toHaveBeenCalled();
      expect(mocks.paymentUpdate).not.toHaveBeenCalled();
      expect(mocks.restoreCreditFromBooking).not.toHaveBeenCalled();
      expect(
        mocks.enqueueXeroModificationCreditNoteOperation,
      ).not.toHaveBeenCalled();
    });

    it("runs the restore inside the existing claim on a no-payment WAITLISTED cancel and preserves the response field semantics", async () => {
      const waitlisted = {
        id: "bk_wl",
        memberId: "member_1",
        lodgeId: "lodge_1",
        status: "WAITLISTED",
        finalPriceCents: 4000,
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        member: {
          id: "member_1",
          email: "member@example.com",
          firstName: "Alice",
        },
        payment: null,
      };
      mocks.bookingFindUnique.mockResolvedValueOnce(waitlisted);
      mocks.txBookingFindUnique.mockResolvedValueOnce(waitlisted);
      mocks.restoreCreditFromBooking.mockResolvedValue(0);

      const result = await cancelBooking(
        "bk_wl",
        "member_1",
        "MEMBER",
        "127.0.0.1"
      );

      const data = expectSuccess(result);
      expect(mocks.restoreCreditFromBooking).toHaveBeenCalledTimes(1);
      expect(mocks.restoreCreditFromBooking).toHaveBeenCalledWith(
        "member_1",
        "bk_wl",
        mocks.lastTx
      );
      // A 0 restore leaves the field undefined (|| undefined semantics).
      expect(data.creditRestoredCents).toBeUndefined();
    });

    it("cleans up the promo redemption exactly once when a credit-carrying booking is cancelled (no cross-contamination)", async () => {
      const booking = neverCapturedBooking();
      mocks.bookingFindUnique.mockResolvedValueOnce(booking);
      mocks.txBookingFindUnique.mockResolvedValueOnce(booking);
      mocks.txPaymentTransactionFindFirst.mockResolvedValueOnce(null);
      mocks.restoreCreditFromBooking.mockResolvedValue(2000);
      // A promo redemption exists for this booking.
      const redemption = { id: "redemption_nc", bookingId: "bk_nc" };
      mocks.promoRedemptionFindUnique.mockResolvedValue(redemption);

      const result = await cancelBooking(
        "bk_nc",
        "member_1",
        "MEMBER",
        "127.0.0.1",
        "card"
      );

      expect(result.status).toBe(200);
      // The promo cleanup fires exactly once — credit restore never disturbs the
      // promo lifecycle.
      expect(mocks.promoRedemptionFindUnique).toHaveBeenCalledTimes(1);
      expect(mocks.deletePromoRedemptionAndAdjustCount).toHaveBeenCalledTimes(1);
      expect(mocks.deletePromoRedemptionAndAdjustCount).toHaveBeenCalledWith(
        expect.anything(),
        redemption
      );
    });
  });

  it("still refuses the cancellation when the hosting participant fence loses (#2619, #2623 T5)", async () => {
    // THE FENCE IS STILL ON THIS PATH, and this suite is where that stops being
    // a claim about a test double. #2623 T5 put a hosting-mode read in front of
    // the participant fence so a club with the rule switched off pays no row
    // lock on an ordinary booking write. The reverse has to keep holding: at a
    // lodge where the rule IS active, a concurrent member-lifecycle writer
    // holding the owner's `Member` row must still stop the cancellation rather
    // than let it commit around the fence.
    //
    // It is also the mutation detector for `fenceHostingPolicyFindMany`. If that
    // double is ever "simplified" to `DISABLED` or `[]`, the gate returns before
    // the fence and this cancellation succeeds — the failure the fence doubles
    // in this file exist to make impossible, and one that no other assertion
    // here would notice.
    mocks.txExecuteRaw.mockImplementation(async (statement: unknown) => {
      const sql = String(
        (statement as { strings?: readonly string[] })?.strings?.join(" ") ?? "",
      );
      if (sql.includes("FOR KEY SHARE NOWAIT")) {
        throw { driverAdapterError: { cause: { originalCode: "55P03" } } };
      }
      return undefined;
    });

    // The stable contract, not an opaque failure: the fixed retry code and its
    // 409, which is what every caller of this service already keys off.
    await expect(
      cancelBooking("booking_1", "member_1", "MEMBER", "127.0.0.1", "credit"),
    ).rejects.toMatchObject({
      code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
      statusCode: 409,
    });
    // And it lands before anything irreversible leaves the process. The ledger
    // writes that already ran are inside the claim transaction the throw rolls
    // back (#1160); the provider call and the member's email are not, and they
    // never happen.
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
  });
});


describe("cancelBooking detaches the held booking-request pointer (issue #1254)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    // #1311 (follow-up to #1334): the no-payment claim re-reads the FULL booking
    // row under the advisory lock and sources its downstream reconcile / audit /
    // email / waitlist from THAT read. By default the under-lock re-read returns
    // the same still-held row the outer read saw, so the claim succeeds. The
    // concurrency test overrides the status to model a quote-accept winning the
    // lock race.
    mocks.txBookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      lodgeId: "lodge_1",
      status: "AWAITING_REVIEW",
      finalPriceCents: 1000,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
      payment: null,
    });
    // The no-payment claim now runs inside a $transaction callback (under the
    // advisory lock); the paid branches use the array form. Support both with a
    // full mock tx client so the claim can $executeRaw the lock, re-read, flip
    // status, and detach the held-request pointer inside the transaction.
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          // #2619: the hosting participant fence locks the participant Member
          // rows and then re-reads them, plus each source booking's owner and
          // lodge, to detect drift under the lock. Model both reads — the
          // booking side replays whatever this tx's own findUnique served, so
          // the no-drift case matches by construction.
          const fenceBooking = recordingBookingDouble((args) =>
            mocks.txBookingFindUnique(args),
          );
          const mockTx = {
            $executeRaw: mocks.txExecuteRaw,
            member: { findMany: fenceMemberFindMany() },
            // #2623 T5: the seam reads the lodge's hosting mode before the fence, so
            // the double answers with an ACTIVE one and the fence above stays on the
            // path. See `fenceHostingPolicyFindMany`.
            adultMemberHostingPolicy: { findMany: fenceHostingPolicyFindMany() },
            booking: {
              findUnique: fenceBooking.findUnique,
              findMany: fenceBooking.findMany,
              update: mocks.bookingUpdate,
              updateMany: mocks.bookingUpdateMany,
            },
            bookingRequest: {
              updateMany: mocks.bookingRequestUpdateMany,
            },
            payment: {
              update: mocks.paymentUpdate,
            },
          };
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
    );
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookingRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    // #1547: no-payment branches call restoreCreditFromBooking (no-op here);
    // pin the return so the cancellation email's 7th arg is deterministic.
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
  });

  it("nulls heldBookingId on the owning request when a held AWAITING_REVIEW booking is cancelled", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      lodgeId: "lodge_1",
      status: "AWAITING_REVIEW",
      finalPriceCents: 1000,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
      payment: null,
    });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    // The dangling pointer is detached so a later re-quote creates a fresh hold
    // instead of reusing this now-cancelled row.
    expect(mocks.bookingRequestUpdateMany).toHaveBeenCalledWith({
      where: { heldBookingId: "held-1" },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
  });

  // #1255 RR-2 (Option A): the admin "Release hold" action passes
  // suppressCustomerNotification so the requester is NOT emailed a cancellation
  // for a hold being administratively released.
  const heldBooking = {
    id: "held-1",
    memberId: "owner-1",
    status: "AWAITING_REVIEW" as const,
    finalPriceCents: 1000,
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    lodgeId: "lodge-1",
    member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
    payment: null,
  };

  it("sends the cancellation email for a held booking when notification is NOT suppressed", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    // The email/audit/waitlist all source from the under-lock `fresh` read
    // (#1311 follow-up to #1334), so the tx re-read must carry the same
    // lodgeId as the outer snapshot for this assertion to be meaningful.
    mocks.txBookingFindUnique.mockResolvedValue({ ...heldBooking });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "held-1", recipientMemberId: "owner-1" },
      "req@example.com",
      "Req",
      heldBooking.checkIn,
      heldBooking.checkOut,
      0,
      "card",
      0,
      "lodge-1",
    );
  });

  it("suppresses the cancellation email but still detaches + audits when suppressCustomerNotification is true", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });

    const result = await cancelBooking(
      "held-1",
      "admin-1",
      "ADMIN",
      "127.0.0.1",
      "card",
      { suppressCustomerNotification: true },
    );

    expect(result.status).toBe(200);
    // The customer email is skipped...
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    // ...but the hold is still released: pointer detached and cancellation audited.
    expect(mocks.bookingRequestUpdateMany).toHaveBeenCalledWith({
      where: { heldBookingId: "held-1" },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
    expect(mocks.logAudit).toHaveBeenCalled();
  });
});

// #1311: the no-payment cancel path must be a status-guarded claim-first under
// the SAME booking advisory lock the quote-accept path takes, so cancelling a
// held AWAITING_REVIEW booking can never clobber a concurrent accept that has
// already converted it to PENDING.
describe("cancelBooking no-payment claim-first (issue #1311)", () => {
  const heldBooking = {
    id: "held-1",
    memberId: "owner-1",
    lodgeId: "lodge_1",
    status: "AWAITING_REVIEW" as const,
    finalPriceCents: 1000,
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
    payment: null,
  };

  function lockWasAcquired() {
    return mocks.txExecuteRaw.mock.calls.some((call) =>
      String((call as unknown[])[0]).includes("pg_advisory_xact_lock"),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          // #2619: the hosting participant fence locks the participant Member
          // rows and then re-reads them, plus each source booking's owner and
          // lodge, to detect drift under the lock. Model both reads — the
          // booking side replays whatever this tx's own findUnique served, so
          // the no-drift case matches by construction.
          const fenceBooking = recordingBookingDouble((args) =>
            mocks.txBookingFindUnique(args),
          );
          const mockTx = {
            $executeRaw: mocks.txExecuteRaw,
            member: { findMany: fenceMemberFindMany() },
            // #2623 T5: the seam reads the lodge's hosting mode before the fence, so
            // the double answers with an ACTIVE one and the fence above stays on the
            // path. See `fenceHostingPolicyFindMany`.
            adultMemberHostingPolicy: { findMany: fenceHostingPolicyFindMany() },
            booking: {
              findUnique: fenceBooking.findUnique,
              findMany: fenceBooking.findMany,
              update: mocks.bookingUpdate,
              updateMany: mocks.bookingUpdateMany,
            },
            bookingRequest: { updateMany: mocks.bookingRequestUpdateMany },
            payment: { update: mocks.paymentUpdate },
          };
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
    );
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookingRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    // #1547: no-payment branches call restoreCreditFromBooking (no-op here).
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
  });

  it("takes the advisory lock, re-reads status under it, then flips a still-held booking to CANCELLED", async () => {
    // Winner path: both the outer read and the under-lock re-read see
    // AWAITING_REVIEW, so the claim commits. The under-lock read now returns the
    // full row (its data feeds the downstream reconcile/audit/email/waitlist).
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ ...heldBooking });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    // The advisory lock is acquired inside the claim tx — this is the only part
    // of the fix a mocked-prisma unit test can pin, and it is what serialises
    // cancel against the quote-accept path (booking-request.ts).
    expect(lockWasAcquired()).toBe(true);
    // The status is re-read under the lock and then flipped exactly once.
    expect(mocks.txBookingFindUnique).toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "held-1",
        status: { in: ["WAITLISTED", "WAITLIST_OFFERED", "AWAITING_REVIEW"] },
      },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistPosition: null,
        // Cross-lodge offer residue is cleared on cancel too (ADR-004 / Low).
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
      },
    });
  });

  it("returns 409 and clobbers NOTHING when a concurrent quote-accept converts the hold under the lock", async () => {
    // Interleave: the cancel's stale outer read still saw AWAITING_REVIEW (so it
    // passed the outer status guard and entered the no-payment branch), but by
    // the time it wins the advisory lock the concurrent quote-accept has already
    // committed AWAITING_REVIEW -> PENDING and released the lock. The under-lock
    // re-read therefore sees PENDING. Absent this re-read the code would have
    // flipped the just-accepted PENDING booking to CANCELLED — the exact clobber
    // #1311 closes.
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ status: "PENDING" });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    // The loser gets a real 409, never a false 200.
    expect(result.status).toBe(409);
    // The lock WAS taken and the status WAS re-read under it — proving the guard,
    // not luck, caught the race.
    expect(lockWasAcquired()).toBe(true);
    expect(mocks.txBookingFindUnique).toHaveBeenCalled();
    // NOTHING was clobbered or side-effected: no status flip, no pointer detach,
    // no bed reconcile side effects, no audit, no email, no waitlist re-process.
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.bookingRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("returns 409 when another cancel already claimed the booking (re-read sees CANCELLED)", async () => {
    // The other race direction: a concurrent cancel won the lock first and
    // committed CANCELLED. Our re-read under the lock sees CANCELLED (not in the
    // no-payment set), so we abort as a pure no-op rather than double-cancelling.
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ status: "CANCELLED" });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(409);
    expect(lockWasAcquired()).toBe(true);
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
  });

  // #1311 follow-up to #1334: the winner path must source its downstream
  // reconcile / audit / cancellation email / waitlist re-process from the
  // authoritative UNDER-LOCK read, not the stale pre-lock outer read. Diverge
  // the two reads: the outer read carries stale member + dates, the under-lock
  // read carries the authoritative member + dates (both WAITLIST_OFFERED, so the
  // claim commits and the waitlist branch runs). Every observable downstream
  // consumer must use the under-lock values.
  it("sources the cancellation email, audit, and waitlist from the under-lock fresh row, not the stale outer read", async () => {
    const staleCheckIn = new Date("2026-09-01");
    const staleCheckOut = new Date("2026-09-03");
    const freshCheckIn = new Date("2026-10-05");
    const freshCheckOut = new Date("2026-10-07");

    // Stale pre-lock read: passed the outer status guard, then the row was
    // (hypothetically) re-quoted under a new member/date window before the lock.
    mocks.bookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      status: "WAITLIST_OFFERED",
      finalPriceCents: 1000,
      checkIn: staleCheckIn,
      checkOut: staleCheckOut,
      lodgeId: "lodge-stale",
      member: { id: "owner-1", email: "stale@example.com", firstName: "Stale" },
      payment: null,
    });
    // Authoritative under-lock read: still in the no-payment set (claim wins).
    mocks.txBookingFindUnique.mockResolvedValue({
      id: "held-1",
      memberId: "owner-1",
      status: "WAITLIST_OFFERED",
      finalPriceCents: 1000,
      checkIn: freshCheckIn,
      checkOut: freshCheckOut,
      lodgeId: "lodge-fresh",
      member: { id: "owner-1", email: "fresh@example.com", firstName: "Fresh" },
      payment: null,
    });

    const result = await cancelBooking("held-1", "admin-1", "ADMIN", "127.0.0.1");

    expect(result.status).toBe(200);
    expect(lockWasAcquired()).toBe(true);

    // Email uses the UNDER-LOCK member + dates, never the stale outer read.
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendBookingCancelledEmail).toHaveBeenCalledWith(
      { bookingId: "held-1", recipientMemberId: "owner-1" },
      "fresh@example.com",
      "Fresh",
      freshCheckIn,
      freshCheckOut,
      0,
      "card",
      0,
      "lodge-fresh",
    );
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalledWith(
      { bookingId: "held-1", recipientMemberId: "owner-1" },
      "stale@example.com",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    // Waitlist re-process (WAITLIST_OFFERED) uses the under-lock dates + lodge.
    expect(mocks.processWaitlistForDates).toHaveBeenCalledWith({
      checkIn: freshCheckIn,
      checkOut: freshCheckOut,
      lodgeId: "lodge-fresh",
    });

    // Audit metadata (checkIn/checkOut/statusBefore) is derived from the
    // under-lock row: the ISO dates match the fresh window, not the stale one.
    const auditMetadata = mocks.logAudit.mock.calls[0][0].metadata;
    expect(auditMetadata.checkIn).toBe(freshCheckIn.toISOString());
    expect(auditMetadata.checkOut).toBe(freshCheckOut.toISOString());
    expect(auditMetadata.checkIn).not.toBe(staleCheckIn.toISOString());
  });

  // Low fix (ADR-004): cancelling a WAITLIST_OFFERED booking must clear ALL
  // FOUR offer fields, including the cross-lodge offered lodge and price —
  // otherwise the cancelled row keeps stale offered-lodge residue.
  it("clears all four offer fields when cancelling a cross-lodge WAITLIST_OFFERED booking", async () => {
    const offered = {
      id: "held-1",
      memberId: "owner-1",
      status: "WAITLIST_OFFERED",
      finalPriceCents: 1000,
      checkIn: new Date("2026-09-01"),
      checkOut: new Date("2026-09-03"),
      lodgeId: "lodge-a",
      waitlistOfferedLodgeId: "lodge-b",
      waitlistOfferedPriceCents: 34000,
      member: { id: "owner-1", email: "owner@example.com", firstName: "Owner" },
      payment: null,
    };
    mocks.bookingFindUnique.mockResolvedValue({ ...offered });
    mocks.txBookingFindUnique.mockResolvedValue({ ...offered });

    const result = await cancelBooking("held-1", "owner-1", "USER", "127.0.0.1");

    expect(result.status).toBe(200);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "held-1",
        status: { in: ["WAITLISTED", "WAITLIST_OFFERED", "AWAITING_REVIEW"] },
      },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistPosition: null,
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
      },
    });
  });
});

// #1406: opt-in caller guard (`requireRequestHold`) for the two "release a held
// request" paths — the admin "Release hold" route and `declineBookingRequest`.
// They expect an AWAITING_REVIEW hold. cancelBooking dispatches its branch from
// an OUTER, un-locked read, so a concurrent quote-accept can flip the hold
// AWAITING_REVIEW -> PENDING before that read runs. Without the guard the
// PENDING snapshot would fall into the generic PENDING branch — which is
// UNLOCKED and has NO status re-guard — and cancel the just-accepted booking,
// revoking its brand-new payment links. The guard refuses (409, no side effect)
// BEFORE branch dispatch. It is opt-in: callers cancelling genuine PENDING
// bookings never pass it and are unaffected.
describe("cancelBooking requireRequestHold guard (issue #1406)", () => {
  const heldBooking = {
    id: "held-1",
    memberId: "owner-1",
    lodgeId: "lodge_1",
    status: "AWAITING_REVIEW" as const,
    finalPriceCents: 1000,
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
    payment: null,
  };

  function lockWasAcquired() {
    return mocks.txExecuteRaw.mock.calls.some((call) =>
      String((call as unknown[])[0]).includes("pg_advisory_xact_lock"),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    mocks.prismaTransaction.mockImplementation(
      async (
        arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ) => {
        if (typeof arg === "function") {
          // #2619: the hosting participant fence locks the participant Member
          // rows and then re-reads them, plus each source booking's owner and
          // lodge, to detect drift under the lock. Model both reads — the
          // booking side replays whatever this tx's own findUnique served, so
          // the no-drift case matches by construction.
          const fenceBooking = recordingBookingDouble((args) =>
            mocks.txBookingFindUnique(args),
          );
          const mockTx = {
            $executeRaw: mocks.txExecuteRaw,
            member: { findMany: fenceMemberFindMany() },
            // #2623 T5: the seam reads the lodge's hosting mode before the fence, so
            // the double answers with an ACTIVE one and the fence above stays on the
            // path. See `fenceHostingPolicyFindMany`.
            adultMemberHostingPolicy: { findMany: fenceHostingPolicyFindMany() },
            booking: {
              findUnique: fenceBooking.findUnique,
              findMany: fenceBooking.findMany,
              update: mocks.bookingUpdate,
              updateMany: mocks.bookingUpdateMany,
            },
            bookingRequest: { updateMany: mocks.bookingRequestUpdateMany },
            payment: { update: mocks.paymentUpdate },
          };
          return arg(mockTx);
        }
        return Promise.all(arg);
      },
    );
    mocks.bookingUpdate.mockResolvedValue({});
    mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookingRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.promoRedemptionFindUnique.mockResolvedValue(null);
    mocks.sendBookingCancelledEmail.mockResolvedValue(undefined);
    mocks.processWaitlistForDates.mockResolvedValue(undefined);
    mocks.revokePaymentLinksForBooking.mockResolvedValue(undefined);
    // #1547: the PENDING / no-payment claims call restoreCreditFromBooking.
    mocks.restoreCreditFromBooking.mockResolvedValue(0);
  });

  it("refuses with 409 and clobbers NOTHING when the outer read shows the hold already accepted (PENDING)", async () => {
    // A concurrent quote-accept already flipped the hold AWAITING_REVIEW ->
    // PENDING, so cancelBooking's own outer read sees PENDING. Absent the guard
    // this would dispatch into the unlocked generic PENDING branch and cancel
    // the just-accepted booking + revoke its brand-new payment links.
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking, status: "PENDING" });

    const result = await cancelBooking(
      "held-1",
      "admin-1",
      "ADMIN",
      "127.0.0.1",
      "card",
      { requireRequestHold: true },
    );

    // Real 409 loser, never a false 200.
    expect(result.status).toBe(409);
    // The guard fired BEFORE any branch dispatch: no transaction, no status
    // flip to CANCELLED, and — critically — no payment-link revocation on the
    // just-accepted booking. Nothing was clobbered.
    expect(mocks.prismaTransaction).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.revokePaymentLinksForBooking).not.toHaveBeenCalled();
    expect(mocks.bookingRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
    expect(mocks.sendBookingCancelledEmail).not.toHaveBeenCalled();
    expect(mocks.processWaitlistForDates).not.toHaveBeenCalled();
  });

  it("cancels a genuine AWAITING_REVIEW hold normally and detaches heldBookingId", async () => {
    // Both reads see AWAITING_REVIEW: the guard passes, the no-payment
    // claim-first branch runs, the hold is released and its pointer detached.
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ ...heldBooking });

    const result = await cancelBooking(
      "held-1",
      "admin-1",
      "ADMIN",
      "127.0.0.1",
      "card",
      { requireRequestHold: true },
    );

    expect(result.status).toBe(200);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "held-1",
        status: { in: ["WAITLISTED", "WAITLIST_OFFERED", "AWAITING_REVIEW"] },
      },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
        waitlistOfferedAt: null,
        waitlistOfferExpiresAt: null,
        waitlistPosition: null,
        // Cross-lodge offer residue is cleared on cancel too (ADR-004 / Low).
        waitlistOfferedLodgeId: null,
        waitlistOfferedPriceCents: null,
      },
    });
    // The booking-request pointer to this hold is detached at the source (#1254).
    expect(mocks.bookingRequestUpdateMany).toHaveBeenCalledWith({
      where: { heldBookingId: "held-1" },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
  });

  it("still refuses with 409 (no clobber) when the outer read is AWAITING_REVIEW but the under-lock re-read finds PENDING", async () => {
    // The accept committed AFTER cancel's outer read but BEFORE cancel won the
    // advisory lock. The guard passed (outer read was AWAITING_REVIEW); the
    // existing #1311 under-lock re-read (NO_PAYMENT_CANCELLABLE_STATUSES guard)
    // is the second half of the fix and catches it here.
    mocks.bookingFindUnique.mockResolvedValue({ ...heldBooking });
    mocks.txBookingFindUnique.mockResolvedValue({ status: "PENDING" });

    const result = await cancelBooking(
      "held-1",
      "admin-1",
      "ADMIN",
      "127.0.0.1",
      "card",
      { requireRequestHold: true },
    );

    expect(result.status).toBe(409);
    expect(lockWasAcquired()).toBe(true);
    expect(mocks.txBookingFindUnique).toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
    expect(mocks.revokePaymentLinksForBooking).not.toHaveBeenCalled();
    expect(mocks.bookingRequestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("regression: WITHOUT the option, a genuine PENDING member booking is still cancelled via the generic PENDING branch", async () => {
    // The opt-in guard must not touch the legitimate PENDING callers (member
    // self-cancel, deletion cleanup, split-cascade). A member cancelling their
    // own PENDING booking with no option passed still flows through the generic
    // PENDING branch and cancels normally.
    const pendingBooking = {
      id: "pending-1",
      memberId: "owner-1",
      lodgeId: "lodge_1",
      status: "PENDING",
      finalPriceCents: 1000,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      member: { id: "owner-1", email: "req@example.com", firstName: "Req" },
      payment: null,
    };
    mocks.bookingFindUnique.mockResolvedValue(pendingBooking);
    // #1547: the generic PENDING branch is now a claim-first tx that re-reads
    // under lock(1); mirror the outer read so the claim commits.
    mocks.txBookingFindUnique.mockResolvedValue(pendingBooking);

    const result = await cancelBooking("pending-1", "owner-1", "USER", "127.0.0.1");

    expect(result.status).toBe(200);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "pending-1", status: "PENDING" },
      data: {
        status: "CANCELLED",
        adminCapacityHoldAt: null,
        adminCapacityHoldByMemberId: null,
        wholeLodgeHold: false,
        wholeLodgeHoldAt: null,
        wholeLodgeHoldByMemberId: null,
      },
    });
  });

  // ── #177: exclusive whole-lodge hold release on terminal transition ──────
  describe("releases the exclusive whole-lodge hold on cancel (issue #177)", () => {
    const heldPaidBooking = {
      id: "booking_held",
      memberId: "member_1",
      lodgeId: "lodge_1",
      status: "PAID",
      finalPriceCents: 10000,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      // A capacity-holding booking carrying an exclusive whole-lodge hold.
      wholeLodgeHold: true,
      wholeLodgeHoldAt: new Date("2026-07-01"),
      wholeLodgeHoldByMemberId: "admin_9",
      member: { id: "member_1", email: "member@example.com", firstName: "Alice" },
      payment: {
        id: "payment_1",
        bookingId: "booking_held",
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        changeFeeCents: 0,
        creditAppliedCents: 0,
        stripePaymentIntentId: "pi_1",
      },
    };

    it("clears the hold fields in the same update as the status flip", async () => {
      mocks.bookingFindUnique.mockResolvedValue(heldPaidBooking);
      mocks.txBookingFindUnique.mockResolvedValue(heldPaidBooking);

      const result = await cancelBooking(
        "booking_held",
        "member_1",
        "MEMBER",
        "127.0.0.1",
      );

      expect(result.status).toBe(200);
      expect(mocks.bookingUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "booking_held" },
          data: expect.objectContaining({
            status: "CANCELLED",
            wholeLodgeHold: false,
            wholeLodgeHoldAt: null,
            wholeLodgeHoldByMemberId: null,
          }),
        }),
      );
    });

    it("records a booking.exclusiveHold.released audit noting the auto-release", async () => {
      mocks.bookingFindUnique.mockResolvedValue(heldPaidBooking);
      mocks.txBookingFindUnique.mockResolvedValue(heldPaidBooking);

      await cancelBooking("booking_held", "member_1", "MEMBER", "127.0.0.1");

      const released = mocks.logAudit.mock.calls.find(
        (call) => call[0]?.action === "booking.exclusiveHold.released",
      );
      expect(released).toBeDefined();
      expect(released![0]).toMatchObject({
        entityType: "Booking",
        entityId: "booking_held",
        metadata: expect.objectContaining({
          previouslyHeldByMemberId: "admin_9",
        }),
      });
    });

    it("does NOT record a released audit when the booking held nothing (no re-arm surprise)", async () => {
      const unheld = { ...heldPaidBooking, wholeLodgeHold: false, wholeLodgeHoldAt: null, wholeLodgeHoldByMemberId: null };
      mocks.bookingFindUnique.mockResolvedValue(unheld);
      mocks.txBookingFindUnique.mockResolvedValue(unheld);

      await cancelBooking("booking_held", "member_1", "MEMBER", "127.0.0.1");

      const released = mocks.logAudit.mock.calls.find(
        (call) => call[0]?.action === "booking.exclusiveHold.released",
      );
      expect(released).toBeUndefined();
    });
  });
});
