import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";

/**
 * #3170 (epic #2797): the direction that ASKS FOR MONEY, and the rule that ONE
 * BOOKING EDIT RAISES ONE REQUEST.
 *
 * #3032 parked only guest REMOVALS, which can only ever owe the member, so a
 * refund-only settlement was sufficient there. This child is the first to park an
 * edit that moves the price UP - a check-out extension, or a guest added - and
 * every settlement route was refund-shaped while the admin copy read "Record an
 * adjustment". An officer who correctly concluded "the member owes $200" and
 * entered it would have refunded $200 to their card.
 *
 * These tests are about the properties that direction has to hold, and they are
 * deliberately in their own file rather than folded into
 * `manual-refund-task.test.ts`: that suite's fixtures are all refunds, and a
 * charge that quietly took a refund route would still satisfy most of them.
 *
 *   1. one completion raises ONE charge, through the ordinary additional-payment
 *      path rather than a fourth mechanism;
 *   2. a replay or a lost claim raises NONE;
 *   3. a refusal leaves the task OPEN with nothing written;
 *   4. an amount in the wrong direction is refused rather than settled;
 *   5. TWO shares of ONE edit produce ONE request for their SUM - the property
 *      the first #3170 round got wrong, and which lost $200 of $230 in silence.
 */

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  manualRefundTaskFindUnique: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  manualRefundTaskFindMany: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  paymentFindUnique: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  memberCreditFindUnique: vi.fn(),
  applyLocalRefundAllocation: vi.fn(),
  planStripeRefundAllocation: vi.fn(),
  refundPaymentTransactions: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  createBookingModificationCredit: vi.fn(),
  createAuditLog: vi.fn(),
  recordBookingEvent: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
  restatePendingSupplementaryInvoiceAmount: vi.fn(),
  enqueueXeroSecondSupplementaryInvoiceOperation: vi.fn(),
  enqueueEditFinancialReviewRefundRecovery: vi.fn(),
  markEditFinancialReviewRefundRecoverySucceeded: vi.fn(),
  enqueueAdditionalPaymentIntentRecovery: vi.fn(),
  createModificationAdditionalPaymentIntent: vi.fn(),
  updatePaymentIntentAmount: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => mocks.transaction(...a),
    manualRefundTask: {
      findMany: (...a: unknown[]) => mocks.manualRefundTaskFindMany(...a),
    },
    paymentTransaction: {
      findFirst: (...a: unknown[]) => mocks.paymentTransactionFindFirst(...a),
    },
    payment: {
      findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a),
    },
    xeroObjectLink: {
      findFirst: (...a: unknown[]) => mocks.xeroObjectLinkFindFirst(...a),
    },
  },
}));

/**
 * PARTIAL mock, through `importOriginal`. The refund helpers are stubbed because
 * this file is about a charge NOT reaching them; `isCapturedTransactionStatus`
 * is deliberately left REAL, because "has this request already been paid" is the
 * rule the new refusal turns on and a stub of it could agree with a wrong caller.
 */
vi.mock("@/lib/payment-transactions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/payment-transactions")>();
  return {
    ...actual,
    applyLocalRefundAllocation: (...a: unknown[]) =>
      mocks.applyLocalRefundAllocation(...a),
    planStripeRefundAllocation: (...a: unknown[]) =>
      mocks.planStripeRefundAllocation(...a),
    refundPaymentTransactions: (...a: unknown[]) =>
      mocks.refundPaymentTransactions(...a),
    upsertPaymentIntentTransaction: (...a: unknown[]) =>
      mocks.upsertPaymentIntentTransaction(...a),
  };
});
vi.mock("@/lib/stripe", () => ({
  updatePaymentIntentAmount: (...a: unknown[]) =>
    mocks.updatePaymentIntentAmount(...a),
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  processRefund: vi.fn(),
  getPaymentIntent: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  cancelPaymentIntentIfCancellableWithResult: vi.fn(),
  listRefundsForCharge: vi.fn(),
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
  enqueueAdditionalPaymentIntentRecovery: (...a: unknown[]) =>
    mocks.enqueueAdditionalPaymentIntentRecovery(...a),
}));
/**
 * The one place a charge is MINTED. Mocked rather than exercised - it has its own
 * suites - because what this file is about is that the completion RE-ENTERS it,
 * with which keys and which amount, rather than growing a collection path of its
 * own. It is also the ONLY caller of
 * `queueSupersededAdditionalIntentCancellations`, which is what makes "this mock
 * was not called" a proof that nothing was queued for cancellation.
 */
