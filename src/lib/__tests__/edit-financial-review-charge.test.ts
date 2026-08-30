import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentSource,
} from "@prisma/client";

/**
 * #3170 (epic #2797): the direction that ASKS FOR MONEY.
 *
 * #3032 parked only guest REMOVALS, which can only ever owe the member, so a
 * refund-only settlement was sufficient there. This child is the first to park an
 * edit that moves the price UP - a check-out extension, or a guest added - and
 * every settlement route was refund-shaped while the admin copy read "Record an
 * adjustment". An officer who correctly concluded "the member owes $200" and
 * entered it would have refunded $200 to their card.
 *
 * These tests are about the four properties that direction has to hold, and they
 * are deliberately in their own file rather than folded into
 * `manual-refund-task.test.ts`: that suite's fixtures are all refunds, and a
 * charge that quietly took a refund route would still satisfy most of them.
 *
 *   1. one completion mints ONE charge, through the ordinary additional-payment
 *      path rather than a fourth mechanism;
 *   2. a replay or a lost claim mints NONE;
 *   3. a refusal leaves the task OPEN with nothing written;
 *   4. an amount in the wrong direction is refused rather than settled.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  manualRefundTaskFindUnique: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  memberCreditFindUnique: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  createBookingModificationCredit: vi.fn(),
  createAuditLog: vi.fn(),
  recordBookingEvent: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
  enqueueEditFinancialReviewRefundRecovery: vi.fn(),
  markEditFinancialReviewRefundRecoverySucceeded: vi.fn(),
  createModificationAdditionalPaymentIntent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (...a: unknown[]) => mocks.transaction(...a) },
}));
vi.mock("@/lib/payment-transactions", () => ({
  applyLocalRefundAllocation: (...a: unknown[]) =>
    mocks.applyLocalRefundAllocation(...a),
  planStripeRefundAllocation: (...a: unknown[]) =>
    mocks.planStripeRefundAllocation(...a),
  refundPaymentTransactions: (...a: unknown[]) =>
    mocks.refundPaymentTransactions(...a),
  RefundAllocationRacedError: class RefundAllocationRacedError extends Error {},
}));
vi.mock("@/lib/payment-recovery", () => ({
  buildBookingModificationRefundMetadata: (
    bookingId: string,
    reason: string,
  ) => ({ bookingId, reason }),
  enqueueEditFinancialReviewRefundRecovery: (...a: unknown[]) =>
    mocks.enqueueEditFinancialReviewRefundRecovery(...a),
  markEditFinancialReviewRefundRecoverySucceeded: (...a: unknown[]) =>
    mocks.markEditFinancialReviewRefundRecoverySucceeded(...a),
}));
/**
 * The one place a charge is actually minted. Mocked rather than exercised - it
 * has its own suites - because what this file is about is that the completion
 * RE-ENTERS it, with which keys and which amount, rather than growing a
 * collection path of its own.
 */
vi.mock("@/lib/booking-modification-settlement", () => ({
  createModificationAdditionalPaymentIntent: (...a: unknown[]) =>
    mocks.createModificationAdditionalPaymentIntent(...a),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: (...a: unknown[]) =>
    mocks.queueXeroBookingEditSettlement(...a),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...a: unknown[]) => mocks.createAuditLog(...a),
}));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: (...a: unknown[]) => mocks.recordBookingEvent(...a),
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "ManualBookingPaymentError";
      this.status = status;
    }
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: (...a: unknown[]) =>
    mocks.createBookingModificationCredit(...a),
}));

import { resolveManualRefundTask } from "@/lib/manual-refund-task-resolution";
import {
  REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
  REVIEW_CHARGE_WRONG_KIND_MESSAGE,
} from "@/lib/edit-financial-review-settlement";
/**
 * NOT mocked. These two keys ARE the exactly-once boundary of a charge, so they
 * are asserted against the real builders rather than against a stub that could
 * agree with a wrong caller.
 */
import {
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
} from "@/lib/payment-recovery-keys";

const tx = {
  manualRefundTask: {
    findUnique: (...a: unknown[]) => mocks.manualRefundTaskFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.manualRefundTaskUpdateMany(...a),
  },
  memberCredit: {
    findUnique: (...a: unknown[]) => mocks.memberCreditFindUnique(...a),
  },
};

function reviewContext(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    occurrence: {
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      cause: "NO_STORED_NIGHT_PRICES",
      surrenderedNightDates: ["2026-08-01"],
      addedNightDates: ["2026-08-24", "2026-08-25"],
      storedEvidence: { guestTotalCents: null, nightPrices: [] },
    },
    guestMemberId: "member-1",
    bookingCheckIn: "2026-08-20",
    bookingCheckOut: "2026-08-25",
    bookingModificationId: "mod-1",
    ...overrides,
  };
}

