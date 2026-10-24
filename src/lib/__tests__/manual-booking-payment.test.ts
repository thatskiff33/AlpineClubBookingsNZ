import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  BookingStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

/**
 * B5 (#2262) — manual mark-paid for booking payments (cash / off-Xero bank
 * transfer), and its reversal.
 *
 * The four guards from the issue, each mutation-verified: every test here fails
 * if its guard's code is reverted.
 *  1. the settlement goes through the ONE settlement body — same lock ordering
 *     (global -> lodge -> member-credit), same capacity check, same fenced PAID
 *     claim, same bed reconciliation, same durable event;
 *  2. it is REFUSED whenever any Xero invoice evidence exists, including a
 *     queued mint, and the fenced write re-asserts what it can;
 *  3. the settlement is visible to the duplicate-capture detector (covered by
 *     the widened predicate in issue-1992-duplicate-capture-refund.test.ts);
 *  4. no new PaymentSource member — the row settles as INTERNET_BANKING with
 *     provenance columns.
 */

const mocks = vi.hoisted(() => ({
  lockPaymentForRefundedTotal: vi.fn<(tx: unknown, paymentId: string) => Promise<undefined>>(async () => undefined),
  transaction: vi.fn(),
  paymentUpdate: vi.fn<(...args: unknown[]) => Promise<object>>(async () => ({})),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentUpsert: vi.fn(),
  paymentUpdateMany: vi.fn(),
  paymentRefundCount: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
  paymentTransactionUpdateMany: vi.fn(),
  paymentTransactionCreate: vi.fn(),
  paymentRecoveryOperationFindMany: vi.fn(),
  paymentRecoveryOperationFindFirst: vi.fn(),
  paymentRecoveryOperationUpdateMany: vi.fn(),
  paymentRecoveryOperationDeleteMany: vi.fn(),
  manualRefundTaskFindFirst: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroSyncOperationFindFirst: vi.fn(),
  lodgeFindFirst: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  lockMemberCreditLedger: vi.fn(),
  deriveBookingAppliedCreditCents: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  restoreCreditFromBooking: vi.fn(),
  auditLogFindFirst: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  findPaymentTransactionByIntentId: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  enqueuePaymentIntentCancellationRecovery: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  recordBookingEvent: vi.fn(),
  createAuditLog: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...args: unknown[]) => mocks.transaction(...args) },
}));

vi.mock("@/lib/payment-transactions", () => ({
  // #4217: the settle locks the Payment row before its ledger lookup.
  lockPaymentForRefundedTotal: (tx: unknown, paymentId: string) => mocks.lockPaymentForRefundedTotal(tx, paymentId),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mocks.upsertPaymentIntentTransaction(...args),
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mocks.findPaymentTransactionByIntentId(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mocks.refundPaymentTransactions(...args),
  planStripeRefundAllocation: (...args: unknown[]) =>
    mocks.planStripeRefundAllocation(...args),
}));

vi.mock("@/lib/payment-recovery", () => ({
  enqueueCapacityClaimFailedRefundRecovery: vi.fn(),
  enqueueDuplicateCaptureRefundRecovery: vi.fn(),
  enqueuePaymentIntentCancellationRecovery: (...args: unknown[]) =>
    mocks.enqueuePaymentIntentCancellationRecovery(...args),
  markCapacityClaimFailedRefundRecoverySucceeded: vi.fn(),
  markDuplicateCaptureRefundRecoverySucceeded: vi.fn(),
  recordCapacityClaimFailedRefundRecoveryInlineError: vi.fn(),
  recordDuplicateCaptureRefundRecoveryInlineError: vi.fn(),
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: (...args: unknown[]) =>
    mocks.acquireLodgeCapacityLock(...args),
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    mocks.checkCapacityForGuestRanges(...args),
}));

vi.mock("@/lib/member-credit", () => ({
  deriveBookingAppliedCreditCents: (...args: unknown[]) =>
    mocks.deriveBookingAppliedCreditCents(...args),
  getMemberCreditBalance: (...args: unknown[]) =>
    mocks.getMemberCreditBalance(...args),
  lockMemberCreditLedger: (...args: unknown[]) =>
    mocks.lockMemberCreditLedger(...args),
  restoreCreditFromBooking: (...args: unknown[]) =>
    mocks.restoreCreditFromBooking(...args),
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: vi.fn(),
  sendAdminDuplicateCaptureRefundAlert: vi.fn(),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: (...args: unknown[]) =>
    mocks.reconcileBedAllocationsForBooking(...args),
}));

vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...args: unknown[]) => mocks.recordBookingEvent(...args),
  recordDuplicateCaptureRefundEvent: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mocks.createAuditLog(...args),
}));

vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellable: (...args: unknown[]) =>
    mocks.cancelPaymentIntentIfCancellable(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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


import {
  ManualBookingPaymentError,
  markBookingPaymentManuallySettled,
  reverseManualBookingPayment,
} from "@/lib/payment-reconciliation";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { isAdditionalAmountUncollected } from "@/lib/unpaid-finished-stays";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS, PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";
import {
  NOT_SAVED_CARD_CHARGE_ATTEMPT_ROW_WHERE,
  SAVED_CARD_CHARGE_ATTEMPT_ROW_WHERE,
} from "@/lib/saved-card-charge-attempt";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const tx = {
  $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  $queryRaw: (...args: unknown[]) => mocks.executeRaw(...args),
  lodge: { findFirst: (...args: unknown[]) => mocks.lodgeFindFirst(...args) },
  // #3595: the settle asks the ledger once per booking whether its
  // confirmation is already posted, then posts through the write door.
  bookingLedgerLine: {
    findFirst: vi.fn().mockResolvedValue(null),
    // #3581: the settlement sync reads what is already posted before posting.
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
  },
  booking: {
    findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    updateMany: (...args: unknown[]) => mocks.bookingUpdateMany(...args),
  },
  payment: {
    findUnique: (...args: unknown[]) => mocks.paymentFindUnique(...args),
    upsert: (...args: unknown[]) => mocks.paymentUpsert(...args),
    updateMany: (...args: unknown[]) => mocks.paymentUpdateMany(...args),
    // #4211: the PAID claim records which row settled the booking.
    update: (...args: unknown[]) => mocks.paymentUpdate(...args),
  },
  paymentRefund: {
    count: (...args: unknown[]) => mocks.paymentRefundCount(...args),
  },
  paymentTransaction: {
    findFirst: (...args: unknown[]) => mocks.paymentTransactionFindFirst(...args),
    findMany: (...args: unknown[]) => mocks.paymentTransactionFindMany(...args),
    updateMany: (...args: unknown[]) =>
      mocks.paymentTransactionUpdateMany(...args),
    create: (...args: unknown[]) => mocks.paymentTransactionCreate(...args),
  },
  paymentRecoveryOperation: {
    findMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindMany(...args),
    findFirst: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationFindFirst(...args),
    updateMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationUpdateMany(...args),
    deleteMany: (...args: unknown[]) =>
      mocks.paymentRecoveryOperationDeleteMany(...args),
  },
  manualRefundTask: {
    findFirst: (...args: unknown[]) => mocks.manualRefundTaskFindFirst(...args),
  },
  xeroObjectLink: {
    findFirst: (...args: unknown[]) => mocks.xeroObjectLinkFindFirst(...args),
  },
  xeroSyncOperation: {
    findFirst: (...args: unknown[]) => mocks.xeroSyncOperationFindFirst(...args),
  },
  auditLog: {
    findFirst: (...args: unknown[]) => mocks.auditLogFindFirst(...args),
  },
};

const ADMIN_ID = "admin-1";

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: "lodge-1",
    status: BookingStatus.PAYMENT_PENDING,
    finalPriceCents: 12000,
    checkIn: parseDateOnly("2026-08-01"),
    checkOut: parseDateOnly("2026-08-03"),
    parentBookingId: null,
    organiserSettled: false,
    guests: [],
    member: {
      id: "member-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.org",
    },
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-1",
    // #2397: an unsettled payment — the ordinary settle-from shape. A payment
    // that has already taken money (SUCCEEDED / refunded) is refused at read
    // time now, not only at the fence.
    status: "PENDING",
    xeroInvoiceId: null,
    xeroRefundCreditNoteId: null,
    manuallyMarkedPaidAt: null,
    refundedAmountCents: 0,
    // #2397: no outstanding upward-modification delta, the overwhelmingly
    // common shape and the one where the dialog is unchanged.
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
    ...overrides,
  };
}

/** No Xero evidence of any kind. */
function primeNoXeroEvidence() {
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  mocks.xeroSyncOperationFindFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx)
  );
  mocks.executeRaw.mockResolvedValue(undefined);
  mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  mocks.lockMemberCreditLedger.mockResolvedValue(undefined);
  mocks.deriveBookingAppliedCreditCents.mockResolvedValue(2000);
  mocks.getMemberCreditBalance.mockResolvedValue(0);
  // No prior manual settle on this payment unless a test says otherwise, so the
  // reversal's election restore finds nothing to put back.
  mocks.auditLogFindFirst.mockResolvedValue(null);
  mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: true });
  mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
    args.select ? { lodgeId: "lodge-1" } : bookingRow()
  );
  mocks.paymentFindUnique.mockResolvedValue(paymentRow());
  mocks.paymentUpsert.mockResolvedValue({ id: "payment-1" });
  mocks.paymentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
  mocks.paymentTransactionCreate.mockResolvedValue({ id: "txn-manual" });
  mocks.paymentTransactionFindMany.mockResolvedValue([]);
  mocks.paymentRecoveryOperationFindMany.mockResolvedValue([]);
  mocks.paymentRecoveryOperationUpdateMany.mockResolvedValue({ count: 0 });
  mocks.paymentRecoveryOperationDeleteMany.mockResolvedValue({ count: 0 });
  mocks.manualRefundTaskFindFirst.mockResolvedValue(null);
  mocks.paymentRefundCount.mockResolvedValue(0);
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.recordBookingEvent.mockResolvedValue(undefined);
  mocks.createAuditLog.mockResolvedValue(undefined);
  mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(true);
  primeNoXeroEvidence();
});

/**
 * #3581: answer the booking ledger's settlement sync honestly, so the manual
 * paths are shown to post and reverse cash lines rather than slipping through
 * on a double that returns the wrong shape (review of #3604). The sync reads
 * the booking id alone, then the rows it posts from; every other read keeps
 * the suite's ordinary payment row.
 */
function answerSettlementSync(rows: {
  manuallyMarkedPaidAt: Date | null;
  manuallyMarkedPaidByMemberId: string | null;
  transactions: Array<{ id: string; source: string; status: string; amountCents: number }>;
}) {
  mocks.paymentFindUnique.mockImplementation(
    async (args?: { select?: Record<string, unknown> }) => {
      if (args?.select?.refunds && args?.select?.transactions) {
        return { bookingId: "booking-1", booking: { lodgeId: "lodge-1" }, refunds: [], ...rows };
      }
      if (args?.select && Object.keys(args.select).length === 1 && args.select.bookingId) {
        return { bookingId: "booking-1" };
      }
      return paymentRow();
    },
  );
}

function ledgerRowsPosted(): Array<Record<string, unknown>> {
  return (tx.bookingLedgerLine.createMany as unknown as Mock).mock.calls.flatMap(
    (call) => (call[0] as { data: Array<Record<string, unknown>> }).data,
  );
}

function settle(overrides: Record<string, unknown> = {}) {
  return markBookingPaymentManuallySettled({
    format: CLUB_FORMAT_TEST,
    bookingId: "booking-1",
    actingAdminMemberId: ADMIN_ID,
    note: "cash at the lodge",
    expectedAmountCents: 10000,
    notifyMember: false,
    ...overrides,
  });
}