vi.mock("@/lib/booking-modification-settlement", () => ({
  createModificationAdditionalPaymentIntent: (...a: unknown[]) =>
    mocks.createModificationAdditionalPaymentIntent(...a),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: (...a: unknown[]) =>
    mocks.queueXeroBookingEditSettlement(...a),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  restatePendingSupplementaryInvoiceAmount: (...a: unknown[]) =>
    mocks.restatePendingSupplementaryInvoiceAmount(...a),
  enqueueXeroSecondSupplementaryInvoiceOperation: (...a: unknown[]) =>
    mocks.enqueueXeroSecondSupplementaryInvoiceOperation(...a),
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
import { syncEditFinancialReviewChargeRequest } from "@/lib/edit-financial-review-charge";
import { recordUncollectedEditReviewChargeShare } from "@/lib/edit-financial-review-charge-request";
import {
  REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
  REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
  REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE,
  REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
  REVIEW_CHARGE_WRONG_KIND_MESSAGE,
} from "@/lib/edit-financial-review-charge-refusals";
/**
 * NOT mocked. These keys ARE the exactly-once boundary of a charge, so they are
 * asserted against the real builders rather than against a stub that could agree
 * with a wrong caller.
 */
import {
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
  buildEditFinancialReviewChargeReason,
} from "@/lib/payment-recovery-keys";

const tx = {
  manualRefundTask: {
    findUnique: (...a: unknown[]) => mocks.manualRefundTaskFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.manualRefundTaskUpdateMany(...a),
  },
  memberCredit: {
    findUnique: (...a: unknown[]) => mocks.memberCreditFindUnique(...a),
  },
  paymentTransaction: {
    findFirst: (...a: unknown[]) => mocks.paymentTransactionFindFirst(...a),
  },
  xeroObjectLink: {
    findFirst: (...a: unknown[]) => mocks.xeroObjectLinkFindFirst(...a),
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

/**
 * The S3 control fixture: the SAME booking, but with the task sitting on the
 * booking's own captured card payment.
 *
 * `cardReviewTask` leaves `paymentId`/`payment` null, which is the ordinary shape
 * of a charge task - and it makes the card-REFUND branch unreachable, because
 * `chooseEditReviewSettlementRoute` enters it only when the TASK has a Stripe
 * payment. A control that says "every refund route is available and would
 * succeed" has to be a fixture where that is true, or it proves nothing about the
 * direction being what holds the money back.
 */
function refundableCardReviewTask(overrides: Record<string, unknown> = {}) {
  return cardReviewTask({
    paymentId: "payment-1",
    payment: { source: PaymentSource.STRIPE },
    ...overrides,
  });
}

/** This edit's combined request, as the ledger holds it. */
function chargeRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ptx-additional-1",
    stripePaymentIntentId: "pi_additional_1",
    amountCents: 20000,
    status: PaymentStatus.PENDING,
    ...overrides,
  };
}

/** A share already settled as money owed to the club, on the same edit. */
function settledShare(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    amountCents: 20000,
    reviewContext: reviewContext(),
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
  // No request for this edit yet, and no supplementary invoice out.
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  // One share settled: this completion's own.
  mocks.manualRefundTaskFindMany.mockResolvedValue([settledShare()]);
  mocks.paymentFindUnique.mockResolvedValue({
    id: "payment-1",
    status: PaymentStatus.SUCCEEDED,
    amountCents: 15000,
    refundedAmountCents: 0,
    source: PaymentSource.STRIPE,
    stripeCustomerId: "cus_1",
  });
  mocks.createModificationAdditionalPaymentIntent.mockResolvedValue({
    additionalPaymentClientSecret: "cs_1",
    additionalPaymentIntentId: "pi_additional_1",
  });
  mocks.updatePaymentIntentAmount.mockResolvedValue({ id: "pi_additional_1" });
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.restatePendingSupplementaryInvoiceAmount.mockResolvedValue({
    restated: 0,
    alreadyCovering: 0,
  });
  // #3193: the second ask's ordinary answer - it queued this share's own small
  // invoice. `none` there means "no invoice exists or will", which is the only
  // outcome that leaves the difference uncollected.
  mocks.enqueueXeroSecondSupplementaryInvoiceOperation.mockResolvedValue({
    queueOperationId: "queue-op-second-ask",
    outcome: "covers-total",
    message: "Xero supplementary invoice queued for background processing.",
  });
  // The real dispatcher answers with the classification PLUS what the accounting
  // ask actually did about it. `none` is "no supplementary invoice is involved",
  // which is what every fixture here means unless it says otherwise.
  mocks.queueXeroBookingEditSettlement.mockResolvedValue({
    supplementaryInvoice: "none",
  });
});

/**
 * The Xero leg is dispatched fire-and-forget, so its `.then` lands on a
 * microtask AFTER the settlement has returned. Flushing here is what makes the
 * assertions about it deterministic rather than dependent on how many awaits
 * happen to follow the dispatch.
 */
async function flushDispatch() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("a completed review that asks the member for money (#3170)", () => {
  it("raises ONE charge, through the same additional-payment path an ordinary price increase uses", async () => {
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
    // #3170 S2: the minter's own guard is answered with the payment as it stands
    // now, re-read after the commit - never a literal `true`, which would make
    // that guard permanently dead for this caller.
    expect(call.result.hasSucceededPayment).toBe(true);
    // The row carries the anchor, which is how a later share finds this request.
    expect(call.reason).toBe(buildEditFinancialReviewChargeReason("mod-1"));

    // EDIT-scoped on both keys, which inverts the first #3170 round. The request
    // belongs to the edit, not to the task, so a second review's settlement joins
    // this one rather than minting a rival the mint would then cancel.
    expect(call.idempotencyKey).toBe(
      buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
    );
    expect(call.recoveryIdempotencyKey).toBe(
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-1"),
    );
    // A CONTROL on that claim: the two keys are genuinely different strings, so
    // an implementation that passed one for both would fail here rather than
    // pass twice over.
    expect(call.idempotencyKey).not.toBe(call.recoveryIdempotencyKey);

    expect(result.additionalPaymentIntentId).toBe("pi_additional_1");
    expect(result.settlementDirection).toBe("CHARGE_TO_MEMBER");
  });

  it("never touches the refund machinery, even though this booking's card payment is refundable through every route", async () => {
    // The control that matters, and the fixture has to make it TRUE: the task
    // sits on a captured Stripe payment, so `chooseEditReviewSettlementRoute`
    // would take the card-refund branch for the other direction, plan an
    // allocation and refund it. The direction is the only thing keeping the money
    // from going the wrong way.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      refundableCardReviewTask(),
    );
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "ptx-1", amountCents: 20000 }],
      totalRefundableCents: 15000000,
    });

    await charge();

    expect(mocks.planStripeRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
    expect(mocks.createBookingModificationCredit).not.toHaveBeenCalled();
    expect(
      mocks.enqueueEditFinancialReviewRefundRecovery,
    ).not.toHaveBeenCalled();
    // And no REFUNDED/CREDITED event: nothing was handed back, and that log is
    // member-facing.
    expect(mocks.recordBookingEvent).not.toHaveBeenCalled();
  });

  it("CONTROL: the same fixture in the other direction DOES refund through the card route", async () => {
    // Without this the test above proves only that the refund mocks were never
    // called, which a fixture with no reachable refund route satisfies for free.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      refundableCardReviewTask(),
    );
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "ptx-1", amountCents: 20000 }],
      totalRefundableCents: 15000000,
    });
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_1" }],
    });

    await charge({ direction: "REFUND_TO_MEMBER" });

    expect(mocks.planStripeRefundAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.refundPaymentTransactions).toHaveBeenCalledTimes(1);
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
  });

  it("answers the minter's captured-card guard with the payment as it stands NOW", async () => {
    // #3170 S2. The route decided there was a card to charge BEFORE the claim;
    // this is re-read AFTER the commit, so a payment that stopped being a
    // captured card charge in between makes the minter's own guard fire. A
    // literal `true` here would make that guard permanently dead for this caller
    // while its comment claimed the opposite.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "payment-1",
      status: PaymentStatus.PENDING,
      amountCents: 0,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      stripeCustomerId: "cus_1",
    });

    await charge();

    const call =
      mocks.createModificationAdditionalPaymentIntent.mock.calls[0][0];
    expect(call.result.hasSucceededPayment).toBe(false);
  });

  it("looks for THIS edit's request, not whatever additional the payment happens to carry", async () => {
    // An ordinary booking edit's price increase sits in the same place - same
    // payment, same ADDITIONAL kind. Restating THAT as if it were part of this
    // review would erase an unrelated ask, so the request is found by a reason
    // that names the edit rather than by "the latest additional".
    await charge();

    expect(mocks.paymentTransactionFindFirst).toHaveBeenCalled();
    const where = mocks.paymentTransactionFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      paymentId: "payment-1",
      kind: PaymentTransactionKind.ADDITIONAL,
      reason: buildEditFinancialReviewChargeReason("mod-1"),
    });
    // A CONTROL on that claim: a different edit produces a different reason, so
    // the two cannot collide.
    expect(buildEditFinancialReviewChargeReason("mod-2")).not.toBe(
      buildEditFinancialReviewChargeReason("mod-1"),
    );
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

  it("a second completion of the same task raises NO second charge", async () => {
    // The replay case: the row is already terminal, so the status check refuses
    // before anything is claimed or minted.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({ status: ManualRefundTaskStatus.COMPLETED }),
    );

    await expect(charge()).rejects.toMatchObject({ status: 409 });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
  });

  it("two admins completing at once: the one that loses the claim raises nothing", async () => {
    // Both read an OPEN row; the second's conditional update matches no row.
    // Nothing after the claim may run, or the club asks for the money twice.
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(charge()).rejects.toMatchObject({ status: 409 });

    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
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
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
  });

  it("a review with no booking-change to hang the charge on is REFUSED before the claim", async () => {
    // #3170 S4: the fourth pre-claim refusal, which had no test. The anchor is
    // what the combined request, the recovery row and the Xero supplementary
    // invoice are all keyed on, so a charge without one has nothing to join and
    // nothing to correct.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        reviewContext: reviewContext({ bookingModificationId: undefined }),
      }),
    );

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
    });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
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
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
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
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  it("refuses to close a review that did not say which way the money goes", async () => {
    // The unstated default is the whole hazard: "refund" was what silence meant,
    // on the one task type whose nature is that nobody could work the figure out.
    await expect(charge({ direction: null })).rejects.toMatchObject({
      status: 400,
    });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
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
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
  });
});