/** A parked edit that RAISED the price, on a booking paid by card. */
function cardReviewTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    bookingId: "booking-1",
    // The task carries no payment of its own: a charge is not money coming back
    // out of one.
    paymentId: null,
    amountCents: null,
    raisedAmountCents: null,
    kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
    status: ManualRefundTaskStatus.OPEN,
    payment: null,
    reviewContext: reviewContext(),
    booking: {
      memberId: "member-1",
      status: "PAID",
      member: {
        id: "member-1",
        email: "grace@example.test",
        firstName: "Grace",
        lastName: "Hopper",
      },
      payment: {
        id: "payment-1",
        status: "SUCCEEDED",
        amountCents: 15000,
        refundedAmountCents: 0,
        xeroInvoiceId: null,
        source: PaymentSource.STRIPE,
        stripeCustomerId: "cus_1",
      },
    },
    ...overrides,
  };
}

function charge(overrides: Record<string, unknown> = {}) {
  return resolveManualRefundTask({
    taskId: "task-1",
    resolution: "completed",
    note: "two extra nights, priced from the 2024 rate card",
    actingMemberId: "admin-1",
    confirmedAmountCents: 20000,
    direction: "CHARGE_TO_MEMBER",
    ...overrides,
  } as Parameters<typeof resolveManualRefundTask>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx),
  );
  mocks.manualRefundTaskFindUnique.mockResolvedValue(cardReviewTask());
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
  mocks.memberCreditFindUnique.mockResolvedValue(null);
  mocks.createModificationAdditionalPaymentIntent.mockResolvedValue({
    additionalPaymentClientSecret: "cs_1",
    additionalPaymentIntentId: "pi_additional_1",
  });
  mocks.queueXeroBookingEditSettlement.mockResolvedValue(undefined);
});