describe("#2262 guard 1 — the manual settlement runs the ONE settlement body", () => {
  it("takes global lock(1), then the per-lodge lock, then the MEMBER-CREDIT lock, before deriving the amount", async () => {
    const order: string[] = [];
    mocks.executeRaw.mockImplementation(async () => {
      order.push("global");
    });
    mocks.acquireLodgeCapacityLock.mockImplementation(async () => {
      order.push("lodge");
    });
    mocks.lockMemberCreditLedger.mockImplementation(async () => {
      order.push("member-credit");
    });
    mocks.deriveBookingAppliedCreditCents.mockImplementation(async () => {
      order.push("derive-amount");
      return 2000;
    });

    await settle();

    // #3792: the settle takes the member key itself (from its post-lock
    // re-read, before the Payment upsert); the manual third tier re-enters it.
    expect(order).toEqual(["global", "lodge", "member-credit", "member-credit", "derive-amount"]);
    expect(new Set(mocks.lockMemberCreditLedger.mock.calls.map(([memberId]) => memberId)).size).toBe(1);
  });

  it("settles at the RE-DERIVED effective price, never a client-supplied amount, and the ledger mirror holds", async () => {
    const result = await settle();

    expect(result.effectiveAmountCents).toBe(10000);
    expect(result.creditAppliedCents).toBe(2000);
    expect(
      result.effectiveAmountCents + result.creditAppliedCents
    ).toBe(12000);
    expect(Number.isInteger(result.effectiveAmountCents)).toBe(true);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PaymentStatus.SUCCEEDED,
          source: PaymentSource.INTERNET_BANKING,
          amountCents: 10000,
          creditAppliedCents: 2000,
        }),
      })
    );
  });

  it("claims PAID behind the shared status fence and reconciles bed allocations", async () => {
    await settle();

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
    expect(mocks.reconcileBedAllocationsForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", db: tx })
    );
  });

  it("#4211 — the PAID claim records the cash row it minted as the booking's settler", async () => {
    mocks.paymentTransactionFindMany.mockImplementation(async (args: { where?: { source?: unknown } }) =>
      args.where?.source === "INTERNET_BANKING" ? [{ id: "txn-manual" }] : [],
    );
    await settle();
    expect(mocks.paymentUpdate).toHaveBeenCalledWith({
      where: { id: "payment-1" },
      data: { settledByTransactionId: "txn-manual" },
    });
  });

  it("#3581 — posts the settled cash to the booking ledger as CASH_RECORDED, naming the acting admin", async () => {
    (tx.bookingLedgerLine.createMany as unknown as Mock).mockClear();
    answerSettlementSync({
      manuallyMarkedPaidAt: new Date("2026-07-01T00:00:00Z"),
      manuallyMarkedPaidByMemberId: ADMIN_ID,
      transactions: [{ id: "txn-manual", source: "INTERNET_BANKING", status: "SUCCEEDED", amountCents: 10000 }],
    });
    await settle();
    expect(ledgerRowsPosted()).toContainEqual(
      expect.objectContaining({
        side: "SETTLEMENT",
        kind: "CASH_RECORDED",
        settlementMethod: "CASH",
        postedByMemberId: ADMIN_ID,
        amountCents: 10000,
        postingKey: "capture:txn-manual",
      }),
    );
  });

  it("records the durable MEMBER_PAID fact with the ACTING ADMIN as the actor", async () => {
    await settle();

    expect(mocks.recordBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        type: "MEMBER_PAID",
        actorMemberId: ADMIN_ID,
        amountCents: 10000,
        reason: "manual_mark_paid",
      })
    );
  });

  it("REFUSES on a capacity failure and writes nothing (no cancel, no refund machinery)", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: false });

    await expect(settle()).rejects.toThrow(
      /no longer fits the lodge — nothing was recorded/
    );
    // The PAID claim, the fenced payment write and the Stripe cancel-and-refund
    // machinery are all untouched.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
  });

  it("settles an over-capacity booking that carries a persisted #1771 override", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue({ available: false });
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? { lodgeId: "lodge-1" }
        : bookingRow({
            capacityOverridden: true,
            capacityOverriddenAt: new Date(),
          })
    );

    await expect(settle()).resolves.toMatchObject({ paymentId: "payment-1" });
  });

  it("409s when the expected amount the admin saw no longer matches", async () => {
    await expect(settle({ expectedAmountCents: 9900 })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("amount owing changed"),
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("409s on an already-PAID booking without adjudicating anything", async () => {
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select
        ? { lodgeId: "lodge-1" }
        : bookingRow({ status: BookingStatus.PAID })
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already paid"),
    });
  });

  it("409s with a zero-owing message naming the paths that CAN settle it", async () => {
    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(12000);

    await expect(settle({ expectedAmountCents: 0 })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "Force confirm / Confirm pending guests"
      ),
    });
  });

  it("409s when the fenced payment write matches nothing (an invoice or group settlement landed between read and write)", async () => {
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(settle()).rejects.toMatchObject({ status: 409 });
  });

  it("the fenced write re-asserts EVERY expressible refusal condition, including the settled-from statuses, refund history, the transaction-stamped drift shape and organiserSettled", async () => {
    await settle();

    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "payment-1",
          xeroInvoiceId: null,
          xeroRefundCreditNoteId: null,
          manuallyMarkedPaidAt: null,
          // M6: only the documented settled-from statuses can flip to
          // SUCCEEDED. FAILED is deliberately included — a declined card
          // attempt is exactly what cash at the lodge remedies — while
          // SUCCEEDED / (PARTIALLY_)REFUNDED can never be clobbered.
          status: {
            in: [
              PaymentStatus.PENDING,
              PaymentStatus.PROCESSING,
              PaymentStatus.FAILED,
            ],
          },
          // L7: no refund history.
          refundedAmountCents: 0,
          transactions: { none: { xeroInvoiceId: { not: null } } },
          booking: { organiserSettled: false },
        },
      })
    );
  });

  it("L7 — refuses at read time when the payment already carries refund history", async () => {
    mocks.paymentFindUnique.mockResolvedValue(
      paymentRow({ refundedAmountCents: 2500 })
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/refund history/),
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });
});

describe("#2262 — the manual transaction mint", () => {
  it("EXCLUDES FAILED rows from the update predicate, so a reversal's row is never resurrected at a stale amount", async () => {
    await settle();

    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            notIn: [
              PaymentStatus.REFUNDED,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.FAILED,
            ],
          },
        }),
      })
    );
  });

  it("CREATES UNCONDITIONALLY on count 0 — it must NOT copy the inbound mint's existingPrimary fallback", async () => {
    // The reversed-then-re-marked shape: a FAILED IB PRIMARY row exists, so the
    // update matches nothing. Copying the inbound fallback would find that row
    // and mint nothing, leaving a PAID payment with NO settled transaction.
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 0 });

    await settle();

    expect(mocks.paymentTransactionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: "payment-1",
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        stripePaymentIntentId: null,
        amountCents: 10000,
        status: PaymentStatus.SUCCEEDED,
        reason: "manual_mark_paid",
      }),
    });
  });

  it("does not create a second row when an existing non-FAILED row was updated", async () => {
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 1 });

    await settle();

    expect(mocks.paymentTransactionCreate).not.toHaveBeenCalled();
  });
});

describe("#2262 guard 2 — Xero refusals", () => {
  const cases: Array<[string, () => void, RegExp]> = [
    [
      "a payment-level invoice id",
      () =>
        mocks.paymentFindUnique.mockResolvedValue(
          paymentRow({ xeroInvoiceId: "inv-1" })
        ),
      /outstanding Xero invoice/,
    ],
    [
      "a refund credit note",
      () =>
        mocks.paymentFindUnique.mockResolvedValue(
          paymentRow({ xeroRefundCreditNoteId: "cn-1" })
        ),
      /outstanding Xero invoice/,
    ],
    [
      "a transaction-level invoice id (the modeled drift shape)",
      () => mocks.paymentTransactionFindFirst.mockResolvedValue({ id: "txn-1" }),
      /outstanding Xero invoice/,
    ],
    [
      "an active PRIMARY_INVOICE object link",
      () => mocks.xeroObjectLinkFindFirst.mockResolvedValue({ id: "link-1" }),
      /outstanding Xero invoice/,
    ],
  ];

  for (const [label, prime, message] of cases) {
    it(`refuses when the payment carries ${label}`, async () => {
      prime();
      await expect(settle()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(message) });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    });
  }

  it("refuses when a CREATE-INVOICE outbox operation has already SUCCEEDED", async () => {
    mocks.xeroSyncOperationFindFirst.mockImplementation(
      async (args: { where: { status: unknown } }) =>
        args.where.status === "SUCCEEDED" ? { id: "op-1" } : null
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/outstanding Xero invoice/),
    });
  });

  it("refuses while a CREATE-INVOICE outbox operation is still IN FLIGHT", async () => {
    mocks.xeroSyncOperationFindFirst.mockImplementation(
      async (args: { where: { status: unknown } }) =>
        typeof args.where.status === "object" ? { id: "op-2" } : null
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already queued/),
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("pins the settle-time in-flight predicate: the op-status set is exactly PENDING/RUNNING/WAITING_PAYMENT (level 2 of the mint fence)", async () => {
    // H3 relies on this set: the operator retry CLAIMS its FAILED/PARTIAL row
    // to RUNNING before minting, precisely so this fence sees it. Narrowing
    // this set (or widening it silently) would re-open the settle-vs-mint race,
    // so the exact predicate is pinned.
    await settle();

    expect(mocks.xeroSyncOperationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: "payment-1",
          status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
        }),
      })
    );
  });

  it("refuses a payment that has already taken money, at READ time and with the truth", async () => {
    // #2397. A card capture that stranded before its status promotion (#1418:
    // confirm-pending-guests / cron-confirm-pending both commit the SUCCEEDED
    // ledger row in their own transaction and DELIBERATELY leave the booking
    // CONFIRMED when the promotion then fails) is the one production shape
    // where a payable booking holds a captured payment — and an upward
    // modification in that window is the only non-circular way such a booking
    // acquires an uncollected extra. Before this guard the whole dialog opened,
    // asked the admin whether the cash covered that extra, and then refused
    // every answer at the fence with "changed while you were recording it" —
    // which was false, and repeated on every retry.
    mocks.paymentFindUnique.mockResolvedValue(
      paymentRow({ status: "SUCCEEDED" })
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already taken money"),
    });
    expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "PROCESSING", "FAILED"])(
    "still settles from the ordinary unsettled shape %s (a declined card is exactly what cash remedies)",
    async (status) => {
      mocks.paymentFindUnique.mockResolvedValue(paymentRow({ status }));

      await expect(settle()).resolves.toMatchObject({ bookingId: "booking-1" });
      // The fenced write asserts the SAME list, so the two can never drift.
      expect(mocks.paymentUpdateMany.mock.calls[0][0]).toMatchObject({
        where: expect.objectContaining({
          status: { in: ["PENDING", "PROCESSING", "FAILED"] },
        }),
      });
    }
  );

  it("refuses a booking settled as part of a group booking", async () => {
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: unknown }) =>
      args.select ? { lodgeId: "lodge-1" } : bookingRow({ organiserSettled: true })
    );

    await expect(settle()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/group booking/),
    });
  });
});

describe("#2262 — Stripe intent hygiene", () => {
  it("enqueues a durable CANCEL_PAYMENT_INTENT for every live intent, in-transaction, and cancels best-effort AFTER commit", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      {
        id: "txn-live",
        stripePaymentIntentId: "pi_live",
        amountCents: 10000,
      },
    ]);

    const result = await settle();

    expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentId: "payment-1",
        paymentTransactionId: "txn-live",
        paymentIntentId: "pi_live",
        store: tx,
      })
    );
    expect(result.outstandingIntentIds).toEqual(["pi_live"]);
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_live");
  });

  it("#4320 — records which of its cancellations another writer had already queued, so the reversal leaves those", async () => {
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { id: "txn-live", kind: "PRIMARY", stripePaymentIntentId: "pi_live", amountCents: 10000 },
      { id: "txn-edit", kind: "PRIMARY", stripePaymentIntentId: "pi_edit", amountCents: 9000 },
    ]);
    // An edit queued pi_edit's cancellation before this settle.
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([{ paymentIntentId: "pi_edit" }]);

    await settle();

    expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: {
          in: ["payment_recovery_cancel_txn-live_pi_live", "payment_recovery_cancel_txn-edit_pi_edit"],
        },
      },
      select: { paymentIntentId: true },
    });
    // Read before either upsert, or the settle's own row would read as adopted.
    expect(mocks.paymentRecoveryOperationFindMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.enqueuePaymentIntentCancellationRecovery.mock.invocationCallOrder[0]!,
    );
    expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-payment.mark-paid",
        metadata: expect.objectContaining({
          cancelledPaymentIntentIds: ["pi_live", "pi_edit"],
          adoptedCancelPaymentIntentIds: ["pi_edit"],
        }),
      }),
      tx,
    );
  });

  it("#4320 — a settle with no live intent reads nothing and records that it adopted nothing", async () => {
    await settle();

    expect(mocks.paymentRecoveryOperationFindMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-payment.mark-paid",
        metadata: expect.objectContaining({ cancelledPaymentIntentIds: [], adoptedCancelPaymentIntentIds: [] }),
      }),
      tx,
    );
  });

  it("only considers non-terminal intents", async () => {
    await settle();

    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        }),
      })
    );
  });
});

describe("#2262 — audit trail", () => {
  it("writes the finance audit row inside the transaction, recording the email decision BOTH ways", async () => {
    await settle({ notifyMember: true });

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.manual-payment.mark-paid",
        actorMemberId: ADMIN_ID,
        category: "payment",
        severity: "important",
        metadata: expect.objectContaining({
          effectiveAmountCents: 10000,
          creditAppliedCents: 2000,
          hasXeroInvoiceLink: false,
          notifyMember: true,
        }),
      }),
      tx
    );
  });
});