/**
 * #3170, the blocker this round exists for: ONE EDIT, ONE REQUEST.
 *
 * One edit raises one review task per unreadable guest strand, so two is
 * ordinary. Before this round the second settlement MINTED a second additional
 * PaymentIntent, which queued the first for cancellation and left
 * `Payment.additionalAmountCents` holding the LATER figure rather than the sum:
 * $200 then $30 collected $30 of $230, both tasks COMPLETED, both audited as
 * settled, and the durable retry closed the older recovery without minting.
 */
describe("two shares of one booking edit (#3170 combined request)", () => {
  /** The second review on the same edit, settled at $30 after a $200 first. */
  function secondShareTask() {
    return cardReviewTask({
      id: "task-2",
      reviewContext: reviewContext({
        occurrence: {
          ...reviewContext().occurrence,
          bookingGuestId: "guest-2",
        },
      }),
    });
  }

  function settleSecondShare(overrides: Record<string, unknown> = {}) {
    return resolveManualRefundTask({
      taskId: "task-2",
      resolution: "completed",
      note: "the second strand, priced from the same rate card",
      actingMemberId: "admin-2",
      confirmedAmountCents: 3000,
      direction: "CHARGE_TO_MEMBER",
      ...overrides,
    } as Parameters<typeof resolveManualRefundTask>[0]);
  }

  beforeEach(() => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(secondShareTask());
    // The first share's request, still unpaid.
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow());
    // Both shares are settled by the time the second's post-commit sync reads.
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare(),
      settledShare({ id: "task-2", amountCents: 3000 }),
    ]);
  });

  it("raises the FIRST request to the SUM instead of minting a second", async () => {
    const result = await settleSecondShare();

    // The one write that joins the two shares: the SAME intent, asking for $230.
    expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledTimes(1);
    expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledWith(
      "pi_additional_1",
      23000,
    );
    expect(result.additionalPaymentIntentId).toBe("pi_additional_1");

    // NOTHING IS MINTED, which is also the proof that the first request is NOT
    // cancelled: `createModificationAdditionalPaymentIntent` is the only caller
    // of `queueSupersededAdditionalIntentCancellations`, so a mint that never
    // happens can queue no cancellation.
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
  });

  it("the payment's outstanding additional is rewritten to the total, on the same row", async () => {
    await settleSecondShare();

    // One ADDITIONAL row, at $230, keyed on the intent that already existed. That
    // is what `reconcilePaymentAggregates` reads into
    // `Payment.additionalAmountCents`, which is the figure the member's pay link
    // and the payment summary both show.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        kind: PaymentTransactionKind.ADDITIONAL,
        paymentIntentId: "pi_additional_1",
        amountCents: 23000,
        reason: buildEditFinancialReviewChargeReason("mod-1"),
      }),
    );
  });

  it("the supplementary Xero invoice is RESTATED to the total, not queued a second time", async () => {
    mocks.restatePendingSupplementaryInvoiceAmount.mockResolvedValue({
      restated: 1,
      alreadyCovering: 0,
    });

    await settleSecondShare();

    expect(
      mocks.restatePendingSupplementaryInvoiceAmount,
    ).toHaveBeenCalledWith({
      bookingModificationId: "mod-1",
      priceDiffCents: 23000,
      changeFeeCents: 0,
    });
    // Queueing a second one is what the outbox silently drops (an anchor with an
    // active SUPPLEMENTARY_INVOICE link is refused with a message, not an error),
    // which is how the Xero leg lost the second $30.
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
  });

  it("the FIRST share's own settlement still bills the whole edit, when both were settled before it ran", async () => {
    // The other order of the same race: task-1's post-commit sync runs after
    // task-2 has already committed, so it derives $230 too. Both runs converge on
    // one request for the sum rather than one of them winning with its own share.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(cardReviewTask());
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);

    await charge();

    const call =
      mocks.createModificationAdditionalPaymentIntent.mock.calls[0][0];
    expect(call.result.additionalAmountCents).toBe(23000);
    const xero = mocks.queueXeroBookingEditSettlement.mock.calls[0][0];
    expect(xero.priceDiffCents).toBe(23000);
  });

  it("a STALE run cannot lower a request another run already raised", async () => {
    // The residual race: a run that started before its sibling committed derives
    // the smaller, older total. A settled share is terminal, so the total only
    // ever grows and the smaller figure is always the older answer - the write
    // refuses to lower, so whichever order the two provider calls land in, the
    // request settles at the larger.
    mocks.manualRefundTaskFindMany.mockResolvedValue([settledShare()]);
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ amountCents: 23000 }),
    );

    const result = await settleSecondShare();

    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(result.additionalPaymentIntentId).toBe("pi_additional_1");
  });

  it("a replay at the SAME total changes nothing at all", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ amountCents: 23000 }),
    );

    await settleSecondShare();

    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
  });

  it("counts only the shares that are OWED TO THE CLUB on THIS edit", async () => {
    // The derivation has to be exact in both directions: a refund settled on the
    // same booking is not part of what the club is owed, and a charge settled on
    // a DIFFERENT edit belongs to that edit's own request.
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare(),
      settledShare({ id: "task-2", amountCents: 3000 }),
      settledShare({
        id: "task-3",
        amountCents: 9900,
        reviewContext: reviewContext({ bookingModificationId: "mod-2" }),
      }),
    ]);

    await settleSecondShare();

    expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledWith(
      "pi_additional_1",
      23000,
    );
    // The query itself excludes refunds and un-settled tasks, so the anchor
    // filter above is the only part done in memory.
    const where = mocks.manualRefundTaskFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      bookingId: "booking-1",
      kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
      status: ManualRefundTaskStatus.COMPLETED,
      settlementDirection: ManualRefundTaskDirection.CHARGE_TO_MEMBER,
    });
  });

  it("REFUSES a share on a request the member has already paid, before the claim", async () => {
    // Owner obligation: this case needs its own answer, not an update that
    // silently fails. Refusal, because minting a remainder request would be a
    // SECOND outstanding request against one edit - the arrangement that lost the
    // money in the first place.
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.SUCCEEDED }),
    );

    await expect(settleSecondShare()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_REQUEST_ALREADY_PAID_MESSAGE,
    });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("REFUSES a share once this edit's supplementary invoice has been issued", async () => {
    // The internet-banking route's ordinary ceiling: its supplementary invoice is
    // raised unpaid and issues as soon as the outbox runs, so a second share
    // settled minutes later meets an ask already with the member.
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({ id: "link-1" });

    await expect(settleSecondShare()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
    });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
  });

  it("CONTROL: a REFUND on the same edit is not fenced by any of that", async () => {
    // The refusals above are charge-only. A second review settled as money owed
    // to the MEMBER shares no request with the first - two refunds of one edit
    // are two separate movements - so an outstanding charge request must not
    // block one.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      refundableCardReviewTask({ id: "task-2" }),
    );
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.SUCCEEDED }),
    );
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({ id: "link-1" });
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "ptx-1", amountCents: 3000 }],
      totalRefundableCents: 15000000,
    });
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_2" }],
    });

    await settleSecondShare({ direction: "REFUND_TO_MEMBER" });

    expect(mocks.refundPaymentTransactions).toHaveBeenCalledTimes(1);
  });
});