describe("a completed review that asks the member for money (#3170)", () => {
  it("mints ONE charge, through the same additional-payment path an ordinary price increase uses", async () => {
    const result = await charge();

    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).toHaveBeenCalledTimes(1);
    const call =
      mocks.createModificationAdditionalPaymentIntent.mock.calls[0][0];
    expect(call.bookingId).toBe("booking-1");
    expect(call.result.additionalAmountCents).toBe(20000);
    expect(call.result.paymentId).toBe("payment-1");
    expect(call.result.bookingModificationId).toBe("mod-1");
    // The refund half of that context is inert: a charge returns nothing.
    expect(call.result.pendingRefundAmountCents).toBe(0);

    // TASK-scoped on both keys. One edit can raise TWO review tasks over ONE
    // BookingModification row, so a modification-scoped Stripe key would have
    // Stripe answer the second review with the FIRST intent - one collectable
    // instrument for two amounts, with both tasks reading as settled - and a
    // modification-scoped recovery key would put both charge debts in one row.
    expect(call.idempotencyKey).toBe(
      buildEditFinancialReviewAdditionalIntentStripeKey("task-1"),
    );
    expect(call.recoveryIdempotencyKey).toBe(
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("task-1"),
    );
    // A CONTROL on that claim: the two keys are genuinely different strings, so
    // an implementation that passed one for both would fail here rather than
    // pass twice over.
    expect(call.idempotencyKey).not.toBe(call.recoveryIdempotencyKey);

    expect(result.additionalPaymentIntentId).toBe("pi_additional_1");
    expect(result.settlementDirection).toBe("CHARGE_TO_MEMBER");
  });

  it("never touches the refund machinery, even though this booking has a refundable card payment", async () => {
    // The control that matters: the booking has $150 captured on a card, so
    // every refund route is available and would succeed. The direction is the
    // only thing keeping the money from going the wrong way.
    await charge();

    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewRefundRecovery).not.toHaveBeenCalled();
    expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
    // And no REFUNDED/CREDITED event: nothing was handed back, and that log is
    // member-facing.
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("sends Xero a POSITIVE delta waiting on the intent, not a credit note", async () => {
    await charge();

    expect(mocks.queueXeroBookingEditSettlement).toHaveBeenCalledTimes(1);
    const xero = mocks.queueXeroBookingEditSettlement.mock.calls[0][0];
    expect(xero.priceDiffCents).toBe(20000);
    expect(xero.bookingModificationId).toBe("mod-1");
    expect(xero.requiresAdditionalStripePayment).toBe(true);
    expect(xero.additionalPaymentIntentId).toBe("pi_additional_1");
    // The reduction branch reads `settlementAmountCents`; handing it a figure on
    // a charge would offer the credit-note arm an amount it must not use.
    expect(xero.settlementAmountCents).toBeNull();
  });

  it("writes the direction inside the SAME status-fenced claim as the amount", async () => {
    await charge();

    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledTimes(1);
    const claim = mocks.manualRefundTaskUpdateMany.mock.calls[0][0];
    // Fenced on OPEN: a direction applied outside the claim could be applied
    // twice, or to a row somebody else already closed.
    expect(claim.where).toMatchObject({
      id: "task-1",
      status: ManualRefundTaskStatus.OPEN,
    });
    expect(claim.data.status).toBe(ManualRefundTaskStatus.COMPLETED);
    expect(claim.data.amountCents).toBe(20000);
    expect(claim.data.settlementDirection).toBe("CHARGE_TO_MEMBER");
  });

  it("records the direction in the audit entry beside the route", async () => {
    await charge();

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          settlementRoute: "additional-charge",
          settlementDirection: "CHARGE_TO_MEMBER",
          amountCents: 20000,
        }),
      }),
      tx,
    );
  });

  it("a second completion of the same task mints NO second charge", async () => {
    // The replay case: the row is already terminal, so the status check refuses
    // before anything is claimed or minted.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({ status: ManualRefundTaskStatus.COMPLETED }),
    );

    await expect(charge()).rejects.toMatchObject({ status: 409 });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createModificationAdditionalPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
  });

  it("two admins completing at once: the one that loses the claim mints nothing", async () => {
    // Both read an OPEN row; the second's conditional update matches no row.
    // Nothing after the claim may run, or the club asks for the money twice.
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(charge()).rejects.toMatchObject({ status: 409 });

    expect(mocks.createModificationAdditionalPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("a booking with no instrument to collect through is REFUSED, and the task stays OPEN", async () => {
    // Nothing captured on a card and no issued invoice to add to. Inventing a
    // way to collect would be the fourth settlement mechanism the epic forbids;
    // recording it as collected would be the claim `INV-PAY-051` exists to stop.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        booking: {
          ...cardReviewTask().booking,
          status: "PENDING",
          payment: {
            id: "payment-1",
            status: "PENDING",
            amountCents: 0,
            refundedAmountCents: 0,
            xeroInvoiceId: null,
            source: PaymentSource.INTERNET_BANKING,
            stripeCustomerId: null,
          },
        },
      }),
    );

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
    });

    // NOTHING WRITTEN. The refusal fires before the claim, so the row is
    // untouched and still holds the money question.
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createModificationAdditionalPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
  });

  it("an internet-banking booking with an issued invoice is asked through the invoice, not a card", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        booking: {
          ...cardReviewTask().booking,
          payment: {
            id: "payment-1",
            status: "SUCCEEDED",
            amountCents: 15000,
            refundedAmountCents: 0,
            xeroInvoiceId: "xero-inv-1",
            source: PaymentSource.INTERNET_BANKING,
            stripeCustomerId: null,
          },
        },
      }),
    );

    const result = await charge();

    // No intent exists to mint on a hand-settled booking; the supplementary
    // invoice IS the ask, raised unpaid, and the club's existing
    // additional-payment chasing carries it from there.
    expect(mocks.createModificationAdditionalPaymentIntent).not.toHaveBeenCalled();
    expect(result.additionalPaymentIntentId).toBeNull();
    const xero = mocks.queueXeroBookingEditSettlement.mock.calls[0][0];
    expect(xero.priceDiffCents).toBe(20000);
    expect(xero.requiresAdditionalStripePayment).toBe(false);
    expect(xero.additionalPaymentIntentId).toBeNull();
  });

  it("refuses a charge on a task kind that can only ever owe the member", async () => {
    // The three pre-#2797 kinds are hand-backs by definition. A charge on one is
    // a mistake, not an unusual case.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
        paymentId: "payment-1",
        amountCents: 9000,
        raisedAmountCents: 9000,
        payment: { source: PaymentSource.INTERNET_BANKING },
      }),
    );

    await expect(charge({ confirmedAmountCents: 9000 })).rejects.toMatchObject({
      status: 400,
      message: REVIEW_CHARGE_WRONG_KIND_MESSAGE,
    });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createModificationAdditionalPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  it("refuses to close a review that did not say which way the money goes", async () => {
    // The unstated default is the whole hazard: "refund" was what silence meant,
    // on the one task type whose nature is that nobody could work the figure out.
    await expect(charge({ direction: null })).rejects.toMatchObject({
      status: 400,
    });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createModificationAdditionalPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("silence still means a hand-back on a legacy kind, which is all it can mean there", async () => {
    // The CONTROL for the test above: the required direction must not break the
    // three kinds that carry their direction in their own definition.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
        paymentId: "payment-1",
        amountCents: 9000,
        raisedAmountCents: 9000,
        payment: { source: PaymentSource.INTERNET_BANKING },
      }),
    );

    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "completed",
      note: "cash handed back at the lodge",
      actingMemberId: "admin-1",
      confirmedAmountCents: null,
      direction: null,
    });

    expect(mocks.applyLocalRefundAllocation).toHaveBeenCalledWith({
      paymentId: "payment-1",
      amountCents: 9000,
      store: tx,
    });
    const claim = mocks.manualRefundTaskUpdateMany.mock.calls[0][0];
    expect(claim.data.settlementDirection).toBe("REFUND_TO_MEMBER");
  });

  it("a dismissal records no direction, because nothing moved", async () => {
    await resolveManualRefundTask({
      taskId: "task-1",
      resolution: "dismissed",
      note: "the club collected this at the lodge",
      actingMemberId: "admin-1",
    });

    const claim = mocks.manualRefundTaskUpdateMany.mock.calls[0][0];
    expect(claim.data.settlementDirection).toBeUndefined();
    expect(claim.data.amountCents).toBeUndefined();
    expect(mocks.createModificationAdditionalPaymentIntent).not.toHaveBeenCalled();
  });
});