describe("#2262 — the reversal (direction unpaid)", () => {
  function primeReversal(
    overrides: { payment?: Record<string, unknown> } = {}
  ) {
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: unknown }) =>
        args.select
          ? { lodgeId: "lodge-1" }
          : {
              ...bookingRow({ status: BookingStatus.PAID }),
              payment: {
                id: "payment-1",
                amountCents: 10000,
                refundedAmountCents: 0,
                xeroInvoiceId: null,
                xeroRefundCreditNoteId: null,
                internetBankingHoldSlots: false,
                internetBankingHoldUntil: null,
                manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
                manuallyMarkedPaidPreviousStatus: BookingStatus.PAYMENT_PENDING,
                ...overrides.payment,
              },
            }
    );
  }

  function reverse() {
    return reverseManualBookingPayment({
      bookingId: "booking-1",
      actingAdminMemberId: ADMIN_ID,
      note: null,
    });
  }

  /** The liveness predicate the reversal reads and deletes behind (#4320): every status but SUCCEEDED. */
  const LIVE_SUPERSEDED_WHERE = {
    type: {
      in: [
        PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
        PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
      ],
    },
    status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
  };

  /** A cancel row the settle queued for its live intent, as the reversal reads it. */
  function liveCancelOperation(overrides: Record<string, unknown> = {}) {
    return {
      id: "op-cancel",
      type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
      status: PaymentRecoveryOperationStatus.PENDING,
      paymentIntentId: "pi_live",
      paymentTransactionId: "txn-live",
      amountCents: 10000,
      idempotencyKey: "payment_recovery_cancel_txn-live_pi_live",
      attempts: 0,
      createdAt: new Date("2026-07-20T00:00:00Z"),
      ...overrides,
    };
  }

  type CardRow = {
    id: string;
    kind: PaymentTransactionKind;
    stripePaymentIntentId: string;
    amountCents: number;
    status?: PaymentStatus;
    reference?: string | null;
    withdrawnAt?: Date | null;
  };

  /** A reference filter as the saved-card attempt filters spell one (`reference`, `OR`, `NOT`). */
  type ReferenceClause = { reference?: null | { startsWith: string }; OR?: ReferenceClause[]; NOT?: ReferenceClause };
  function matchesReference(reference: string | null, clause: ReferenceClause): boolean {
    if (clause.OR) return clause.OR.some((each) => matchesReference(reference, each));
    if (clause.NOT) return !matchesReference(reference, clause.NOT);
    if (clause.reference === undefined) return true;
    if (clause.reference === null) return reference === null;
    return reference !== null && reference.startsWith(clause.reference.startsWith);
  }

  /**
   * #4320: the payment's card rows, answered through the filters the supersede
   * rules and the payable read put on them (kind, status, amount, intent, and
   * the saved-card attempt split on `reference`), so the reversal's derivation
   * is exercised rather than stubbed. The booking owes 10000 (12000 less the
   * suite's 2000 of applied credit) and is worth 12000. The newest-ask read
   * (`findFirst`, newest first) answers the LAST matching row.
   */
  function cardLedger(rows: CardRow[]) {
    type IdFilter = { not?: string | null; notIn?: string[] } | undefined;
    type AmountFilter = { gt?: number; not?: number } | undefined;
    mocks.enqueuePaymentIntentCancellationRecovery.mockImplementation(async (args: { paymentIntentId: string }) => ({ id: `op-${args.paymentIntentId}` }));
    const ledger = rows.map((row) => ({ status: PaymentStatus.PENDING, source: PaymentSource.STRIPE, reference: null, withdrawnAt: null, ...row }));
    mocks.paymentTransactionFindFirst.mockImplementation(
      async ({ where }: { where: { kind?: PaymentTransactionKind; source?: PaymentSource; withdrawnAt?: null } }) =>
        where.withdrawnAt === null
          ? ledger.filter((row) => row.kind === where.kind && row.source === where.source && row.withdrawnAt === null).at(-1) ?? null
          : null,
    );
    mocks.paymentTransactionFindMany.mockImplementation(
      async ({ where }: { where: { kind?: PaymentTransactionKind; source?: PaymentSource; status?: { in?: PaymentStatus[] }; stripePaymentIntentId?: IdFilter; amountCents?: AmountFilter; AND?: ReferenceClause[] } }) =>
        ledger
          .filter((row) => (where.AND ?? []).every((clause) => matchesReference(row.reference, clause)))
          .filter((row) => where.kind === undefined || row.kind === where.kind)
          .filter((row) => where.source === undefined || row.source === where.source)
          .filter((row) => !where.status?.in || where.status.in.includes(row.status))
          .filter((row) => {
            const id = where.stripePaymentIntentId;
            if (!id) return true;
            if (id.not !== undefined && id.not !== null && row.stripePaymentIntentId === id.not) return false;
            return !id.notIn?.includes(row.stripePaymentIntentId);
          })
          .filter((row) => {
            const amount = where.amountCents;
            if (!amount) return true;
            if (amount.gt !== undefined && !(row.amountCents > amount.gt)) return false;
            return amount.not === undefined || row.amountCents !== amount.not;
          }),
    );
  }

  /** The member's intent at the owed amount: the one the restored booking is paid with. */
  const PAYABLE_PRIMARY: CardRow = { id: "txn-live", kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_live", amountCents: 10000 };

  type RecoveryRead = { where: Record<string, unknown> };
  /** The withdrawal's reads of live rows on payable intents (both superseded-intent types). */
  function withdrawReads() {
    return mocks.paymentRecoveryOperationFindMany.mock.calls
      .map(([args]) => (args as RecoveryRead).where)
      .filter((where) => typeof where.type === "object");
  }
  /** The re-arm's reads of dead cancellations on condemned intents (#4320 F4). */
  function rearmReads() {
    return mocks.paymentRecoveryOperationFindMany.mock.calls
      .map(([args]) => (args as RecoveryRead).where)
      .filter((where) => where.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT);
  }

  it("#4211 — clears the recorded settler with the provenance, behind the same fence", async () => {
    primeReversal();
    await reverse();
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "payment-1", manuallyMarkedPaidAt: { not: null } }),
        data: expect.objectContaining({ settledByTransactionId: null, manuallyMarkedPaidAt: null }),
      }),
    );
  });

  // #4217 review: the Payment row before the recovery rows it deletes - the
  // order the recovery runner's claim hold takes (Payment, then the
  // cancellation rows it upserts) - and before the booking and ledger writes.
  it("MUTATION (#4217): locks the Payment row after the lodge key and before the recovery rows, the booking or the payment are read or written", async () => {
    primeReversal();
    cardLedger([PAYABLE_PRIMARY]);
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([liveCancelOperation()]);
    mocks.paymentRecoveryOperationDeleteMany.mockResolvedValue({ count: 1 });
    await reverse();

    expect(mocks.lockPaymentForRefundedTotal).toHaveBeenCalledWith(expect.anything(), "payment-1");
    const lockedAt = mocks.lockPaymentForRefundedTotal.mock.invocationCallOrder[0]!;
    expect(mocks.acquireLodgeCapacityLock.mock.invocationCallOrder[0]!).toBeLessThan(lockedAt);
    const fullBookingRead = mocks.bookingFindUnique.mock.calls.findIndex(([args]) => !(args as { select?: unknown }).select);
    expect(lockedAt).toBeLessThan(mocks.bookingFindUnique.mock.invocationCallOrder[fullBookingRead]!);
    expect(lockedAt).toBeLessThan(mocks.paymentRecoveryOperationFindMany.mock.invocationCallOrder[0]!);
    expect(lockedAt).toBeLessThan(mocks.paymentRecoveryOperationDeleteMany.mock.invocationCallOrder[0]!);
    expect(lockedAt).toBeLessThan(mocks.paymentUpdateMany.mock.invocationCallOrder[0]!);
  });

  it("#3581 — posts the booking ledger's reversal of the officer's cash line, copying it", async () => {
    primeReversal();
    (tx.bookingLedgerLine.createMany as unknown as Mock).mockClear();
    (tx.bookingLedgerLine.findMany as unknown as Mock).mockResolvedValueOnce([
      {
        id: "L-cash",
        postingKey: "capture:txn-manual",
        reversesLineId: null,
        kind: "CASH_RECORDED",
        sign: 1,
        quantity: 1,
        unitCents: 10000,
        anchorKind: "PAYMENT_TRANSACTION",
        anchorId: "txn-manual",
        settlementMethod: "CASH",
        narration: "Payment recorded by an officer",
      },
    ]);
    // After the flips: the row is FAILED and the provenance is cleared.
    answerSettlementSync({
      manuallyMarkedPaidAt: null,
      manuallyMarkedPaidByMemberId: null,
      transactions: [{ id: "txn-manual", source: "INTERNET_BANKING", status: "FAILED", amountCents: 10000 }],
    });
    await reverse();
    expect(ledgerRowsPosted()).toContainEqual(
      expect.objectContaining({
        kind: "CASH_RECORDED",
        settlementMethod: "CASH",
        sign: -1,
        amountCents: -10000,
        reversesLineId: "L-cash",
        postingKey: "reversal:L-cash",
      }),
    );
  });

  it("HIGH #1 — DELETES every live CANCEL_PAYMENT_INTENT / REFUND_SUPERSEDED_PAYMENT operation on a payable intent inside its own transaction, each behind the liveness fence", async () => {
    primeReversal();
    cardLedger([PAYABLE_PRIMARY]);
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([liveCancelOperation()]);
    mocks.paymentRecoveryOperationDeleteMany.mockResolvedValue({ count: 1 });

    const result = await reverse();

    // A DELETE, never a status flip: the webhook-side liveness predicates
    // (queueSupersededPaymentIntentRefundRecovery, listLiveSupersededIntentIds,
    // findLiveSupersededIntentOperation) all key on `status != SUCCEEDED`, so a
    // FAILED "closed" row would still hand a post-reversal capture to the
    // superseded-refund machinery and poison the duplicate-guard notIn
    // exclusion forever. Only deletion makes every predicate coherent.
    expect(mocks.paymentRecoveryOperationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: "payment-1", paymentIntentId: { in: ["pi_live"] }, ...LIVE_SUPERSEDED_WHERE } }),
    );
    expect(mocks.paymentRecoveryOperationDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentRecoveryOperationDeleteMany).toHaveBeenCalledWith({
      where: { id: "op-cancel", ...LIVE_SUPERSEDED_WHERE },
    });
    expect(mocks.paymentRecoveryOperationUpdateMany).not.toHaveBeenCalled();
    expect(result.closedRecoveryOperationIds).toEqual(["op-cancel"]);
    // The deleted rows' full content lives on in the AuditLog metadata.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          closedRecoveryOperationIds: ["op-cancel"],
          closedRecoveryOperations: [
            expect.objectContaining({
              id: "op-cancel",
              type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
              paymentIntentId: "pi_live",
              idempotencyKey: "payment_recovery_cancel_txn-live_pi_live",
            }),
          ],
        }),
      }),
      tx
    );
  });

  describe("#4320 — the reversal re-derives which intents stay cancelled, and withdraws the rest", () => {
    function settleAudit(metadata: Record<string, unknown>) {
      mocks.auditLogFindFirst.mockResolvedValue({ metadata });
    }

    function readScope() {
      return withdrawReads()[0]!;
    }

    function enqueuedIntents() {
      return mocks.enqueuePaymentIntentCancellationRecovery.mock.calls.map(([args]) => (args as { paymentIntentId: string }).paymentIntentId);
    }

    function auditMetadata() {
      return (mocks.createAuditLog.mock.calls.at(-1)![0] as { metadata: Record<string, unknown> }).metadata;
    }

    for (const [label, row] of [
      ["FAILED and still retrying", { status: PaymentRecoveryOperationStatus.FAILED, attempts: 1, nextRetryAt: new Date("2026-07-20T00:05:00Z") }],
      ["FAILED and exhausted at the ceiling", { status: PaymentRecoveryOperationStatus.FAILED, attempts: 5, nextRetryAt: null }],
    ] as const) {
      it(`withdraws the settle's cancel ${label} on the intent at the owed amount: the read and the delete both reach every status but SUCCEEDED`, async () => {
        primeReversal();
        cardLedger([PAYABLE_PRIMARY]);
        settleAudit({ cancelledPaymentIntentIds: ["pi_live"], adoptedCancelPaymentIntentIds: [] });
        mocks.paymentRecoveryOperationFindMany.mockResolvedValue([liveCancelOperation(row)]);
        mocks.paymentRecoveryOperationDeleteMany.mockResolvedValue({ count: 1 });

        const result = await reverse();

        expect(readScope()).toEqual({ paymentId: "payment-1", paymentIntentId: { in: ["pi_live"] }, ...LIVE_SUPERSEDED_WHERE });
        expect(mocks.paymentRecoveryOperationDeleteMany).toHaveBeenCalledWith({ where: { id: "op-cancel", ...LIVE_SUPERSEDED_WHERE } });
        expect(enqueuedIntents()).toEqual([]);
        expect(result.closedRecoveryOperationIds).toEqual(["op-cancel"]);
        expect(auditMetadata()).toMatchObject({
          closedRecoveryOperations: [expect.objectContaining({ id: "op-cancel", status: PaymentRecoveryOperationStatus.FAILED, attempts: row.attempts })],
          stillCancelledPaymentIntentIds: [],
        });
      });
    }

    it("MUTATION: a primary intent at another amount than the booking owes stays cancelled - its row is queued (an existing one kept), never withdrawn", async () => {
      // An edit on the PAID booking moved the price after the settle and
      // shared the settle's cancel row on the old intent.
      primeReversal();
      cardLedger([{ id: "txn-old", kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_old_price", amountCents: 8000 }]);
      settleAudit({ cancelledPaymentIntentIds: ["pi_old_price"], adoptedCancelPaymentIntentIds: [] });

      const result = await reverse();

      expect(enqueuedIntents()).toEqual(["pi_old_price"]);
      expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId: "payment-1", paymentTransactionId: "txn-old", paymentIntentId: "pi_old_price", store: tx }),
      );
      expect(withdrawReads()).toEqual([]);
      expect(mocks.paymentRecoveryOperationDeleteMany).not.toHaveBeenCalled();
      expect(result.closedRecoveryOperationIds).toEqual([]);
      expect(auditMetadata()).toMatchObject({ stillCancelledPaymentIntentIds: ["pi_old_price"] });
    });

    it("an additional intent that is not the payment's live ask stays cancelled; the live ask's intent is withdrawn", async () => {
      primeReversal({ payment: { additionalPaymentIntentId: "pi_ask_live" } });
      cardLedger([
        { id: "txn-ask-old", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask_old", amountCents: 3000 },
        { id: "txn-ask-live", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask_live", amountCents: 4000 },
      ]);

      await reverse();

      expect(enqueuedIntents()).toEqual(["pi_ask_old"]);
      expect(readScope()).toMatchObject({ paymentIntentId: { in: ["pi_ask_live"] } });
      expect(auditMetadata()).toMatchObject({ stillCancelledPaymentIntentIds: ["pi_ask_old"] });
    });

    it("with no live ask, every additional intent stays cancelled", async () => {
      primeReversal({ payment: { additionalPaymentIntentId: null } });
      cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);

      await reverse();

      expect(enqueuedIntents()).toEqual(["pi_ask"]);
      expect(withdrawReads()).toEqual([]);
    });

    it("an intent the settle adopted from another writer keeps its cancellation even at the owed amount (INV-PAY-138)", async () => {
      primeReversal();
      cardLedger([PAYABLE_PRIMARY, { id: "txn-settle", kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_settle", amountCents: 10000 }]);
      settleAudit({ cancelledPaymentIntentIds: ["pi_live", "pi_settle"], adoptedCancelPaymentIntentIds: ["pi_live"] });

      await reverse();

      expect(readScope()).toMatchObject({ paymentIntentId: { in: ["pi_settle"] } });
      expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ stripePaymentIntentId: { not: null, notIn: ["pi_live"] } }) }),
      );
    });

    for (const [label, audit] of [
      ["a settle row written before #4320 (no adopted list)", { metadata: { cancelledPaymentIntentIds: ["pi_live"] } }],
      ["no settle row at all", null],
      ["a settle row whose adopted list is not a list of ids", { metadata: { adoptedCancelPaymentIntentIds: "pi_live" } }],
    ] as const) {
      it(`${label} adopts nothing: the intent at the owed amount is withdrawn, a stale one still cancelled`, async () => {
        primeReversal();
        cardLedger([PAYABLE_PRIMARY, { id: "txn-old", kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_old_price", amountCents: 8000 }]);
        mocks.auditLogFindFirst.mockResolvedValue(audit);

        await reverse();

        expect(enqueuedIntents()).toEqual(["pi_old_price"]);
        expect(readScope()).toEqual({ paymentId: "payment-1", paymentIntentId: { in: ["pi_live"] }, ...LIVE_SUPERSEDED_WHERE });
      });
    }

    it("a row on an intent the ledger already retired is never read for withdrawal", async () => {
      primeReversal();
      cardLedger([{ ...PAYABLE_PRIMARY, status: PaymentStatus.FAILED }]);

      await reverse();

      expect(withdrawReads()).toEqual([]);
      expect(mocks.paymentRecoveryOperationDeleteMany).not.toHaveBeenCalled();
    });

    it("a booking credit covers in full: every positive primary intent stays cancelled", async () => {
      primeReversal();
      mocks.deriveBookingAppliedCreditCents.mockResolvedValue(12000);
      cardLedger([PAYABLE_PRIMARY]);

      await reverse();

      expect(enqueuedIntents()).toEqual(["pi_live"]);
      expect(withdrawReads()).toEqual([]);
    });

    it("a row a worker finished between the read and the delete is left alone and not reported closed", async () => {
      primeReversal();
      cardLedger([PAYABLE_PRIMARY, { id: "txn-done", kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_done", amountCents: 10000 }]);
      mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
        liveCancelOperation(),
        liveCancelOperation({ id: "op-done", paymentIntentId: "pi_done", idempotencyKey: "payment_recovery_cancel_txn-done_pi_done" }),
      ]);
      mocks.paymentRecoveryOperationDeleteMany.mockImplementation(async ({ where }: { where: { id: string } }) => ({ count: where.id === "op-done" ? 0 : 1 }));

      const result = await reverse();

      expect(mocks.paymentRecoveryOperationDeleteMany).toHaveBeenCalledTimes(2);
      expect(result.closedRecoveryOperationIds).toEqual(["op-cancel"]);
      expect(auditMetadata()).toMatchObject({
        closedRecoveryOperationIds: ["op-cancel"],
        closedRecoveryOperations: [expect.objectContaining({ id: "op-cancel" })],
      });
    });

    describe("F2: a covering settle's rebuild nulled the live-ask pointer", () => {
      const RESTORED_EXTRA = { settledAdditionalAmountCents: 3000, previousAdditionalPaymentStatus: "PENDING" };

      it("MUTATION: the newest card ask at the restored extra is the live ask, so its cancellation is withdrawn", async () => {
        primeReversal({ payment: { additionalPaymentIntentId: null } });
        cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);
        settleAudit(RESTORED_EXTRA);

        const result = await reverse();

        expect(result.restoredAdditionalAmountCents).toBe(3000);
        expect(mocks.paymentTransactionFindFirst).toHaveBeenCalledWith({
          where: { paymentId: "payment-1", kind: PaymentTransactionKind.ADDITIONAL, source: PaymentSource.STRIPE, withdrawnAt: null },
          orderBy: [{ createdAt: "desc" }, { insertionSeq: "desc" }],
          select: { stripePaymentIntentId: true, amountCents: true, status: true },
        });
        expect(enqueuedIntents()).toEqual([]);
        expect(readScope()).toMatchObject({ paymentIntentId: { in: ["pi_ask"] } });
        expect(auditMetadata()).toMatchObject({ stillCancelledPaymentIntentIds: [] });
      });

      /** The reversal's stamp of its own cash row (#4355), as it writes it. */
      const STAMP_REVERSED_CASH_ROW = {
        where: {
          paymentId: "payment-1",
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.INTERNET_BANKING,
          status: PaymentStatus.FAILED,
          reason: "manual_mark_paid_additional_reversed",
          withdrawnAt: null,
        },
        data: { withdrawnAt: expect.any(Date) },
      };
      function stampWrites() {
        return mocks.paymentTransactionUpdateMany.mock.calls.filter(
          ([args]) => (args as { data: Record<string, unknown> }).data.withdrawnAt !== undefined,
        );
      }
      function pointerWrites() {
        return mocks.paymentUpdateMany.mock.calls.filter(
          ([args]) => (args as { data: Record<string, unknown> }).data.additionalPaymentIntentId !== undefined,
        );
      }

      it("MUTATION (#4355): the reversed cash row is stamped withdrawn and the pointer put back, so a rebuild after the member pays the ask reads it SUCCEEDED", async () => {
        primeReversal({ payment: { additionalPaymentIntentId: null } });
        cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);
        settleAudit(RESTORED_EXTRA);

        await reverse();

        expect(stampWrites()).toEqual([[STAMP_REVERSED_CASH_ROW]]);
        expect(pointerWrites()).toEqual([
          [{ where: { id: "payment-1", additionalPaymentIntentId: null }, data: { additionalPaymentIntentId: "pi_ask" } }],
        ]);
        // After the cash row was flipped FAILED, never before it.
        const flip = mocks.paymentTransactionUpdateMany.mock.calls.findIndex(
          ([args]) => (args as { data: { reason?: string } }).data.reason === "manual_mark_paid_additional_reversed",
        );
        const stamp = mocks.paymentTransactionUpdateMany.mock.calls.findIndex(
          ([args]) => (args as { data: Record<string, unknown> }).data.withdrawnAt !== undefined,
        );
        expect(flip).toBeGreaterThanOrEqual(0);
        expect(stamp).toBeGreaterThan(flip);
        expect(auditMetadata()).toMatchObject({ restoredAdditionalPaymentIntentId: "pi_ask" });
      });

      it("a pointer that still names the ask is kept; the cash row is still stamped", async () => {
        primeReversal({ payment: { additionalPaymentIntentId: "pi_ask" } });
        cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);
        settleAudit(RESTORED_EXTRA);

        await reverse();

        expect(stampWrites()).toEqual([[STAMP_REVERSED_CASH_ROW]]);
        expect(auditMetadata()).toMatchObject({ restoredAdditionalPaymentIntentId: "pi_ask" });
      });

      for (const [label, prime] of [
        [
          "with no live ask (the newest card ask is at another figure)",
          () => cardLedger([{ id: "txn-new", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_new", amountCents: 4500 }]),
        ],
        ["with no card ask at all", () => cardLedger([])],
        [
          "when the newest card ask's intent is no longer open (FAILED: declined, or cancelled at Stripe)",
          () =>
            cardLedger([
              { id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000, status: PaymentStatus.FAILED },
            ]),
        ],
        [
          "when the extra was not put back (a writer settled it since)",
          () => {
            cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);
            mocks.paymentUpdateMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => ({
              count: "additionalPaymentStatus" in where ? 0 : 1,
            }));
          },
        ],
      ] as const) {
        it(`${label}, the cash row stays the mirror's anchor: nothing is stamped and the pointer is not written`, async () => {
          primeReversal({ payment: { additionalPaymentIntentId: null } });
          prime();
          settleAudit(RESTORED_EXTRA);

          await reverse();

          expect(stampWrites()).toEqual([]);
          expect(pointerWrites()).toEqual([]);
          expect(auditMetadata()).toMatchObject({ restoredAdditionalPaymentIntentId: null });
        });
      }

      for (const pointer of [null, "pi_ask"] as const) {
        it(`MUTATION (F1): an ask whose cancellation the settle adopted stays cancelled, so the pointer is not put back to it (pointer ${pointer ?? "null"})`, async () => {
          primeReversal({ payment: { additionalPaymentIntentId: pointer } });
          cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);
          settleAudit({ ...RESTORED_EXTRA, adoptedCancelPaymentIntentIds: ["pi_ask"] });

          await reverse();

          expect(withdrawReads()).toEqual([]);
          expect(stampWrites()).toEqual([]);
          expect(pointerWrites()).toEqual([]);
          expect(auditMetadata()).toMatchObject({ stillCancelledPaymentIntentIds: ["pi_ask"], restoredAdditionalPaymentIntentId: null });
        });
      }

      it("reads past an ask an officer withdrew, as the mirror does", async () => {
        primeReversal({ payment: { additionalPaymentIntentId: null } });
        cardLedger([
          { id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 },
          { id: "txn-withdrawn", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_withdrawn", amountCents: 3000, withdrawnAt: new Date("2026-07-19T00:00:00Z") },
        ]);
        settleAudit(RESTORED_EXTRA);

        await reverse();

        expect(enqueuedIntents()).toEqual(["pi_withdrawn"]);
        expect(readScope()).toMatchObject({ paymentIntentId: { in: ["pi_ask"] } });
      });

      it("a newest card ask at another figure is no live ask: every card ask stays cancelled", async () => {
        primeReversal({ payment: { additionalPaymentIntentId: null } });
        cardLedger([
          { id: "txn-old", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_old", amountCents: 3000 },
          { id: "txn-new", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_new", amountCents: 4500 },
        ]);
        settleAudit(RESTORED_EXTRA);

        await reverse();

        expect(enqueuedIntents()).toEqual(["pi_old", "pi_new"]);
        expect(withdrawReads()).toEqual([]);
      });

      it("an extra the reversal did not put back (a writer settled it since) leaves the null pointer null", async () => {
        primeReversal({ payment: { additionalPaymentIntentId: null } });
        cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);
        settleAudit(RESTORED_EXTRA);
        mocks.paymentUpdateMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => ({
          count: "additionalPaymentStatus" in where ? 0 : 1,
        }));

        const result = await reverse();

        expect(result.restoredAdditionalAmountCents).toBeNull();
        expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ withdrawnAt: null }) }),
        );
        expect(enqueuedIntents()).toEqual(["pi_ask"]);
      });

      it("a pointer that is set wins: the ledger is not read", async () => {
        primeReversal({ payment: { additionalPaymentIntentId: "pi_ask" } });
        cardLedger([{ id: "txn-ask", kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_ask", amountCents: 3000 }]);
        settleAudit(RESTORED_EXTRA);

        await reverse();

        expect(mocks.paymentTransactionFindFirst).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ withdrawnAt: null }) }),
        );
        expect(readScope()).toMatchObject({ paymentIntentId: { in: ["pi_ask"] } });
      });
    });

    describe("F3: a saved-card charge attempt is judged against the booking's worth, the figure the cron charges and the capture path accepts", () => {
      const attempt = (id: string, amountCents: number): CardRow => ({
        id,
        kind: PaymentTransactionKind.PRIMARY,
        stripePaymentIntentId: `pi_${id}`,
        amountCents,
        reference: `pending_charge_booking-1_${id}`,
      });

      it("MUTATION: an attempt at the booking's worth (12000, not the 10000 owed) keeps no cancellation; a link intent at the worth does", async () => {
        primeReversal();
        cardLedger([attempt("txn-attempt", 12000), { id: "txn-link", kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_link", amountCents: 12000 }]);

        await reverse();

        expect(enqueuedIntents()).toEqual(["pi_link"]);
        expect(readScope()).toMatchObject({ paymentIntentId: { in: ["pi_txn-attempt"] } });
        expect(auditMetadata()).toMatchObject({ stillCancelledPaymentIntentIds: ["pi_link"] });
      });

      it("an attempt at another figure than the worth stays cancelled, and so does one at the owed amount", async () => {
        primeReversal();
        cardLedger([attempt("txn-stale", 9000), attempt("txn-owed", 10000), PAYABLE_PRIMARY]);

        await reverse();

        expect(enqueuedIntents()).toEqual(["pi_txn-stale", "pi_txn-owed"]);
        expect(readScope()).toMatchObject({ paymentIntentId: { in: ["pi_live"] } });
      });

      it("splits the rows by the shared attempt filters, the owed amount for the rest and the worth for the attempts", async () => {
        primeReversal();
        cardLedger([]);

        await reverse();

        const primaryReads = mocks.paymentTransactionFindMany.mock.calls
          .map(([args]) => (args as { where: Record<string, unknown> }).where)
          .filter((where) => where.kind === PaymentTransactionKind.PRIMARY);
        expect(primaryReads).toEqual([
          expect.objectContaining({ amountCents: { gt: 0, not: 10000 }, AND: [NOT_SAVED_CARD_CHARGE_ATTEMPT_ROW_WHERE] }),
          expect.objectContaining({ amountCents: { gt: 0, not: 12000 }, AND: [SAVED_CARD_CHARGE_ATTEMPT_ROW_WHERE] }),
        ]);
      });
    });

    describe("F4: a cancellation the reversal leaves standing, and the runner will not finish, is re-armed", () => {
      const STALE: CardRow = { id: "txn-old", kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_old_price", amountCents: 8000 };
      /** Given up (PENDING or FAILED at the ceiling), or held by a worker on its last attempt. */
      const WILL_NOT_FINISH = {
        type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
        OR: [
          PAYMENT_RECOVERY_EXHAUSTED_WHERE,
          { status: PaymentRecoveryOperationStatus.PROCESSING, attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS } },
        ],
      };

      type QueueRow = { id: string; paymentIntentId: string; status: PaymentRecoveryOperationStatus; attempts: number };
      type StatusClause = { status: string | { in: readonly string[] }; attempts: { gte: number } };
      /**
       * The cancel queue, answered through the re-arm's own filter (intent,
       * then any OR clause on status and attempts), so the predicate is
       * exercised rather than echoed. Every other read finds nothing.
       */
      function cancelQueue(rows: QueueRow[]) {
        const matches = (row: QueueRow, clause: StatusClause) =>
          (typeof clause.status === "string" ? row.status === clause.status : clause.status.in.includes(row.status)) &&
          row.attempts >= clause.attempts.gte;
        mocks.paymentRecoveryOperationFindMany.mockImplementation(
          async ({ where }: { where: { type?: unknown; paymentIntentId?: { in: string[] }; OR?: StatusClause[] } }) =>
            where.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT
              ? rows
                  .filter((row) => where.paymentIntentId!.in.includes(row.paymentIntentId))
                  .filter((row) => where.OR!.some((clause) => matches(row, clause)))
                  .map(({ id }) => ({ id }))
              : [],
        );
        mocks.paymentRecoveryOperationUpdateMany.mockResolvedValue({ count: 1 });
      }

      for (const [label, status, attempts, rearmedExpected] of [
        ["FAILED at the attempt ceiling (given up)", PaymentRecoveryOperationStatus.FAILED, 5, true],
        ["PENDING at the attempt ceiling", PaymentRecoveryOperationStatus.PENDING, 5, true],
        ["PROCESSING on its last attempt", PaymentRecoveryOperationStatus.PROCESSING, 5, true],
        ["PROCESSING with attempts left", PaymentRecoveryOperationStatus.PROCESSING, 3, false],
        ["FAILED and still retrying", PaymentRecoveryOperationStatus.FAILED, 2, false],
        ["PENDING and due", PaymentRecoveryOperationStatus.PENDING, 0, false],
      ] as const) {
        it(`MUTATION: a cancellation ${label} on a condemned intent is ${rearmedExpected ? "" : "not "}re-armed`, async () => {
          primeReversal();
          cardLedger([STALE]);
          cancelQueue([{ id: "op-1", paymentIntentId: "pi_old_price", status, attempts }]);

          await reverse();

          expect(auditMetadata()).toMatchObject({ rearmedRecoveryOperationIds: rearmedExpected ? ["op-1"] : [] });
        });
      }

      it("MUTATION (F3): an intent the settle adopted keeps its cancellation, and a dead one is re-armed and recorded", async () => {
        primeReversal();
        // At the owed amount, so no rule condemns it; the settle found its
        // cancellation already queued by another writer.
        cardLedger([PAYABLE_PRIMARY]);
        settleAudit({ cancelledPaymentIntentIds: ["pi_live"], adoptedCancelPaymentIntentIds: ["pi_live"] });
        cancelQueue([{ id: "op-adopted", paymentIntentId: "pi_live", status: PaymentRecoveryOperationStatus.FAILED, attempts: 5 }]);

        await reverse();

        expect(rearmReads()).toEqual([{ paymentId: "payment-1", paymentIntentId: { in: ["pi_live"] }, ...WILL_NOT_FINISH }]);
        expect(withdrawReads()).toEqual([]);
        expect(mocks.paymentRecoveryOperationDeleteMany).not.toHaveBeenCalled();
        expect(auditMetadata()).toMatchObject({
          stillCancelledPaymentIntentIds: ["pi_live"],
          rearmedRecoveryOperationIds: ["op-adopted"],
        });
      });

      it("MUTATION: re-arms an exhausted cancel on a condemned intent, fenced, and records it", async () => {
        primeReversal();
        cardLedger([STALE]);
        mocks.paymentRecoveryOperationFindMany.mockImplementation(async ({ where }: RecoveryRead) =>
          where.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT ? [{ id: "op-dead" }] : [],
        );
        mocks.paymentRecoveryOperationUpdateMany.mockResolvedValue({ count: 1 });

        const result = await reverse();

        expect(rearmReads()).toEqual([{ paymentId: "payment-1", paymentIntentId: { in: ["pi_old_price"] }, ...WILL_NOT_FINISH }]);
        expect(mocks.paymentRecoveryOperationUpdateMany).toHaveBeenCalledWith({
          where: { id: "op-dead", ...WILL_NOT_FINISH },
          data: {
            status: PaymentRecoveryOperationStatus.PENDING,
            attempts: 0,
            nextRetryAt: new Date("2026-07-01T00:00:00.000Z"),
            lastError: null,
            processingStartedAt: null,
            succeededAt: null,
          },
        });
        expect(result.closedRecoveryOperationIds).toEqual([]);
        expect(auditMetadata()).toMatchObject({ stillCancelledPaymentIntentIds: ["pi_old_price"], rearmedRecoveryOperationIds: ["op-dead"] });
      });

      it("a row a worker reopened or finished between the read and the write is not reported re-armed", async () => {
        primeReversal();
        cardLedger([STALE]);
        mocks.paymentRecoveryOperationFindMany.mockImplementation(async ({ where }: RecoveryRead) =>
          where.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT ? [{ id: "op-dead" }] : [],
        );
        mocks.paymentRecoveryOperationUpdateMany.mockResolvedValue({ count: 0 });

        await reverse();

        expect(auditMetadata()).toMatchObject({ rearmedRecoveryOperationIds: [] });
      });

      it("with nothing condemned, nothing is read for re-arming", async () => {
        primeReversal();
        cardLedger([PAYABLE_PRIMARY]);

        await reverse();

        expect(rearmReads()).toEqual([]);
        expect(mocks.paymentRecoveryOperationUpdateMany).not.toHaveBeenCalled();
        expect(auditMetadata()).toMatchObject({ rearmedRecoveryOperationIds: [] });
      });
    });
  });

  it("M3 — a member-owed superseded-refund operation SURVIVES: its settled transaction 409s the reversal before the disarm is reached", async () => {
    // The handoff that creates a REFUND_SUPERSEDED_PAYMENT op marks its
    // transaction SUCCEEDED first, so any payment carrying such an op also
    // carries a settled Stripe transaction — which this fence refuses on.
    // The disarm can therefore never delete money the machinery owes back.
    primeReversal();
    mocks.paymentTransactionFindFirst.mockImplementation(
      async (args: { where: { source?: unknown } }) =>
        args.where.source === PaymentSource.STRIPE
          ? { id: "txn-superseded-late-capture" }
          : null
    );
    mocks.paymentRecoveryOperationFindMany.mockResolvedValue([
      {
        id: "op-refund",
        type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        paymentIntentId: "pi_superseded",
        paymentTransactionId: "txn-superseded-late-capture",
        amountCents: 10000,
        idempotencyKey: "payment_recovery_refund_txn_pi",
        attempts: 0,
        createdAt: new Date("2026-07-20T00:00:00Z"),
      },
    ]);

    await expect(reverse()).rejects.toMatchObject({ status: 409 });
    expect(mocks.paymentRecoveryOperationDeleteMany).not.toHaveBeenCalled();
  });

  it("M2 — after a reversal's delete, a re-mark re-arms the cancel op through the enqueue upsert's CREATE arm", async () => {
    // The reversal DELETED the settle's cancel op, so the re-mark's enqueue
    // upsert finds no row on the idempotency key and its create arm fires
    // fresh (PENDING, nextRetryAt now) — the durable cancel hygiene survives
    // mark -> reverse -> re-mark. Pinned against the real
    // enqueuePaymentIntentCancellationRecovery in payment-recovery.test.ts;
    // here we pin that the settle path calls it for every live intent even
    // when a previous settle-and-reverse cycle already happened.
    mocks.paymentTransactionFindMany.mockResolvedValue([
      { id: "txn-live", stripePaymentIntentId: "pi_live", amountCents: 10000 },
    ]);
    // Reversed-then-re-marked mint shape: the FAILED row blocks the update arm.
    mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 0 });

    const result = await settle();

    expect(mocks.enqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_live", store: tx })
    );
    expect(result.outstandingIntentIds).toEqual(["pi_live"]);
  });

  it("is idempotent: a replayed reversal closes nothing and 409s on its own fenced write", async () => {
    primeReversal();
    mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(reverse()).rejects.toMatchObject({ status: 409 });
  });

  it("restores a stored DRAFT as PAYMENT_PENDING (draftExpiresAt was cleared by the PAID claim, so there is nothing to restore)", async () => {
    primeReversal({
      payment: { manuallyMarkedPaidPreviousStatus: BookingStatus.DRAFT },
    });

    const result = await reverse();

    expect(result.restoredStatus).toBe(BookingStatus.PAYMENT_PENDING);
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", status: BookingStatus.PAID },
      data: { status: BookingStatus.PAYMENT_PENDING },
    });
  });

  it("clears a restored CONFIRMED internet-banking hold deadline, so the expiry cron cannot auto-cancel the booking minutes later", async () => {
    primeReversal({
      payment: {
        manuallyMarkedPaidPreviousStatus: BookingStatus.CONFIRMED,
        internetBankingHoldSlots: true,
        internetBankingHoldUntil: new Date("2026-07-01T00:00:00Z"),
      },
    });

    const result = await reverse();

    expect(result.clearedInternetBankingHold).toBe(true);
    expect(mocks.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ internetBankingHoldUntil: null }),
      })
    );
  });

  it("marks the manual transaction FAILED rather than deleting it, so history is preserved and the mint never resurrects it", async () => {
    primeReversal();

    await reverse();

    expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        kind: PaymentTransactionKind.PRIMARY,
        source: PaymentSource.INTERNET_BANKING,
        status: PaymentStatus.SUCCEEDED,
      },
      data: {
        status: PaymentStatus.FAILED,
        reason: "manual_mark_paid_reversed",
      },
    });
  });

  it("refuses when a card payment has since settled the booking", async () => {
    primeReversal();
    mocks.paymentTransactionFindFirst.mockImplementation(
      async (args: { where: { source?: unknown } }) =>
        args.where.source === PaymentSource.STRIPE ? { id: "txn-stripe" } : null
    );

    await expect(reverse()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/card payment has since settled/),
    });
  });

  it("refuses while an open manual refund task exists", async () => {
    primeReversal();
    mocks.manualRefundTaskFindFirst.mockResolvedValue({ id: "task-1" });

    await expect(reverse()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/open manual refund task/),
    });
  });

  it("refuses when a Xero invoice has been acquired since the settle", async () => {
    primeReversal();
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({ id: "link-1" });

    await expect(reverse()).rejects.toBeInstanceOf(ManualBookingPaymentError);
  });

  it("refuses a payment that was never manually settled", async () => {
    primeReversal({ payment: { manuallyMarkedPaidAt: null } });

    await expect(reverse()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Only a manually recorded payment/),
    });
  });
});