/**
 * #3170 fix round: WHAT THE SYNC SAYS IT DID, and why a caller has to read it.
 *
 * The sync is the single entry point for the inline completion and the recovery
 * replay, and it used to answer with `paymentIntentId: string | null` alone -
 * where `null` meant "nothing owed", "the ask is an invoice" and "the provider
 * refused and nothing was minted" indistinguishably. The replay closed its
 * operation on all three. These tests pin the discriminant that made the third
 * case a value rather than an absence, and the durable trace each silent path now
 * leaves.
 */
describe("what the sync reports, and the trace it leaves (#3170 fix round)", () => {
  const syncArgs = {
    bookingId: "booking-1",
    bookingModificationId: "mod-1",
    paymentId: "payment-1",
    member: {
      id: "member-1",
      email: "grace@example.test",
      name: "Grace Hopper",
      stripeCustomerId: "cus_1",
    },
    // #3181: the EDIT's answer, carried in so a mint failure can freeze it on
    // the recovery row rather than leave the replay to re-derive one.
    hasIssuedXeroInvoice: true,
  };

  beforeEach(() => {
    // Two shares settled against this edit: $200 + $30.
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare(),
      settledShare({ id: "task-2", amountCents: 3000 }),
    ]);
    mocks.paymentFindUnique.mockResolvedValue({
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 15000000,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      stripeCustomerId: "cus_1",
    });
  });

  /**
   * F1, THE MINT THAT PRODUCED NOTHING. This is what the recovery replay meets
   * while the provider is still down, and what it used to close the debt on.
   */
  it("reports `not-raised` and leaves a durable debt when the mint produced no intent", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    // `createModificationAdditionalPaymentIntent` swallows the provider failure
    // and returns empty - it does not throw, which is exactly why the caller has
    // to read the result.
    mocks.createModificationAdditionalPaymentIntent.mockResolvedValue({
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
    });

    await expect(
      syncEditFinancialReviewChargeRequest(syncArgs),
    ).resolves.toEqual({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
    });

    // The debt is durable under the EDIT-scoped recovery key, so the cron replays
    // this same derivation rather than a frozen figure.
    expect(mocks.enqueueAdditionalPaymentIntentRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentId: "payment-1",
        idempotencyKey:
          buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(
            "mod-1",
          ),
        stripeIdempotencyKey:
          buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
      }),
    );
  });

  /**
   * The path that used to leave NO trace of any kind: the minter's
   * `hasSucceededPayment` guard answers false on the post-commit re-read, so it
   * returns before its own `try` and neither logs nor enqueues.
   */
  it("still leaves a durable debt when the minter's own guard refused before its try", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    // No captured card payment at the re-read.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "payment-1",
      status: PaymentStatus.PENDING,
      amountCents: null,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      stripeCustomerId: null,
    });
    mocks.createModificationAdditionalPaymentIntent.mockResolvedValue({
      additionalPaymentClientSecret: undefined,
      additionalPaymentIntentId: undefined,
    });

    const result = await syncEditFinancialReviewChargeRequest(syncArgs);

    expect(result.outcome).toBe("not-raised");
    expect(mocks.enqueueAdditionalPaymentIntentRecovery).toHaveBeenCalledTimes(
      1,
    );
  });

  /**
   * THE CONTROL for both tests above. A sync that raised the request must say so,
   * and must NOT write a recovery row - otherwise the cron would replay a debt
   * that has already been asked for.
   */
  it("reports `raised` and enqueues nothing when the mint produced an intent", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    mocks.createModificationAdditionalPaymentIntent.mockResolvedValue({
      additionalPaymentClientSecret: "secret",
      additionalPaymentIntentId: "pi_additional_9",
    });

    await expect(
      syncEditFinancialReviewChargeRequest(syncArgs),
    ).resolves.toEqual({
      outcome: "raised",
      paymentIntentId: "pi_additional_9",
      totalCents: 23000,
    });
    expect(mocks.enqueueAdditionalPaymentIntentRecovery).not.toHaveBeenCalled();
  });

  /**
   * F5, THE PAID-IN-FLIGHT RACE. The pre-claim refusal is the ordinary guard;
   * this is the race behind it. It was a `logger.warn` and nothing else, so
   * nobody could ever find the share that went uncollected.
   */
  it("records an audit trace when the member paid before the total could be raised", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.SUCCEEDED }),
    );

    await expect(
      syncEditFinancialReviewChargeRequest(syncArgs),
    ).resolves.toEqual({
      outcome: "already-paid",
      paymentIntentId: "pi_additional_1",
      totalCents: 20000,
    });

    // Nothing was restated on a paid ask...
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    // ...and the $30 nobody can collect automatically is written where an officer
    // will find it, with the shortfall spelled out.
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
        category: "payment",
        outcome: "failure",
        entityId: "booking-1",
        metadata: expect.objectContaining({
          // WHICH ask could not take the share. The accounting leg has its own
          // window and writes the same action, so without this an officer cannot
          // tell a card shortfall from an invoice one.
          leg: "payment-request",
          bookingModificationId: "mod-1",
          derivedTotalCents: 23000,
          requestedTotalCents: 20000,
          uncollectedCents: 3000,
        }),
      }),
    );
    // THE FIGURE IS IN THE PROSE, not only in the metadata (#3170 fix round, nit
    // 5). The audit list shows the summary; a row that says "an amount" makes an
    // officer open the metadata to find out whether it matters.
    const row = mocks.createAuditLog.mock.calls[0][0];
    // Names the CARD ask, and the amount that was not added to it.
    expect(row.summary).toContain("payment request");
    expect(row.summary).toContain("$30.00");
    expect(row.details).toContain("$30.00");
    expect(row.details).toContain("$230.00");
    expect(row.details).toContain("$200.00");
  });

  /**
   * The CONTROL for the trace: an ordinary raise must NOT write one. An audit row
   * on every settlement would bury the ones that mean something.
   */
  it("writes no such trace on an ordinary raise", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow());

    await expect(
      syncEditFinancialReviewChargeRequest(syncArgs),
    ).resolves.toMatchObject({ outcome: "raised", totalCents: 23000 });

    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("reports `nothing-owed` when no share has been settled", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([]);

    await expect(
      syncEditFinancialReviewChargeRequest(syncArgs),
    ).resolves.toEqual({
      outcome: "nothing-owed",
      paymentIntentId: null,
      totalCents: 0,
    });
    expect(
      mocks.createModificationAdditionalPaymentIntent,
    ).not.toHaveBeenCalled();
    expect(mocks.enqueueAdditionalPaymentIntentRecovery).not.toHaveBeenCalled();
  });
});