describe("#2262 door 3 — a stored credit election (#2265) is never silently stranded", () => {
  const UNAPPLIED_ACTION = "booking.credit_election.unapplied";
  const MARK_PAID_ACTION = "booking-payment.manual-payment.mark-paid";

  /**
   * The settle-shaped booking read, carrying a stored, unconsumed election.
   *
   * An unconsumed election means the election applied NOTHING, so the booking's
   * price is entirely uncovered: applied credit 0, and the settlement takes the
   * whole `finalPriceCents`. The suite-wide fixture (2000c of already-applied
   * credit) describes a different booking, and baking it in here would have the
   * reporter claiming a paid amount no election-carrying booking can produce.
   */
  function primeSettleWithElection(electionCents: number | null = 4500) {
    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: unknown }) =>
        args.select
          ? { lodgeId: "lodge-1" }
          : bookingRow({ creditElectionCents: electionCents })
    );
  }

  /** The settle call for an election-carrying booking: nothing is pre-covered. */
  function settleFullPrice() {
    return settle({ expectedAmountCents: 12000 });
  }

  /** The reversal-shaped booking read (mirrors the sibling describe's helper). */
  function primeReversalRead() {
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: unknown }) =>
        args.select
          ? { lodgeId: "lodge-1" }
          : {
              ...bookingRow({
                status: BookingStatus.PAID,
                creditElectionCents: null,
              }),
              payment: {
                id: "payment-1",
                amountCents: 12000,
                refundedAmountCents: 0,
                xeroInvoiceId: null,
                xeroRefundCreditNoteId: null,
                internetBankingHoldSlots: false,
                internetBankingHoldUntil: null,
                manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
                manuallyMarkedPaidPreviousStatus: BookingStatus.PAYMENT_PENDING,
              },
            }
    );
  }

  /**
   * The mark-paid audit row the reversal reads back, as the settle wrote it.
   * `clearedCreditElectionCents: null` is the shape of a settle that cleared
   * nothing at all.
   */
  function primeStoredSettleAudit(clearedCreditElectionCents: number | null) {
    mocks.auditLogFindFirst.mockResolvedValue({
      metadata: { clearedCreditElectionCents },
    });
  }

  function unappliedAuditCalls() {
    return mocks.createAuditLog.mock.calls.filter(
      (call) => (call[0] as { action?: string })?.action === UNAPPLIED_ACTION
    );
  }

  function markUnpaidAuditMetadata() {
    const call = mocks.createAuditLog.mock.calls.find(
      (entry) =>
        (entry[0] as { action?: string })?.action ===
        "booking-payment.manual-payment.mark-unpaid"
    );
    return (call?.[0] as { metadata?: Record<string, unknown> })?.metadata ?? {};
  }

  /** Every write's data payload that touches the election column. */
  function electionWritePayloads() {
    return [
      ...mocks.bookingUpdateMany.mock.calls,
      ...mocks.paymentUpdateMany.mock.calls,
    ]
      .map((call) => (call[0] as { data?: Record<string, unknown> })?.data ?? {})
      .filter((data) => "creditElectionCents" in data);
  }

  /** The election value a reversal actually wrote back, read off its own write. */
  function restoredElectionFromReversalWrite(): number | null {
    const write = mocks.bookingUpdateMany.mock.calls
      .map(
        (call) =>
          call[0] as {
            where?: Record<string, unknown>;
            data?: Record<string, unknown>;
          }
      )
      .find(
        (args) =>
          args.data != null &&
          "creditElectionCents" in args.data &&
          args.data.creditElectionCents != null
      );
    return (write?.data?.creditElectionCents as number | undefined) ?? null;
  }

  function reverse() {
    return reverseManualBookingPayment({
      bookingId: "booking-1",
      actingAdminMemberId: ADMIN_ID,
      note: null,
    });
  }

  beforeEach(() => {
    vi.mocked(sendAdminPaymentFailureAlert).mockResolvedValue(
      undefined as never
    );
  });

  it("CLEARS the election with the guarded claim, audits it on the mark-paid row, and reports the honest member-visible copy", async () => {
    primeSettleWithElection(4500);
    // The member still holds the whole balance they elected.
    mocks.getMemberCreditBalance.mockResolvedValue(4500);

    const result = await settleFullPrice();

    // The guarded claim — the exact amount that was read moves to NULL, the
    // same discipline every #2319 door uses, so a consumer racing this settle
    // is never clobbered.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", creditElectionCents: 4500 },
      data: { creditElectionCents: null },
    });

    // The cleared cents ride the mark-paid audit row's own metadata — the
    // record the REVERSAL reads back to restore the member's election.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: MARK_PAID_ACTION,
        metadata: expect.objectContaining({
          clearedCreditElectionCents: 4500,
        }),
      }),
      expect.anything()
    );

    // ...and the shared #2319 reporter writes the member-visible row: the
    // booking history renders this exact action as "your credit was not used
    // and your balance was not reduced". `paidAmountCents` is the whole price,
    // because an unconsumed election covered nothing.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: UNAPPLIED_ACTION,
        entityId: "booking-1",
        subjectMemberId: "member-1",
        metadata: expect.objectContaining({
          source: "manual-mark-paid",
          creditElectionCents: 4500,
          paidAmountCents: 12000,
          availableCreditCents: 4500,
          refundableCents: 4500,
          paymentId: "payment-1",
          actingAdminMemberId: ADMIN_ID,
        }),
      })
    );

    // The operator alert says the balance is untouched — cash collected outside
    // the app means the member's credit was NOT spent — and, this door having
    // neither a Stripe intent nor a Xero invoice, references the booking id.
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4500,
        paymentIntentId: "booking-1",
        errorMessage: expect.stringContaining("never debited"),
      }), CLUB_FORMAT_TEST
    );

    expect(result.staleCreditElectionCents).toBe(4500);
  });

  it("reports the member's answer BEFORE the un-caught booking-event write, so a post-commit throw cannot lose it", async () => {
    // Delta LOW-a. Everything after the commit is best-effort, but not equally
    // recoverable: `recordBookingEvent` is awaited un-caught, so a throw there
    // abandons the rest of the function — and the reporter's row is the ONLY
    // place the member is ever told their credit was not spent. The event is an
    // internal timeline fact an operator can reconstruct from the audit log.
    primeSettleWithElection(4500);
    const order: string[] = [];
    mocks.createAuditLog.mockImplementation(
      async (entry: { action?: string }) => {
        if (entry?.action === UNAPPLIED_ACTION) order.push("member-report");
      }
    );
    mocks.recordBookingEvent.mockImplementation(async () => {
      order.push("booking-event");
    });

    await settleFullPrice();

    expect(order).toEqual(["member-report", "booking-event"]);
  });

  it("does nothing and reports nothing when the booking carries no election — the overwhelmingly common case", async () => {
    const result = await settle();

    expect(electionWritePayloads()).toEqual([]);
    expect(unappliedAuditCalls()).toEqual([]);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).not.toHaveBeenCalled();
    expect(result.staleCreditElectionCents).toBeNull();
  });

  it("reports nothing when the guarded claim is lost — a racing consumer already owns the election", async () => {
    primeSettleWithElection(4500);
    mocks.bookingUpdateMany.mockImplementation(
      async (args: { data?: Record<string, unknown> }) =>
        args.data && "creditElectionCents" in args.data
          ? { count: 0 }
          : { count: 1 }
    );

    const result = await settleFullPrice();

    expect(unappliedAuditCalls()).toEqual([]);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).not.toHaveBeenCalled();
    expect(result.staleCreditElectionCents).toBeNull();

    // And the AUDIT ROW must say so too. A racing consumer spent the credit on
    // this very booking, so a mark-paid row claiming cents were cleared here
    // would be a false money trail — and, worse, the reversal reads that key
    // back to decide what to restore, so a lie here resurrects an election the
    // member already spent.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: MARK_PAID_ACTION,
        metadata: expect.objectContaining({ clearedCreditElectionCents: null }),
      }),
      expect.anything()
    );
  });

  it("the reversal RESTORES exactly the election the matching settle cleared, under a null-guard", async () => {
    primeReversalRead();
    primeStoredSettleAudit(4500);

    const reversal = await reverse();

    // Read back from the settle's own audit row — not guessed, not recomputed.
    expect(mocks.auditLogFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: MARK_PAID_ACTION,
          entityType: "Payment",
          entityId: "payment-1",
        }),
        orderBy: { createdAt: "desc" },
      })
    );
    // Guarded write: only onto a column that is still NULL, so a legitimate
    // writer that has set an election since is never clobbered.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", creditElectionCents: null },
      data: { creditElectionCents: 4500 },
    });
    expect(reversal.restoredCreditElectionCents).toBe(4500);
    expect(markUnpaidAuditMetadata()).toMatchObject({
      restoredCreditElectionCents: 4500,
      settleClearedCreditElectionCents: 4500,
    });
  });

  it("the reversal writes nothing when the settle cleared no election", async () => {
    primeReversalRead();
    primeStoredSettleAudit(null);

    const reversal = await reverse();

    expect(electionWritePayloads()).toEqual([]);
    expect(reversal.restoredCreditElectionCents).toBeNull();
    expect(markUnpaidAuditMetadata()).toMatchObject({
      restoredCreditElectionCents: null,
      settleClearedCreditElectionCents: null,
    });
  });

  it("the reversal does NOT clobber an election a legitimate writer has set since — the guard loses and says so", async () => {
    primeReversalRead();
    primeStoredSettleAudit(4500);
    // The restore is the only write whose data SETS the column to a number;
    // make exactly that one match no row, as a non-null column would.
    mocks.bookingUpdateMany.mockImplementation(
      async (args: { data?: Record<string, unknown> }) =>
        args.data?.creditElectionCents != null ? { count: 0 } : { count: 1 }
    );

    const reversal = await reverse();

    expect(reversal.restoredCreditElectionCents).toBeNull();
    // The settle's figure is still recorded, so the trail says what was cleared
    // AND that this reversal did not put it back.
    expect(markUnpaidAuditMetadata()).toMatchObject({
      restoredCreditElectionCents: null,
      settleClearedCreditElectionCents: 4500,
    });
  });

  it("mark-paid -> reversal -> re-mark clears and reports ONCE PER SETTLEMENT, on the election the reversal actually restored", async () => {
    // 1. The settle clears the election and reports it.
    primeSettleWithElection(4500);
    mocks.getMemberCreditBalance.mockResolvedValue(4500);
    await settleFullPrice();
    expect(unappliedAuditCalls()).toHaveLength(1);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledTimes(1);

    // 2. The reversal puts the election back, from the settle's audit row.
    primeReversalRead();
    primeStoredSettleAudit(4500);
    mocks.bookingUpdateMany.mockClear();
    const reversal = await reverse();
    expect(reversal.restoredCreditElectionCents).toBe(4500);

    // 3. The re-mark sees whatever the REVERSAL actually wrote back — derived
    // from its own write, never hard-coded, so this half cannot pass by
    // assumption. Cash is taken a second time while the election stands, so it
    // is cleared and reported a second time: once per settlement, which is the
    // honest count. Reporting only once would leave the member's second
    // full-price payment unexplained.
    primeSettleWithElection(restoredElectionFromReversalWrite());
    mocks.paymentFindUnique.mockResolvedValue(paymentRow());
    const remark = await settleFullPrice();

    expect(remark.staleCreditElectionCents).toBe(4500);
    expect(unappliedAuditCalls()).toHaveLength(2);
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledTimes(2);
  });
});

describe("#2262 delta MED-2 — the cleared-election copy can never overstate what is available", () => {
  /**
   * Elected long ago, spent since. The member's live balance — not the elected
   * figure — is what the copy may quote, or a $450 election against a $50
   * balance invites an operator to refund nine times what the account holds.
   */
  function primeSettleWithElection(electionCents: number) {
    mocks.deriveBookingAppliedCreditCents.mockResolvedValue(0);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: unknown }) =>
        args.select
          ? { lodgeId: "lodge-1" }
          : bookingRow({ creditElectionCents: electionCents })
    );
  }

  function alertArgs() {
    return vi.mocked(sendAdminPaymentFailureAlert).mock.calls[0]?.[0] as {
      amountCents: number;
      errorMessage: string;
    };
  }

  function unappliedMetadata() {
    const call = mocks.createAuditLog.mock.calls.find(
      (entry) =>
        (entry[0] as { action?: string })?.action ===
        "booking.credit_election.unapplied"
    );
    return (call?.[0] as { metadata?: Record<string, unknown> })?.metadata ?? {};
  }

  beforeEach(() => {
    vi.mocked(sendAdminPaymentFailureAlert).mockResolvedValue(
      undefined as never
    );
  });

  it("elected MORE than the live balance: both figures are clamped to the balance and the copy says it moved", async () => {
    primeSettleWithElection(45000);
    mocks.getMemberCreditBalance.mockResolvedValue(5000);

    await settle({ expectedAmountCents: 12000 });

    expect(unappliedMetadata()).toMatchObject({
      creditElectionCents: 45000,
      availableCreditCents: 5000,
      refundableCents: 5000,
    });
    const alert = alertArgs();
    // The headline figure an operator acts on is the refundable one.
    expect(alert.amountCents).toBe(5000);
    expect(alert.errorMessage).toContain("at most $50.00");
    expect(alert.errorMessage).toContain("their balance has moved since");
    // The elected figure survives only as a statement about the past.
    expect(alert.errorMessage).toContain("had asked to put $450.00");
  });

  it("elected EXACTLY the live balance: the full election is refundable and nothing claims it moved", async () => {
    primeSettleWithElection(5000);
    mocks.getMemberCreditBalance.mockResolvedValue(5000);

    await settle({ expectedAmountCents: 12000 });

    expect(unappliedMetadata()).toMatchObject({
      creditElectionCents: 5000,
      availableCreditCents: 5000,
      refundableCents: 5000,
    });
    const alert = alertArgs();
    expect(alert.amountCents).toBe(5000);
    expect(alert.errorMessage).toContain("at most $50.00");
    expect(alert.errorMessage).not.toContain("balance has moved since");
  });

  it("balance spent to ZERO: the copy says there is nothing to refund rather than 'refund at most $0.00'", async () => {
    primeSettleWithElection(45000);
    mocks.getMemberCreditBalance.mockResolvedValue(0);

    await settle({ expectedAmountCents: 12000 });

    expect(unappliedMetadata()).toMatchObject({
      creditElectionCents: 45000,
      availableCreditCents: 0,
      refundableCents: 0,
    });
    const alert = alertArgs();
    expect(alert.amountCents).toBe(0);
    expect(alert.errorMessage).toContain("nothing to refund");
    expect(alert.errorMessage).not.toContain("at most");
  });

  it("the balance read failing omits every availability figure rather than falling back to the elected one", async () => {
    primeSettleWithElection(45000);
    mocks.getMemberCreditBalance.mockRejectedValue(new Error("db down"));

    await settle({ expectedAmountCents: 12000 });

    expect(unappliedMetadata()).toMatchObject({
      creditElectionCents: 45000,
      availableCreditCents: null,
      refundableCents: null,
    });
    const alert = alertArgs();
    expect(alert.errorMessage).toContain("could not be read");
    // No availability FIGURE is quoted — the sentence tells the operator to go
    // and look, rather than naming an amount it cannot stand behind.
    expect(alert.errorMessage).not.toContain("at most $");
    expect(alert.errorMessage).not.toContain("They now hold");
  });
});