/**
 * #3170 FIX ROUND, F2: THE ACCOUNTING LEG LEAVES A TRACE TOO.
 *
 * The card leg's already-paid race wrote an audit row. Its accounting twin wrote
 * NOTHING - not even a log line, because the enqueue's "already queued" message
 * returned into a discarded `void queueXeroBookingEditSettlement(...)` call. On
 * the internet-banking route the supplementary invoice IS the ask, so "nothing"
 * meant a settled share that no invoice and no record ever mentioned: the club is
 * owed money and nobody can find out.
 *
 * The window is real and it is not the one previously documented. A settlement
 * that restates too late is refused by the status guard, correctly, and falls
 * through to the ordinary enqueue - which finds the invoice already claimed for
 * sending (RUNNING) or already sent, refuses to queue a second one, and reports
 * `short`.
 */
describe("a share that could not join the Xero invoice (#3170 fix round, F2)", () => {
  function settleSecondShare(overrides: Record<string, unknown> = {}) {
    return resolveManualRefundTask({
      taskId: "task-2",
      resolution: "completed",
      note: "the second strand, priced from the same rate card",
      actingMemberId: "admin-2",
      confirmedAmountCents: 3000,
      direction: "CHARGE_TO_MEMBER",
      ...overrides,
    } as Parameters<typeof resolveManualRefundTask>[0]);
  }

  beforeEach(() => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        id: "task-2",
        reviewContext: reviewContext({
          occurrence: {
            ...reviewContext().occurrence,
            bookingGuestId: "guest-2",
          },
        }),
      }),
    );
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow());
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare(),
      settledShare({ id: "task-2", amountCents: 3000 }),
    ]);
    // Too late to restate: the outbox has the row.
    mocks.restatePendingSupplementaryInvoiceAmount.mockResolvedValue({
      restated: 0,
      alreadyCovering: 0,
    });
  });

  /**
   * #3193: THE DIFFERENCE IS BILLED, AND IT IS BILLED AS THE SHARE.
   *
   * This is the assertion the whole issue turns on. The change's invoice went
   * out at $200; this task settled $30; the second ask must be for $30. Handing
   * it the $230 combined total - the figure sitting right beside it in the same
   * dispatch, and the figure the change's own invoice bills - would ask the
   * member for $200 they have already been invoiced for, which is strictly worse
   * than the shortfall this issue exists to remove.
   */
  it("raises a second invoice for THIS SHARE, never the combined total", async () => {
    mocks.queueXeroBookingEditSettlement.mockResolvedValue({
      supplementaryInvoice: "short",
    });

    await settleSecondShare();
    await flushDispatch();

    expect(
      mocks.enqueueXeroSecondSupplementaryInvoiceOperation,
    ).toHaveBeenCalledTimes(1);
    const [params] = mocks.enqueueXeroSecondSupplementaryInvoiceOperation.mock
      .calls[0] as [
      { bookingId: string; bookingModificationId: string; reviewTaskId: string; shareCents: number },
    ];
    expect(params.shareCents).toBe(3000);
    expect(params.shareCents).not.toBe(23000);
    // Anchored on the TASK. That is what makes it idempotent and what keeps it
    // invisible to the change's own restate, which would otherwise raise this
    // $30 row to $230 on top of an invoice already sent.
    expect(params.reviewTaskId).toBe("task-2");
    expect(params.bookingModificationId).toBe("mod-1");
    expect(params.bookingId).toBe("booking-1");
  });

  /**
   * And it says so on the booking, because a member receiving two invoices for
   * one change will ask why and the office has to be able to answer. A SUCCESS
   * row, not the failure row: nothing is owed outside the system now.
   */
  it("records that the difference is being billed, not that it is uncollected", async () => {
    mocks.queueXeroBookingEditSettlement.mockResolvedValue({
      supplementaryInvoice: "short",
    });

    await settleSecondShare();
    await flushDispatch();

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareReinvoiced",
        category: "payment",
        outcome: "success",
        severity: "info",
        entityId: "booking-1",
        subjectMemberId: "member-1",
        metadata: expect.objectContaining({
          leg: "xero-invoice",
          bookingModificationId: "mod-1",
          derivedTotalCents: 23000,
          shareCents: 3000,
        }),
      }),
    );
    const row = mocks.createAuditLog.mock.calls
      .map((call) => call[0] as { action: string; summary: string; details: string })
      .find(
        (entry) =>
          entry.action ===
          "booking.editFinancialReview.chargeShareReinvoiced",
      )!;
    expect(row.summary).toContain("$30.00");
    expect(row.details).toContain("two invoices");
    expect(row.details).toContain("Nothing needs collecting by hand");
    // The uncollected row is the OTHER ending. Writing both would tell an
    // officer to chase money that is already on its way.
    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
      }),
    );
  });

  it("writes the durable record when the second invoice could not be raised either", async () => {
    mocks.queueXeroBookingEditSettlement.mockResolvedValue({
      supplementaryInvoice: "short",
    });
    // `none` from the second ask is the one outcome that leaves the difference
    // unbilled: no primary invoice to supplement, or nothing positive to bill.
    mocks.enqueueXeroSecondSupplementaryInvoiceOperation.mockResolvedValue({
      queueOperationId: null,
      outcome: "none",
      message: "No original Xero invoice exists for this booking.",
    });

    await settleSecondShare();
    await flushDispatch();

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
        category: "payment",
        outcome: "failure",
        entityId: "booking-1",
        subjectMemberId: "member-1",
        metadata: expect.objectContaining({
          leg: "xero-invoice",
          secondAsk: "failed",
          bookingModificationId: "mod-1",
          derivedTotalCents: 23000,
          // Unknowable, and said so rather than guessed: the outbox handler
          // overwrites the operation's payload with the Xero invoice body when
          // it sends, so what the invoice bills is no longer on the row.
          requestedTotalCents: null,
          uncollectedCents: null,
        }),
      }),
    );
    const row = mocks.createAuditLog.mock.calls
      .map((call) => call[0] as { action: string; summary: string; details: string })
      .find(
        (entry) =>
          entry.action === "booking.editFinancialReview.chargeShareUncollected",
      )!;
    // Names the ASK that fell short, not only the figure. Both legs write the
    // same action, so a summary that could equally describe the card request
    // sends an officer to check the wrong thing - and a probe that swapped this
    // arm's summary for the card one passed until this line existed.
    expect(row.summary).toContain("Xero invoice");
    expect(row.summary).toContain("$230.00");
    expect(row.summary).not.toContain("payment request");
    // The prose has to serve BOTH routes, because the same shortfall means
    // different things on each.
    expect(row.details).toContain("internet banking");
    expect(row.details).toContain("card");
    // #3193: and it now has to say what happened to the automatic second ask,
    // because an officer told only that the invoice is short will not know
    // whether one is already on its way.
    expect(row.details).toContain("Raise one by hand for the difference only");
  });

  /**
   * A throw is the same ending as a refusal, and it must not take the completion
   * with it: the money question is settled and committed by this point, so the
   * Xero leg's job is to leave a record rather than to fail.
   */
  it("records the shortfall when queueing the second invoice throws", async () => {
    mocks.queueXeroBookingEditSettlement.mockResolvedValue({
      supplementaryInvoice: "short",
    });
    mocks.enqueueXeroSecondSupplementaryInvoiceOperation.mockRejectedValue(
      new Error("Xero is down"),
    );

    await expect(settleSecondShare()).resolves.toBeDefined();
    await flushDispatch();

    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
        metadata: expect.objectContaining({ secondAsk: "failed" }),
      }),
    );
  });

  /**
   * THE CONTROL, and the reason this is not just "audit every settlement". A
   * dispatch that raised or queued the invoice at the combined total leaves no
   * row - if it did, the rows that mean something would be buried in the ones
   * that do not.
   */
  it("writes NO such record when the invoice covers the combined total", async () => {
    mocks.queueXeroBookingEditSettlement.mockResolvedValue({
      supplementaryInvoice: "covers-total",
    });

    await settleSecondShare();
    await flushDispatch();

    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
      }),
    );
    // #3193: and NO second ask. This is #3170's ordinary case - the invoice was
    // still in the queue and was raised to the total - so a second invoice here
    // would be the double ask the owner's decision is explicitly bounded away
    // from.
    expect(
      mocks.enqueueXeroSecondSupplementaryInvoiceOperation,
    ).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareReinvoiced",
      }),
    );
  });

  /**
   * A SECOND CONTROL, on the other axis. `none` means no supplementary invoice
   * is involved at all - nothing positive to bill, or no primary invoice to
   * supplement - so there is no ask for a share to fall short of.
   */
  it("writes NO such record when no supplementary invoice is involved", async () => {
    mocks.queueXeroBookingEditSettlement.mockResolvedValue({
      supplementaryInvoice: "none",
    });

    await settleSecondShare();
    await flushDispatch();

    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
      }),
    );
    // #3193: nothing fell short, so nothing is asked for a second time.
    expect(
      mocks.enqueueXeroSecondSupplementaryInvoiceOperation,
    ).not.toHaveBeenCalled();
  });

  /**
   * #3181 fix round: THE THIRD CAUSE HAS TO SAY SOMETHING DIFFERENT, because
   * following `ask-not-raised`'s instruction on this row BILLS THE MEMBER TWICE.
   *
   * A recovery row enqueued before `hadIssuedXeroInvoice` existed carries NULL,
   * and NULL is the club saying it cannot tell whether the edit had a primary
   * Xero invoice to supplement. If it did not, the primary invoice - minted later
   * from the booking's current state - bills the charge itself, so raising a
   * supplementary by hand asks for the same $230 a second time. Called directly
   * rather than through the dispatch because no dispatch produces this cause: it
   * comes from the recovery replay, which `payment-recovery.test.ts` covers.
   */
  it("tells an officer to run the repair, NOT to raise an invoice, when the owing is unknown", async () => {
    await recordUncollectedEditReviewChargeShare({
      leg: "xero-invoice",
      cause: "ask-owed-unknown",
      secondAsk: null,
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      memberId: "member-1",
      derivedTotalCents: 23000,
      requestedTotalCents: null,
    });

    const row = mocks.createAuditLog.mock.calls
      .map((call) => call[0] as { action: string; summary: string; details: string; metadata: Record<string, unknown> })
      .find(
        (entry) =>
          entry.action === "booking.editFinancialReview.chargeShareUncollected",
      )!;
    expect(row.metadata).toMatchObject({
      leg: "xero-invoice",
      cause: "ask-owed-unknown",
    });
    expect(row.summary).toContain("$230.00");
    // It says the owing is unrecorded, never that no invoice was raised for a
    // charge that needed one - which is the `ask-not-raised` sentence.
    expect(row.summary).toContain("not recorded");
    expect(row.details).toContain("bill the member twice");
    expect(row.details).toContain("booking-vs-Xero repair");
    expect(row.details).not.toContain("Raise the invoice by hand");
  });

  /**
   * CONTROL for that: `ask-not-raised` - an invoice WAS owed and the queue
   * refused it - still says raise it by hand. Without this the two causes could
   * be collapsed onto the cautious sentence, and an officer with a genuinely
   * missing invoice would be told to go and look rather than to raise it.
   */
  it("still tells an officer to raise it by hand when an invoice was owed", async () => {
    await recordUncollectedEditReviewChargeShare({
      leg: "xero-invoice",
      cause: "ask-not-raised",
      secondAsk: null,
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      memberId: "member-1",
      derivedTotalCents: 23000,
      requestedTotalCents: null,
    });

    const row = mocks.createAuditLog.mock.calls
      .map((call) => call[0] as { action: string; summary: string; details: string })
      .find(
        (entry) =>
          entry.action === "booking.editFinancialReview.chargeShareUncollected",
      )!;
    expect(row.summary).toContain("No Xero invoice was raised");
    expect(row.details).toContain("Raise the invoice by hand");
    expect(row.details).not.toContain("bill the member twice");
  });

  /**
   * A THIRD CONTROL, and the one that stops this firing on the wrong direction.
   * A REFUND settles its own amount and queues a credit note; `short` cannot
   * describe it, and a row saying the club is owed money would be exactly
   * backwards.
   */
  it("writes NO such record for a refund, whatever the dispatch reports", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      refundableCardReviewTask({ id: "task-2" }),
    );
    mocks.planStripeRefundAllocation.mockResolvedValue({
      slices: [{ paymentTransactionId: "ptx-1", amountCents: 3000 }],
      totalRefundableCents: 15000000,
    });
    mocks.refundPaymentTransactions.mockResolvedValue({
      refunds: [{ refundId: "re_2" }],
    });
    mocks.queueXeroBookingEditSettlement.mockResolvedValue({
      supplementaryInvoice: "short",
    });

    await settleSecondShare({ direction: "REFUND_TO_MEMBER" });
    await flushDispatch();

    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeShareUncollected",
      }),
    );
  });
});