/**
 * #2397 — a cash settlement on a booking that still carries an uncollected
 * upward-modification delta.
 *
 * The collision this closes: `additionalAmountCents` / `additionalPaymentStatus`
 * were only ever written by the CARD additional-payment flow, so a booking whose
 * later price increase was settled in cash kept reading as owing — the admin
 * list would show a "$X due" chip against a fully settled booking, and the
 * automatic chase (#2350 / PR #2386) would email the member asking for money the
 * club already holds.
 *
 * The owner's decision (31 Jul 2026) is to ASK the admin at the time, so these
 * tests pin all three shapes: extra present and covered, extra present and not
 * covered, and — the one that must never regress — no extra at all.
 */
describe("#2397 — an outstanding extra, and the admin's answer about it", () => {
  const EXTRA_CENTS = 2100;

  function primeOutstandingExtra(overrides: Record<string, unknown> = {}) {
    mocks.paymentFindUnique.mockResolvedValue(
      paymentRow({
        additionalAmountCents: EXTRA_CENTS,
        additionalPaymentStatus: "PENDING",
        ...overrides,
      })
    );
  }

  /** The ADDITIONAL half of the mint, whichever call carried it. */
  function additionalMintUpdateCall() {
    return mocks.paymentTransactionUpdateMany.mock.calls.find(
      (call) =>
        (call[0] as { where?: { kind?: string } }).where?.kind ===
        PaymentTransactionKind.ADDITIONAL
    );
  }

  function additionalMintCreateCall() {
    return mocks.paymentTransactionCreate.mock.calls.find(
      (call) =>
        (call[0] as { data?: { kind?: string } }).data?.kind ===
        PaymentTransactionKind.ADDITIONAL
    );
  }

  function primaryMintCreateCall() {
    return mocks.paymentTransactionCreate.mock.calls.find(
      (call) =>
        (call[0] as { data?: { kind?: string } }).data?.kind ===
        PaymentTransactionKind.PRIMARY
    );
  }

  function fencedPaymentWrite() {
    return mocks.paymentUpdateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
  }

  describe("the extra is present and the cash covers it", () => {
    beforeEach(() => {
      primeOutstandingExtra();
    });

    function settleCovered() {
      return settle({
        additionalCoverage: {
          covered: true,
          expectedAdditionalAmountCents: EXTRA_CENTS,
        },
      });
    }

    it("SPLITS the one amount owing instead of collecting it twice", async () => {
      // The whole point. An upward change raised `finalPriceCents` by the same
      // delta it recorded as the extra, and this settle collects
      // `finalPriceCents - credit` in one go — so the extra is a SLICE of the
      // $100.00, not $21.00 on top of it. Recording both at full value would
      // book $121.00 of cash for a $100.00 settlement and inflate every revenue
      // figure that reads the payment ledger.
      const result = await settleCovered();

      expect(primaryMintCreateCall()?.[0]).toMatchObject({
        data: expect.objectContaining({
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.INTERNET_BANKING,
          amountCents: 10000 - EXTRA_CENTS,
          status: PaymentStatus.SUCCEEDED,
        }),
      });
      expect(additionalMintCreateCall()?.[0]).toMatchObject({
        data: expect.objectContaining({
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.INTERNET_BANKING,
          stripePaymentIntentId: null,
          amountCents: EXTRA_CENTS,
          status: PaymentStatus.SUCCEEDED,
          reason: "manual_mark_paid_additional",
        }),
      });
      // The two rows still sum to the one settlement amount, and the payment
      // mirror `amountCents + creditAppliedCents = finalPriceCents` is
      // untouched.
      const primaryCents = (
        primaryMintCreateCall()?.[0] as { data: { amountCents: number } }
      ).data.amountCents;
      const additionalCents = (
        additionalMintCreateCall()?.[0] as { data: { amountCents: number } }
      ).data.amountCents;
      expect(primaryCents + additionalCents).toBe(10000);
      expect(fencedPaymentWrite().data).toMatchObject({
        amountCents: 10000,
        creditAppliedCents: 2000,
      });
      // The whole amount owing was received, so nothing is left uncollected and
      // the generalised mirror reduces to the original one.
      expect(result.uncollectedAdditionalCents).toBe(0);
      expect(result.amountOwingCents).toBe(10000);
      expect(
        result.effectiveAmountCents +
          result.creditAppliedCents +
          result.uncollectedAdditionalCents
      ).toBe(12000);
      expect(result.effectiveAmountCents + result.creditAppliedCents).toBe(
        12000
      );
    });

    it("mints the SAME primary figure the not-covered answer does", async () => {
      // The answer decides whether an ADDITIONAL row sits beside the primary,
      // never what the primary says was received — one subtraction serves both
      // branches. Pinned as a literal here and in the not-covered block, so a
      // change to either branch breaks both tests rather than silently
      // diverging.
      await settleCovered();

      expect(primaryMintCreateCall()?.[0]).toMatchObject({
        data: expect.objectContaining({ amountCents: 7900 }),
      });
    });

    it("mints the ADDITIONAL row with the SAME two divergences as the PRIMARY mint", async () => {
      await settleCovered();

      // FAILED excluded (a reversal's row must not be resurrected at a stale
      // amount), and create-unconditionally on count 0 (never adopt the
      // member's stale STRIPE additional row and claim a card capture).
      expect(additionalMintUpdateCall()?.[0]).toMatchObject({
        where: expect.objectContaining({
          paymentId: "payment-1",
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.INTERNET_BANKING,
          status: {
            notIn: [
              PaymentStatus.REFUNDED,
              PaymentStatus.PARTIALLY_REFUNDED,
              PaymentStatus.FAILED,
            ],
          },
        }),
      });
      expect(additionalMintCreateCall()).toBeDefined();
    });

    it("does not create a second ADDITIONAL row when an existing non-FAILED one was updated", async () => {
      mocks.paymentTransactionUpdateMany.mockResolvedValue({ count: 1 });

      await settleCovered();

      expect(additionalMintCreateCall()).toBeUndefined();
    });

    it("writes the settled state every consumer reads, behind a re-asserted fence", async () => {
      await settleCovered();

      const fenced = fencedPaymentWrite();
      expect(fenced.data).toMatchObject({
        additionalPaymentStatus: "SUCCEEDED",
      });
      // Re-asserted in the WHERE, like every other expressible refusal: a card
      // additional capturing between the read and this write yields count 0 ->
      // 409 rather than a stamp over a figure that moved.
      expect(fenced.where).toMatchObject({
        additionalAmountCents: EXTRA_CENTS,
        OR: [
          { additionalPaymentStatus: null },
          { additionalPaymentStatus: { not: "SUCCEEDED" } },
        ],
      });
    });

    it("leaves the extra invisible to the owed predicate the chase consults", async () => {
      await settleCovered();

      const written = fencedPaymentWrite().data;
      // The exact money-half test #2386's `isAdditionalPaymentOwed` is built
      // from; the booking-status half is satisfied by this settle landing PAID.
      expect(
        isAdditionalAmountUncollected({
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: written.additionalPaymentStatus as string,
        })
      ).toBe(false);
    });

    it("records it in booking history as a manual settlement, not silently", async () => {
      await settleCovered();

      const historyRow = mocks.createAuditLog.mock.calls.find(
        (call) =>
          (call[0] as { action: string }).action ===
          "booking-payment.manual-payment.additional-settled"
      );
      expect(historyRow).toBeDefined();
      expect(historyRow?.[0]).toMatchObject({
        entityType: "Payment",
        targetId: "booking-1",
        category: "payment",
        severity: "important",
        // JSON, because the booking-history builder parses this field.
        details: JSON.stringify({ additionalAmountCents: EXTRA_CENTS }),
      });
      expect(historyRow?.[1]).toBe(tx);
    });

    it("records the answer on the mark-paid audit row and reports it to the caller", async () => {
      const result = await settleCovered();

      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking-payment.manual-payment.mark-paid",
          metadata: expect.objectContaining({
            // The figure actually WRITTEN — here the whole amount owing.
            effectiveAmountCents: 10000,
            amountOwingCents: 10000,
            outstandingAdditionalCents: EXTRA_CENTS,
            uncollectedAdditionalCents: 0,
            additionalCoverageAnswer: true,
            settledAdditionalAmountCents: EXTRA_CENTS,
            previousAdditionalPaymentStatus: "PENDING",
          }),
        }),
        tx
      );
      expect(result.outstandingAdditionalCents).toBe(EXTRA_CENTS);
      expect(result.settledAdditionalAmountCents).toBe(EXTRA_CENTS);
    });

    it("F4 — still cancels the addition's intent, because the cash already covered it", async () => {
      // The spare is for the NOT-covered answer only. Here the extra is settled,
      // so a live addition intent is a door to a second payment for money the
      // club already holds — exactly what the blanket cancel exists to stop.
      mocks.paymentFindUnique.mockResolvedValue(
        paymentRow({
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: "PENDING",
          additionalPaymentIntentId: "pi_additional",
        })
      );
      mocks.paymentTransactionFindMany.mockResolvedValue([
        {
          id: "txn-additional",
          kind: PaymentTransactionKind.ADDITIONAL,
          stripePaymentIntentId: "pi_additional",
          amountCents: EXTRA_CENTS,
        },
      ]);

      const result = await settleCovered();

      expect(result.outstandingIntentIds).toEqual(["pi_additional"]);
      expect(result.sparedAdditionalPaymentIntentId).toBeNull();
      expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
        "pi_additional"
      );
    });

    it("409s when the extra moved since the dialog rendered, writing nothing", async () => {
      await expect(
        settle({
          additionalCoverage: {
            covered: true,
            expectedAdditionalAmountCents: 1900,
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("extra owing changed"),
      });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    });

    it("409s rather than guessing when the extra is larger than the whole amount owing", async () => {
      // Reachable: a modification CHANGE FEE is added to the recorded extra but
      // never to `finalPriceCents`, so the extra can exceed the amount this
      // settle collects. It cannot be a slice of it, so it is refused.
      primeOutstandingExtra({ additionalAmountCents: 10500 });

      await expect(
        settle({
          additionalCoverage: {
            covered: true,
            expectedAdditionalAmountCents: 10500,
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("larger than the amount owing"),
      });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("the extra is present and the cash does NOT cover it", () => {
    beforeEach(() => {
      primeOutstandingExtra();
    });

    function settleUncovered() {
      return settle({
        additionalCoverage: {
          covered: false,
          expectedAdditionalAmountCents: EXTRA_CENTS,
        },
      });
    }

    it("leaves the extra exactly as it was, so the chase continuing is correct", async () => {
      const result = await settleUncovered();

      expect(additionalMintUpdateCall()).toBeUndefined();
      expect(additionalMintCreateCall()).toBeUndefined();
      const fenced = fencedPaymentWrite();
      // Nothing claims the extra was collected...
      expect(fenced.data).not.toHaveProperty("additionalPaymentStatus");
      // ...but the write is STILL fenced on the extra it reasoned about (F2).
      // The not-covered answer derives the figure it records by SUBTRACTING
      // that extra, so a card capture landing between the read and this write
      // must refuse here rather than record cash + card as cash alone.
      expect(fenced.where).toMatchObject({
        additionalAmountCents: EXTRA_CENTS,
        OR: [
          { additionalPaymentStatus: null },
          { additionalPaymentStatus: { not: "SUCCEEDED" } },
        ],
      });
      expect(
        isAdditionalAmountUncollected({
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: "PENDING",
        })
      ).toBe(true);
      expect(result.settledAdditionalAmountCents).toBe(0);
      expect(result.outstandingAdditionalCents).toBe(EXTRA_CENTS);
      expect(result.uncollectedAdditionalCents).toBe(EXTRA_CENTS);
    });

    it("records ONLY what was handed over — the amount owed before the change", async () => {
      // Owner decision, 31 Jul 2026. The old behaviour recorded the booking's
      // whole worth ($100.00) AND left $21.00 owing, so the books claimed
      // $121.00 of cash on a $121.00 booking that was still owed $21.00. Now the
      // two figures add up.
      const result = await settleUncovered();

      expect(result.effectiveAmountCents).toBe(10000 - EXTRA_CENTS);
      expect(result.amountOwingCents).toBe(10000);
      expect(primaryMintCreateCall()?.[0]).toMatchObject({
        data: expect.objectContaining({ amountCents: 10000 - EXTRA_CENTS }),
      });
      expect(fencedPaymentWrite().data).toMatchObject({
        amountCents: 10000 - EXTRA_CENTS,
        creditAppliedCents: 2000,
      });
    });

    it("keeps the GENERALISED ledger mirror: collected + credit + still owed = the price", async () => {
      // `amountCents + creditAppliedCents = finalPriceCents` was only ever the
      // special case where nothing is left owing, and it cannot hold on a
      // partially settled booking. What holds always — and what a CARD-settled
      // booking carrying an uncollected addition already satisfied — is that
      // every cent of the price is collected, paid with credit, or still owed.
      const result = await settleUncovered();

      expect(
        result.effectiveAmountCents +
          result.creditAppliedCents +
          result.uncollectedAdditionalCents
      ).toBe(12000);
      // …and the settled figure plus what was left owing is the amount owing.
      expect(
        result.effectiveAmountCents + result.uncollectedAdditionalCents
      ).toBe(result.amountOwingCents);
    });

    it("writes no booking-history row for an extra it did not settle", async () => {
      await settleUncovered();

      const historyRow = mocks.createAuditLog.mock.calls.find(
        (call) =>
          (call[0] as { action: string }).action ===
          "booking-payment.manual-payment.additional-settled"
      );
      expect(historyRow).toBeUndefined();
      // …but the answer is on the record BOTH ways, so a reader can tell "said
      // the cash did not cover it" from "was never asked" — and the figures let
      // them reconstruct which branch ran and what it meant.
      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            // The figure actually WRITTEN.
            effectiveAmountCents: 10000 - EXTRA_CENTS,
            amountOwingCents: 10000,
            outstandingAdditionalCents: EXTRA_CENTS,
            uncollectedAdditionalCents: EXTRA_CENTS,
            additionalCoverageAnswer: false,
            settledAdditionalAmountCents: null,
          }),
        }),
        tx
      );
    });

    it("F2 — REFUSES when a card capture settles the extra between the read and the write", async () => {
      // The additional-capture writer takes NO advisory lock (the confirm route
      // and the Stripe webhook both go straight to
      // markPaymentIntentTransactionSucceeded), so under read-committed a
      // capture can commit between the locked read above and the fenced write.
      // Without the fence clause on THIS branch the club would end up holding
      // cash + card while `amountCents` recorded only the cash — the delta
      // under-recorded, the exact inverse of the owner's rule. The fence
      // matching nothing is what turns that into a 409.
      mocks.paymentUpdateMany.mockResolvedValue({ count: 0 });

      await expect(settleUncovered()).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("changed while you were recording it"),
      });
      // The clause that makes the race LOSABLE at all: without it the WHERE
      // says nothing about the delta, the captured row matches, and the settle
      // commits $100 as the whole of a $121 booking the club now holds $121 for.
      expect(fencedPaymentWrite().where).toMatchObject({
        additionalAmountCents: EXTRA_CENTS,
        OR: [
          { additionalPaymentStatus: null },
          { additionalPaymentStatus: { not: "SUCCEEDED" } },
        ],
      });
      // The booking is never claimed PAID on a lost fence.
      expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    });

    it("F4 — spares the addition's own live card intent, so the money it chases can still be paid", async () => {
      // Cancelling this intent left the club chasing a member who had no way to
      // send the money: the booking page still renders the pay card, but the
      // secret route would hand back a cancelled intent. Everything else is
      // still disarmed — a live PRIMARY intent is a door to a SECOND payment
      // for cash the club already holds.
      mocks.paymentFindUnique.mockResolvedValue(
        paymentRow({
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: "PENDING",
          additionalPaymentIntentId: "pi_additional",
        })
      );
      mocks.paymentTransactionFindMany.mockResolvedValue([
        {
          id: "txn-primary",
          kind: PaymentTransactionKind.PRIMARY,
          stripePaymentIntentId: "pi_primary",
          amountCents: 10000,
        },
        {
          id: "txn-additional",
          kind: PaymentTransactionKind.ADDITIONAL,
          stripePaymentIntentId: "pi_additional",
          amountCents: EXTRA_CENTS,
        },
      ]);

      const result = await settleUncovered();

      expect(result.outstandingIntentIds).toEqual(["pi_primary"]);
      expect(result.sparedAdditionalPaymentIntentId).toBe("pi_additional");
      expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledTimes(1);
      expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
        "pi_primary"
      );
      expect(mocks.enqueuePaymentIntentCancellationRecovery).not.toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_additional" })
      );
    });

    it("F4 — spares only the CURRENT addition pointer, never a superseded one", async () => {
      // A superseded addition intent is a live door to a figure nobody is owed
      // any more, so it must still be disarmed.
      mocks.paymentFindUnique.mockResolvedValue(
        paymentRow({
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: "PENDING",
          additionalPaymentIntentId: "pi_additional_current",
        })
      );
      mocks.paymentTransactionFindMany.mockResolvedValue([
        {
          id: "txn-additional-old",
          kind: PaymentTransactionKind.ADDITIONAL,
          stripePaymentIntentId: "pi_additional_stale",
          amountCents: 900,
        },
        {
          id: "txn-additional-current",
          kind: PaymentTransactionKind.ADDITIONAL,
          stripePaymentIntentId: "pi_additional_current",
          amountCents: EXTRA_CENTS,
        },
      ]);

      const result = await settleUncovered();

      expect(result.outstandingIntentIds).toEqual(["pi_additional_stale"]);
      expect(result.sparedAdditionalPaymentIntentId).toBe(
        "pi_additional_current"
      );
    });

    it("F4 — NEVER spares a PRIMARY intent, however the addition pointer got there", async () => {
      // The OTHER half of the two-part spare predicate, and the half that
      // matters most. If `additionalPaymentIntentId` ever names the PRIMARY
      // intent — a legacy row, a hand repair, a future writer's mistake —
      // matching on the id alone would leave the primary card door live on a
      // booking whose cash the club has just recorded, i.e. a door to a SECOND
      // payment for money already in hand. The `kind === ADDITIONAL` clause is
      // the only thing that stops it; nothing downstream re-checks.
      mocks.paymentFindUnique.mockResolvedValue(
        paymentRow({
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: "PENDING",
          additionalPaymentIntentId: "pi_primary",
        })
      );
      mocks.paymentTransactionFindMany.mockResolvedValue([
        {
          id: "txn-primary",
          kind: PaymentTransactionKind.PRIMARY,
          stripePaymentIntentId: "pi_primary",
          amountCents: 10000,
        },
      ]);

      const result = await settleUncovered();

      expect(result.outstandingIntentIds).toEqual(["pi_primary"]);
      expect(result.sparedAdditionalPaymentIntentId).toBeNull();
      // Disarmed durably in-transaction AND cancelled at Stripe after commit,
      // exactly as it would be without the pointer.
      expect(
        mocks.enqueuePaymentIntentCancellationRecovery
      ).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_primary" })
      );
      expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith(
        "pi_primary"
      );
    });

    it("REFUSES when the extra is the whole amount owing — there is nothing left to record", async () => {
      // Recording $0 would flip the booking to PAID for no money.
      primeOutstandingExtra({ additionalAmountCents: 10000 });

      await expect(
        settle({
          additionalCoverage: {
            covered: false,
            expectedAdditionalAmountCents: 10000,
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("nothing to record"),
      });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    });

    it("409s on an extra larger than the amount owing on THIS answer too", async () => {
      primeOutstandingExtra({ additionalAmountCents: 10500 });

      await expect(
        settle({
          additionalCoverage: {
            covered: false,
            expectedAdditionalAmountCents: 10500,
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("larger than the amount owing"),
      });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    });

    it("REFUSES when an extra exists and no answer was given, writing nothing", async () => {
      // A stale dialog — rendered before the extra was raised — must not be
      // able to settle only the primary and leave the member chased for money
      // nobody asked about.
      await expect(settle()).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("not on your screen"),
      });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
      expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
      expect(mocks.paymentTransactionCreate).not.toHaveBeenCalled();
    });
  });

  describe("the booking has NO extra — nothing about this settle changes", () => {
    it("settles exactly as before: one PRIMARY row at the full amount, no additional columns touched", async () => {
      const result = await settle();

      expect(mocks.paymentTransactionCreate).toHaveBeenCalledTimes(1);
      expect(primaryMintCreateCall()?.[0]).toMatchObject({
        data: expect.objectContaining({
          kind: PaymentTransactionKind.PRIMARY,
          amountCents: 10000,
        }),
      });
      const fenced = fencedPaymentWrite();
      expect(fenced.data).not.toHaveProperty("additionalPaymentStatus");
      expect(fenced.where).not.toHaveProperty("additionalAmountCents");
      expect(fenced.where).not.toHaveProperty("OR");
      expect(result.outstandingAdditionalCents).toBe(0);
      expect(result.settledAdditionalAmountCents).toBe(0);
      expect(result.uncollectedAdditionalCents).toBe(0);
      // The settled figure is still the whole amount owing, so the original
      // mirror is untouched on every booking without an extra.
      expect(result.effectiveAmountCents).toBe(10000);
      expect(result.effectiveAmountCents + result.creditAppliedCents).toBe(
        12000
      );
      expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
      expect(mocks.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            effectiveAmountCents: 10000,
            amountOwingCents: 10000,
            outstandingAdditionalCents: 0,
            uncollectedAdditionalCents: 0,
            // Never asked, and the record says so rather than implying a
            // decision the admin was not offered.
            additionalCoverageAnswer: null,
            settledAdditionalAmountCents: null,
          }),
        }),
        tx
      );
    });

    it("409s if an answer arrives for an extra that is not there", async () => {
      await expect(
        settle({
          additionalCoverage: {
            covered: true,
            expectedAdditionalAmountCents: EXTRA_CENTS,
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("settled or removed"),
      });
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalled();
    });

    it("treats a SUCCEEDED delta as no extra at all", async () => {
      mocks.paymentFindUnique.mockResolvedValue(
        paymentRow({
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: "SUCCEEDED",
        })
      );

      const result = await settle();

      expect(result.outstandingAdditionalCents).toBe(0);
      expect(fencedPaymentWrite().data).not.toHaveProperty(
        "additionalPaymentStatus"
      );
    });
  });

  describe("the reversal puts a covered extra back to owing", () => {
    function primeReversalWithSettledExtra(
      metadata: Record<string, unknown> = {
        settledAdditionalAmountCents: EXTRA_CENTS,
        previousAdditionalPaymentStatus: "PENDING",
      }
    ) {
      mocks.bookingFindUnique.mockImplementation(
        async (args: { select?: unknown }) =>
          args.select
            ? { lodgeId: "lodge-1" }
            : {
                ...bookingRow({ status: BookingStatus.PAID }),
                payment: {
                  id: "payment-1",
                  amountCents: 10000,
                  refundedAmountCents: 0,
                  xeroInvoiceId: null,
                  xeroRefundCreditNoteId: null,
                  internetBankingHoldSlots: false,
                  internetBankingHoldUntil: null,
                  manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
                  manuallyMarkedPaidPreviousStatus:
                    BookingStatus.PAYMENT_PENDING,
                },
              }
      );
      mocks.auditLogFindFirst.mockResolvedValue({ metadata });
    }

    function reverseSettlement() {
      return reverseManualBookingPayment({
        bookingId: "booking-1",
        actingAdminMemberId: ADMIN_ID,
        note: null,
      });
    }

    it("marks the manual ADDITIONAL row FAILED and restores the column with a GUARDED claim", async () => {
      primeReversalWithSettledExtra();

      const result = await reverseSettlement();

      expect(mocks.paymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: {
          paymentId: "payment-1",
          kind: PaymentTransactionKind.ADDITIONAL,
          source: PaymentSource.INTERNET_BANKING,
          status: PaymentStatus.SUCCEEDED,
          reason: "manual_mark_paid_additional",
        },
        data: {
          status: PaymentStatus.FAILED,
          reason: "manual_mark_paid_additional_reversed",
        },
      });
      // Guarded on the exact figure and status the settle wrote, so a
      // legitimate later settlement of the extra is never clobbered.
      expect(mocks.paymentUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "payment-1",
          additionalAmountCents: EXTRA_CENTS,
          additionalPaymentStatus: "SUCCEEDED",
        },
        data: { additionalPaymentStatus: "PENDING" },
      });
      expect(result.restoredAdditionalAmountCents).toBe(EXTRA_CENTS);
    });

    it("touches nothing when the matching settle covered no extra", async () => {
      primeReversalWithSettledExtra({ clearedCreditElectionCents: null });

      const result = await reverseSettlement();

      expect(result.restoredAdditionalAmountCents).toBeNull();
      expect(mocks.paymentTransactionUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            kind: PaymentTransactionKind.ADDITIONAL,
          }),
        })
      );
    });

    it("un-records exactly what the NOT-covered settle recorded, not the booking's worth", async () => {
      // The reversal gives back what its settle took. A not-covered settle wrote
      // the reduced figure to Payment.amountCents and left the extra owing, so
      // there is nothing to restore about the extra and the reversed amount is
      // the reduced figure — never the booking's whole worth, which the club
      // never held. (Payment.amountCents is the reduced 79.00 here.)
      mocks.bookingFindUnique.mockImplementation(
        async (args: { select?: unknown }) =>
          args.select
            ? { lodgeId: "lodge-1" }
            : {
                ...bookingRow({ status: BookingStatus.PAID }),
                payment: {
                  id: "payment-1",
                  amountCents: 10000 - EXTRA_CENTS,
                  refundedAmountCents: 0,
                  xeroInvoiceId: null,
                  xeroRefundCreditNoteId: null,
                  internetBankingHoldSlots: false,
                  internetBankingHoldUntil: null,
                  manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
                  manuallyMarkedPaidPreviousStatus:
                    BookingStatus.PAYMENT_PENDING,
                },
              }
      );
      // The not-covered settle recorded no settled extra, so its metadata has
      // no `settledAdditionalAmountCents` for the reversal to read back.
      mocks.auditLogFindFirst.mockResolvedValue({
        metadata: {
          effectiveAmountCents: 10000 - EXTRA_CENTS,
          amountOwingCents: 10000,
          uncollectedAdditionalCents: EXTRA_CENTS,
          settledAdditionalAmountCents: null,
        },
      });

      const result = await reverseSettlement();

      expect(result.reversedAmountCents).toBe(10000 - EXTRA_CENTS);
      expect(result.restoredAdditionalAmountCents).toBeNull();
      // The extra was never marked settled, so nothing about it is put back.
      expect(mocks.paymentUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            additionalPaymentStatus: "SUCCEEDED",
          }),
        })
      );
    });
  });
});
