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
  executeRaw: vi.fn().mockResolvedValue(0),
  manualRefundTaskFindUnique: vi.fn(),
  manualRefundTaskUpdateMany: vi.fn(),
  manualRefundTaskFindMany: vi.fn(),
  paymentTransactionFindFirst: vi.fn(),
  // #4272: the paid request's refunds, and the earlier cancelled-share records.
  paymentTransactionFindUnique: vi.fn(),
  auditLogFindMany: vi.fn(),
  bookingStatusFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroSyncOperationFindFirst: vi.fn(),
  enqueueChargeInvoiceInTransaction: vi.fn(),
  kickOutbox: vi.fn(),
  bookingGuestFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdateMany: vi.fn(),
  bookingModificationCreate: vi.fn(),
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
  // #3402: the edit's own recovery row, armed through one helper.
  enqueueEditFinancialReviewChargeRecovery: vi.fn(),
  // #3402: the raise writes amounts only, status-fenced, onto the existing row.
  writeRaisedAdditionalRequestAmount: vi.fn(),
  updatePaymentIntentAmount: vi.fn(),
  // #3341: the minter and the supersede run for REAL (`INV-OPS-015`); these are
  // their leaves - the provider, the ledger read of asks to retire, and the
  // durable cancel that retires one.
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  supersedeRead: vi.fn(),
  enqueueCancel: vi.fn(),
  cancelNow: vi.fn(),
  // #3567: the raise first asks Stripe whether the intent is in another
  // currency. #3635: the re-issue behind that question runs for REAL
  // (`INV-OPS-015`); this is its one provider read.
  getPaymentIntent: vi.fn(),
  paymentUpdate: vi.fn(),
}));

// #3599: the credit rows' ledger lines are posted by one sync, proved in its own
// suites and against Postgres; this suite tests what it always tested.
// #3582: an edit's and a review closure's ledger lines are posted by one sync,
// proved in its own suites and against Postgres; this suite tests what it
// always tested.
vi.mock("@/lib/booking-ledger-modification-sync", () => ({
  postModificationLedgerLines: vi.fn().mockResolvedValue(undefined),
  postReviewClosureLedgerLines: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/booking-ledger-credit-sync", () => ({
  syncBookingLedgerCredits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/booking-ledger-hand-back", () => ({
  postHandBackLedgerLine: vi.fn().mockResolvedValue(undefined),
}));
// #3635: the same, for the settlement lines the re-issue's real reconcile posts.
vi.mock("@/lib/booking-ledger-settlement-sync", () => ({
  syncBookingLedgerSettlements: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #4217: the ledger writers lock the Payment row first.
    $executeRaw: vi.fn(async () => 0),
    $transaction: (...a: unknown[]) => mocks.transaction(...a),
    manualRefundTask: {
      findMany: (...a: unknown[]) => mocks.manualRefundTaskFindMany(...a),
      // #4154 review (M1): the completion's read, before its transaction, of whether the task is a capacity race's - none here.
      findUnique: async () => null,
    },
    paymentTransaction: {
      findFirst: (...a: unknown[]) => mocks.paymentTransactionFindFirst(...a),
      // The real supersede's read of the live asks a mint retires (#3341).
      findMany: (...a: unknown[]) => mocks.supersedeRead(...a),
      findUnique: (...a: unknown[]) => mocks.paymentTransactionFindUnique(...a),
    },
    auditLog: { findMany: (...a: unknown[]) => mocks.auditLogFindMany(...a) },
    booking: { findUnique: (...a: unknown[]) => mocks.bookingStatusFindUnique(...a) },
    payment: {
      findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a),
      // The re-issue's real `reconcilePaymentAggregates` writes the mirror (#3635).
      update: (...a: unknown[]) => mocks.paymentUpdate(...a),
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
    (await importOriginal()) as typeof import("@/lib/payment-transactions");
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
    writeRaisedAdditionalRequestAmount: (...a: unknown[]) =>
      mocks.writeRaisedAdditionalRequestAmount(...a),
  };
});
vi.mock("@/lib/stripe", () => ({
  updatePaymentIntentAmount: (...a: unknown[]) =>
    mocks.updatePaymentIntentAmount(...a),
  createPaymentIntent: (...a: unknown[]) => mocks.createPaymentIntent(...a),
  findOrCreateCustomer: (...a: unknown[]) => mocks.findOrCreateCustomer(...a),
  processRefund: vi.fn(),
  getPaymentIntent: (...a: unknown[]) => mocks.getPaymentIntent(...a),
  cancelPaymentIntentIfCancellable: vi.fn(),
  cancelPaymentIntentIfCancellableWithResult: vi.fn(),
  listRefundsForCharge: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  // #3835: the status sets the card cap's debt read routes through - the real ones.
  CLAIMABLE_PAYMENT_RECOVERY_STATUSES: ["PENDING", "FAILED"],
  NON_TERMINAL_PAYMENT_RECOVERY_STATUSES: ["PENDING", "PROCESSING", "FAILED"],
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
  enqueueEditFinancialReviewChargeRecovery: (...a: unknown[]) =>
    mocks.enqueueEditFinancialReviewChargeRecovery(...a),
  // #3402: the recovery row is live in these cases, so an `already-paid` answer
  // is not re-checked (the replay traces a deferred share).
  isEditFinancialReviewChargeRecoveryDead: async () => false,
  enqueuePaymentIntentCancellationRecovery: (...a: unknown[]) =>
    mocks.enqueueCancel(...a),
  runPaymentRecoveryOperationNow: (...a: unknown[]) => mocks.cancelNow(...a),
}));
// #3402: the raise claim is proved against PostgreSQL in
// `edit-financial-review-charge-raise-claim.realdb.test.ts` and its orchestration in
// `edit-financial-review-charge-claim.test.ts`; here every run wins it, which is
// the uncontended case these cases have always described.
vi.mock("@/lib/edit-financial-review-charge-raise-claim", () => ({
  claimEditReviewChargeRaise: async (bookingModificationId: string) => ({
    bookingModificationId,
    token: "claim-token",
  }),
  recordEditReviewChargeRaiseIntent: async () => true,
  releaseEditReviewChargeRaise: async () => true,
}));
/*
  THE ONE PLACE A CHARGE IS MINTED RUNS FOR REAL (#3341, `INV-OPS-015`), and so
  does `queueSupersededAdditionalIntentCancellationRows` behind it. Both used to be
  a single stub here, and the review charge's whole #3371 rule - that the ask
  CARRIES the unpaid balance of the one it retires - was asserted against the
  figure the completion HANDED that stub, never against what was minted or
  retired. `mint()` below reads the minter's own leaves instead.
*/
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: (...a: unknown[]) =>
    mocks.queueXeroBookingEditSettlement(...a),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  // #3947 (option 2): the invoice route's invoice, queued in the completion's transaction.
  enqueueEditReviewChargeInvoiceInTransaction: (...a: unknown[]) =>
    mocks.enqueueChargeInvoiceInTransaction(...a),
  kickQueuedXeroOutboxOperationsIfConnected: (...a: unknown[]) => mocks.kickOutbox(...a),
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
  // #3369: the one home for the account-credit refusal four settlement paths
  // share. Real, not stubbed: the mock must not turn a refusal into a pass.
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit (#3369)");
    return memberId;
  },
}));

import { resolveManualRefundTask } from "@/lib/manual-refund-task-resolution";
import {
  chooseEditReviewChargeRoute,
  syncEditFinancialReviewChargeRequest,
} from "@/lib/edit-financial-review-charge";
import { recordUncollectedEditReviewChargeShare } from "@/lib/edit-financial-review-charge-request";
import {
  EditReviewChargeStillMovingError,
  settleCancelledEditReviewCharge,
} from "@/lib/edit-financial-review-charge-cancelled";
import {
  CHARGE_BOOKING_CANCELLED_ALREADY_RECORDED_COMPLETION,
  CHARGE_BOOKING_CANCELLED_COMPLETION,
  completionMessage,
} from "@/lib/manual-refund-task-copy";
import { EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY } from "@/lib/edit-financial-review-charge-recovery";
import {
  canAskCardForReviewCharge,
  refusesReviewChargeForCancellation,
} from "@/lib/booking-payment-state";
import { supplementaryInvoiceStillComingWhere } from "@/lib/xero-supplementary-invoice-statuses";
import {
  REVIEW_CHARGE_ANCHOR_MISSING_MESSAGE,
  REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE,
  REVIEW_CHARGE_BOOKING_CANCELLED_ORGANISER_MESSAGE,
  REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
  REVIEW_CHARGE_ORGANISER_PAID_BY_BANK_MESSAGE,
  REVIEW_CHARGE_ORGANISER_PAID_MESSAGE,
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
  stripeIdempotencyKeyForAskAmount,
} from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const tx = {
  // #3582: an edit review's completion takes lock(1) first, before its claim.
  $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
  manualRefundTask: {
    findUnique: (...a: unknown[]) => mocks.manualRefundTaskFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.manualRefundTaskUpdateMany(...a),
    // #3947 (option 2): the invoice route derives the edit's total on this transaction.
    findMany: (...a: unknown[]) => mocks.manualRefundTaskFindMany(...a),
  },
  memberCredit: {
    findUnique: (...a: unknown[]) => mocks.memberCreditFindUnique(...a),
  },
  paymentTransaction: {
    findFirst: (...a: unknown[]) => mocks.paymentTransactionFindFirst(...a),
    // #4442: the mint's supersede reads the live asks inside its queue transaction.
    findMany: (...a: unknown[]) => mocks.supersedeRead(...a),
  },
  // #3835: the card refunds already promised out of the payment - none here.
  paymentRecoveryOperation: { aggregate: async () => ({ _sum: { amountCents: null } }) },
  // #4442: the mint's queue re-reads the live ask it carries, from the same fixture the sizing read.
  payment: { findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a) },
  xeroObjectLink: {
    findFirst: (...a: unknown[]) => mocks.xeroObjectLinkFindFirst(...a),
  },
  // #3947 review: the queued supplementary invoice a later share joins.
  xeroSyncOperation: {
    findFirst: (...a: unknown[]) => mocks.xeroSyncOperationFindFirst(...a),
    // #4299: no organiser extra refund note waits on these hand-backs.
    findMany: async () => [],
  },
  // #3219 D2: closing a review whose price boxes are OFFERED is refused while
  // they are blank, so every edit-review closure now asks whether this strand
  // has any. These fixtures send no figures and are not about that question, so
  // the strand comes back with none - the boxes are not offered and the close is
  // exactly the one this suite was written against.
  bookingGuest: {
    findUnique: (...a: unknown[]) => mocks.bookingGuestFindUnique(...a),
    // #3498: the settle path reads every strand the item names, as a list.
    // Answered from the same fixture, so these cases keep describing the
    // single-strand review they were written for.
    findMany: async () => {
      const guest = await mocks.bookingGuestFindUnique();
      return guest ? [guest] : [];
    },
  },
  // #3257: and EVERY edit-review closure now re-prices the booking from its
  // strands, whether or not it recorded a night price - so these fixtures reach
  // the booking too. They are not about that question, so the strands below
  // reconcile to the figures already stored: the re-price runs, agrees, and
  // writes no history row.
  booking: {
    findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a),
    updateMany: (...a: unknown[]) => mocks.bookingUpdateMany(...a),
  },
  bookingModification: {
    create: (...a: unknown[]) => mocks.bookingModificationCreate(...a),
  },
  // #3276: the re-base records the promotion build-up over the strands' nights.
  bookingGuestNightAdjustment: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  promoRedemption: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  bookingGuestNight: {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
    // #3371: nothing carried in, which is every request this fixture stands for
    // and every request minted before the column existed. The carrying shapes
    // have their own fixtures at the bottom of this file.
    carriedAskCents: 0,
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

/**
 * What the REAL minter was asked to mint, read off its own two leaves: the
 * Stripe intent it created, and the ADDITIONAL row it wrote straight after.
 */
function mint(index = 0) {
  const intentCall = mocks.createPaymentIntent.mock.calls[index];
  if (!intentCall) throw new Error(`the minter created no intent #${index}`);
  const minted = mocks.createPaymentIntent.mock.invocationCallOrder[index];
  const rowIndex =
    mocks.upsertPaymentIntentTransaction.mock.invocationCallOrder.findIndex(
      (order) => order > minted,
    );
  const intent = intentCall[0] as {
    amountCents: number;
    idempotencyKey: string;
    metadata: { bookingId: string; reason: string };
  };
  const row = mocks.upsertPaymentIntentTransaction.mock.calls[rowIndex]?.[0] as
    | { paymentId: string; kind: string; amountCents: number; carriedAskCents: number; reason: string }
    | undefined;
  return {
    amountCents: intent.amountCents,
    idempotencyKey: intent.idempotencyKey,
    bookingId: intent.metadata.bookingId,
    reason: intent.metadata.reason,
    row,
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
    recordedNightPrices: null,
  } as Parameters<typeof resolveManualRefundTask>[0], CLUB_FORMAT_TEST);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(
    async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx),
  );
  mocks.manualRefundTaskFindUnique.mockResolvedValue(cardReviewTask());
  mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
  mocks.memberCreditFindUnique.mockResolvedValue(null);
  // #3257: one strand, fully priced, under a headline that already agrees with
  // it - so the re-price this closure now performs is a correct no-op.
  mocks.bookingFindUnique.mockResolvedValue({
    id: "booking-1",
    memberId: "member-1",
    lodgeId: null,
    checkIn: new Date("2026-08-20T00:00:00.000Z"),
    checkOut: new Date("2026-08-21T00:00:00.000Z"),
    totalPriceCents: 15_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 15_000,
    promoRedemptions: [],
    nightAdjustments: [],
    guests: [
      {
        id: "guest-1",
        priceCents: 15_000,
        memberId: "member-1",
        isMember: true,
        stayStart: null,
        stayEnd: null,
        nights: [
          {
            id: "guest-night-1",
            stayDate: new Date("2026-08-20T00:00:00.000Z"),
            priceCents: 15_000,
            priceSource: "SOLD",
          },
        ],
      },
    ],
  });
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingModificationCreate.mockResolvedValue({ id: "mod-rebase-1" });
  // No request for this edit yet, and no supplementary invoice out.
  mocks.paymentTransactionFindFirst.mockResolvedValue(null);
  // #4272: nothing refunded off a request, and no earlier cancelled-share record
  // beyond what this run itself writes - read back from the audit mock, so a
  // second run sees the first one's record exactly as the database would.
  mocks.paymentTransactionFindUnique.mockResolvedValue({ refundedAmountCents: 0, refunds: [] });
  // #4272 review: the booking's status after the commit, read before the Xero leg.
  mocks.bookingStatusFindUnique.mockResolvedValue({ status: "PAID" });
  mocks.auditLogFindMany.mockImplementation(async () =>
    mocks.createAuditLog.mock.calls.map((call) => ({ metadata: (call[0] as { metadata?: unknown }).metadata ?? null })),
  );
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  // ...and no supplementary invoice queued for it either (#3947 review).
  mocks.xeroSyncOperationFindFirst.mockResolvedValue(null);
  // #3947 (option 2): the in-transaction enqueue's ordinary answer - it queued
  // the edit's invoice, which covers the total it was asked for.
  mocks.enqueueChargeInvoiceInTransaction.mockResolvedValue({
    queueOperationId: "op-invoice-1",
    outcome: "covers-total",
    message: "Xero supplementary invoice queued for background processing.",
  });
  mocks.kickOutbox.mockResolvedValue(undefined);
  // One share settled: this completion's own.
  mocks.manualRefundTaskFindMany.mockResolvedValue([settledShare()]);
  mocks.paymentFindUnique.mockResolvedValue({
    id: "payment-1",
    status: PaymentStatus.SUCCEEDED,
    amountCents: 15000,
    refundedAmountCents: 0,
    source: PaymentSource.STRIPE,
    // #3947: the sync re-reads the booking's status with the payment.
    booking: { status: "PAID" },
    stripeCustomerId: "cus_1",
  });
  // The real minter's provider. Each mint answers the next intent id, so the
  // first is `pi_additional_1` exactly as the old stub answered.
  let minted = 0;
  mocks.createPaymentIntent.mockImplementation(async () => {
    minted += 1;
    return { id: `pi_additional_${minted}`, client_secret: `cs_${minted}` };
  });
  mocks.findOrCreateCustomer.mockResolvedValue({ id: "cus_1" });
  // An existing request's intent, in the club's own currency, unpaid: the raise
  // asks Stripe and is told nothing changed, so it raises the same intent.
  mocks.getPaymentIntent.mockResolvedValue({
    id: "pi_additional_1",
    currency: "nzd",
    status: "requires_payment_method",
    customer: "cus_1",
  });
  // The real minter chains `.catch` onto its own recovery enqueue.
  mocks.enqueueAdditionalPaymentIntentRecovery.mockResolvedValue({ id: "recovery-1" });
  // No other change's ask is live unless a case says so.
  mocks.supersedeRead.mockResolvedValue([]);
  mocks.enqueueCancel.mockResolvedValue({ id: "op-cancel-1" });
  mocks.cancelNow.mockResolvedValue("succeeded");
  // #3402: Stripe answers with the amount it now holds; the row is written from it.
  mocks.updatePaymentIntentAmount.mockImplementation(async (id: string, amount: number) => ({
    id,
    amount,
  }));
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.writeRaisedAdditionalRequestAmount.mockResolvedValue(true);
  mocks.enqueueEditFinancialReviewChargeRecovery.mockResolvedValue(undefined);
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

    // #3170 S2: the minter's own captured-card guard passed on the payment as it
    // stands now, re-read after the commit - so it minted exactly once.
    expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
    const call = mint();
    expect(call.bookingId).toBe("booking-1");
    expect(call.amountCents).toBe(20000);
    expect(call.row).toMatchObject({
      paymentId: "payment-1",
      kind: PaymentTransactionKind.ADDITIONAL,
      amountCents: 20000,
      carriedAskCents: 0,
      status: PaymentStatus.PENDING,
    });
    // The refund half of that context is inert: a charge returns nothing.
    expect(mocks.refundPaymentTransactions).not.toHaveBeenCalled();
    // The row carries the anchor, which is how a later share finds this request.
    expect(call.reason).toBe(buildEditFinancialReviewChargeReason("mod-1"));
    expect(call.row?.reason).toBe(buildEditFinancialReviewChargeReason("mod-1"));

    // EDIT-scoped on both keys, which inverts the first #3170 round. The request
    // belongs to the edit, not to the task, so a second review's settlement joins
    // this one rather than minting a rival the mint would then cancel.
    //
    // #3371 fix round: the Stripe key also NAMES THE AMOUNT. The mint's figure is
    // re-derived on every attempt - the share sum can grow and, since #3371, the
    // carried balance can fall - and Stripe answers `idempotency_error` to a key
    // replayed with different parameters, which would strand the ask for good.
    // Built through the shared helper rather than restated, so this asserts the
    // production rule and not a second spelling of it.
    expect(call.idempotencyKey).toBe(
      stripeIdempotencyKeyForAskAmount(
        buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
        20000,
      ),
    );
    // A CONTROL on that: the amount is genuinely IN the key, so a revert to the
    // bare edit-scoped key fails here rather than passing on a substring.
    expect(call.idempotencyKey).not.toBe(
      buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
    );
    // The RECOVERY key only surfaces when a mint fails, so it is asserted in the
    // `not-raised` case below, against the minter's own recovery enqueue.

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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
      // #3947: the sync re-reads the booking's status with the payment.
      booking: { status: "PAID" },
      stripeCustomerId: "cus_1",
    });

    await charge();

    // The real guard fired: nothing was minted, and the debt went to the
    // durable recovery row instead of vanishing.
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).toHaveBeenCalledTimes(1);
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
  });

  it("two admins completing at once: the one that loses the claim raises nothing", async () => {
    // Both read an OPEN row; the second's conditional update matches no row.
    // Nothing after the claim may run, or the club asks for the money twice.
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 0 });

    await expect(charge()).rejects.toMatchObject({ status: 409 });

    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
  });

  it("a charge on a joiner's booking the group organiser paid for by card is REFUSED before the claim (#3653)", async () => {
    // The card behind this payment mirror is the ORGANISER's combined payment:
    // minting an ask would charge the joiner, and so would an invoice. Both
    // instruments are present here, so only the organiser rule can refuse it.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        booking: {
          ...cardReviewTask().booking,
          organiserSettled: true,
          parentBookingId: "organiser-booking-1",
          payment: { ...cardReviewTask().booking.payment, xeroInvoiceId: "inv-1" },
        },
      }),
    );

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_ORGANISER_PAID_MESSAGE,
    });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();

    // The control: the same booking, not organiser-settled, charges as before.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cardReviewTask({
        booking: { ...cardReviewTask().booking, organiserSettled: false, parentBookingId: null },
      }),
    );
    await expect(charge()).resolves.toBeDefined();
  });

  it("#3949: a charge on a joiner's booking the group organiser paid for by internet banking is REFUSED before the claim, in the organiser's words", async () => {
    // With an invoice behind the mirror or without one: the joiner never paid, so neither instrument is theirs.
    for (const xeroInvoiceId of ["inv-1", null]) {
      mocks.manualRefundTaskFindUnique.mockResolvedValue(
        cardReviewTask({
          booking: {
            ...cardReviewTask().booking,
            organiserSettled: true,
            parentBookingId: "organiser-booking-1",
            payment: { ...cardReviewTask().booking.payment, source: "INTERNET_BANKING", xeroInvoiceId },
          },
        }),
      );

      await expect(charge(), String(xeroInvoiceId)).rejects.toMatchObject({ status: 409, message: REVIEW_CHARGE_ORGANISER_PAID_BY_BANK_MESSAGE });
      expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
      expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
      expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
    }
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.additionalPaymentIntentId).toBeNull();
    // #3947 (option 2): queued INSIDE the completion's transaction, for the
    // edit's total, and only kicked after the commit - never re-dispatched.
    expect(mocks.enqueueChargeInvoiceInTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueChargeInvoiceInTransaction).toHaveBeenCalledWith(
      { bookingId: "booking-1", bookingModificationId: "mod-1", totalCents: 20000, createdByMemberId: "admin-1" },
      tx,
    );
    // Queued after the claim, never ahead of it.
    expect(mocks.enqueueChargeInvoiceInTransaction.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.manualRefundTaskUpdateMany.mock.invocationCallOrder[0],
    );
    expect(mocks.kickOutbox).toHaveBeenCalledTimes(1);
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
    expect(mocks.restatePendingSupplementaryInvoiceAmount).not.toHaveBeenCalled();
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.applyLocalRefundAllocation).not.toHaveBeenCalled();
  });

  it("refuses to close a review that did not say which way the money goes", async () => {
    // The unstated default is the whole hazard: "refund" was what silence meant,
    // on the one task type whose nature is that nobody could work the figure out.
    await expect(charge({ direction: null })).rejects.toMatchObject({
      status: 400,
    });

    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
      recordedNightPrices: null,
    }, CLUB_FORMAT_TEST);

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
      recordedNightPrices: null,
    }, CLUB_FORMAT_TEST);

    const claim = mocks.manualRefundTaskUpdateMany.mock.calls[0][0];
    expect(claim.data.settlementDirection).toBeUndefined();
    expect(claim.data.amountCents).toBeUndefined();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
      recordedNightPrices: null,
    } as Parameters<typeof resolveManualRefundTask>[0], CLUB_FORMAT_TEST);
  }

  beforeEach(() => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(secondShareTask());
    // The first share's request is still unpaid, in the club's own currency (the
    // file-level `getPaymentIntent` answer).
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

    // NOTHING IS MINTED, and the first request is NOT cancelled: the real
    // supersede never even looked for an ask to retire (#3341 reads this off the
    // supersede itself rather than inferring it from a stub's silence).
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.supersedeRead).not.toHaveBeenCalled();
    expect(mocks.enqueueCancel).not.toHaveBeenCalled();
  });

  it("re-issues the raised ask in the club's currency when the request was minted in another (#3567)", async () => {
    // The first share's intent was minted in AUD; the club now charges in NZD.
    // Raising it would ask for more in AUD, so it is re-issued, never raised.
    // #3635: the re-issue runs for REAL (`INV-OPS-015`), so what is asserted is
    // the intent and ADDITIONAL row it minted and the ask it retired — not the
    // figure this suite handed a stub.
    mocks.getPaymentIntent.mockResolvedValue({
      id: "pi_additional_1",
      currency: "aud",
      status: "requires_payment_method",
      customer: "cus_1",
    });
    mocks.createPaymentIntent.mockResolvedValue({
      id: "pi_reissued",
      client_secret: "cs_reissued",
      currency: "nzd",
    });
    // The first share's request is the live ask the re-issue retires.
    mocks.supersedeRead.mockResolvedValue([
      { id: "ptx-additional-1", stripePaymentIntentId: "pi_additional_1", amountCents: 20000 },
    ]);
    // The ledger the re-issue's real reconcile reads back: the booking's captured
    // card payment, the old request, and every ADDITIONAL row the re-issue has
    // written by then — so the mirror it writes follows what was minted.
    const ledgerRow = (row: Record<string, unknown>, minute: number) => ({
      source: PaymentSource.STRIPE,
      refundedAmountCents: 0,
      withdrawnAt: null,
      paymentMethodId: null,
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, minute)),
      ...row,
    });
    mocks.paymentFindUnique.mockImplementation(async () => ({
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 15000,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      // #3947: the sync re-reads the booking's status with the payment.
      booking: { status: "PAID" },
      stripeCustomerId: "cus_1",
      stripePaymentIntentId: "pi_primary",
      // #4442: the mirror of the request being re-issued, which the re-issue's queue re-reads.
      additionalPaymentIntentId: "pi_additional_1",
      additionalAmountCents: 20000,
      additionalPaymentStatus: PaymentStatus.PENDING,
      transactions: [
        ledgerRow({ kind: PaymentTransactionKind.PRIMARY, stripePaymentIntentId: "pi_primary", amountCents: 15000, status: PaymentStatus.SUCCEEDED }, 0),
        ledgerRow({ kind: PaymentTransactionKind.ADDITIONAL, stripePaymentIntentId: "pi_additional_1", amountCents: 20000, status: PaymentStatus.PENDING }, 1),
        ...mocks.upsertPaymentIntentTransaction.mock.calls.map(([row], index) =>
          ledgerRow({
            kind: (row as { kind: string }).kind,
            stripePaymentIntentId: (row as { paymentIntentId: string }).paymentIntentId,
            amountCents: (row as { amountCents: number }).amountCents,
            status: (row as { status: string }).status,
          }, 2 + index),
        ),
      ],
    }));

    const result = await settleSecondShare();

    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.getPaymentIntent).toHaveBeenCalledWith("pi_additional_1");
    // Shares plus whatever the first mint carried: $230 on a NEW intent, under a
    // key discriminated by the intent it replaces and the new currency.
    const reissued = mint();
    expect(reissued.amountCents).toBe(23000);
    expect(reissued.idempotencyKey).toBe(
      stripeIdempotencyKeyForAskAmount("pi_additional_1_reissue_nzd", 23000),
    );
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ format: CLUB_FORMAT_TEST, customerId: "cus_1" }),
    );
    // The re-issued ADDITIONAL row carries the same request reason, so the next
    // share finds it, and the whole ask with nothing carried in.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        kind: PaymentTransactionKind.ADDITIONAL,
        paymentIntentId: "pi_reissued",
        amountCents: 23000,
        carriedAskCents: 0,
        status: PaymentStatus.PENDING,
        reason: buildEditFinancialReviewChargeReason("mod-1"),
      }),
    );
    // …and the old-currency request is retired through the durable cancel.
    expect(mocks.enqueueCancel).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentTransactionId: "ptx-additional-1",
      paymentIntentId: "pi_additional_1",
      amountCents: 20000,
      // #4442: queued in the mint's own transaction, beside its row.
      store: expect.anything(),
    });
    // The payment now points its outstanding ask at the NEW intent, for the sum:
    // what the member's pay door and the next share's sizing read back.
    expect(mocks.paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "payment-1" },
        data: expect.objectContaining({
          additionalPaymentIntentId: "pi_reissued",
          additionalAmountCents: 23000,
          additionalPaymentStatus: "PENDING",
        }),
      }),
    );
    expect(result.additionalPaymentIntentId).toBe("pi_reissued");
  });

  it("the payment's outstanding additional is rewritten to the total, on the same row", async () => {
    await settleSecondShare();

    // One ADDITIONAL row, at $230, keyed on the intent that already existed. That
    // is what `reconcilePaymentAggregates` reads into
    // `Payment.additionalAmountCents`, which is the figure the member's pay link
    // and the payment summary both show. #3402: written as AMOUNTS ONLY onto the
    // existing row, never through the upsert that would also restate its status.
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
    expect(mocks.writeRaisedAdditionalRequestAmount).toHaveBeenCalledTimes(1);
    expect(mocks.writeRaisedAdditionalRequestAmount).toHaveBeenCalledWith({
      paymentId: "payment-1",
      paymentIntentId: "pi_additional_1",
      amountCents: 23000,
      carriedAskCents: 0,
    });
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

    expect(mint().amountCents).toBe(23000);
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
    format: CLUB_FORMAT_TEST,
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
      // #3947: the sync re-reads the booking's status with the payment.
      booking: { status: "PAID" },
      stripeCustomerId: "cus_1",
    });
  });

  /**
   * F1, THE MINT THAT PRODUCED NOTHING. This is what the recovery replay meets
   * while the provider is still down, and what it used to close the debt on.
   */
  it("reports `not-raised` and leaves a durable debt when the mint produced no intent", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    // The provider refuses. `createModificationAdditionalPaymentIntent` swallows
    // that and returns empty - it does not throw, which is exactly why the caller
    // has to read the result.
    mocks.createPaymentIntent.mockRejectedValue(new Error("stripe is down"));

    await expect(
      syncEditFinancialReviewChargeRequest(syncArgs),
    ).resolves.toEqual({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
      carriedCents: 0,
    });

    // The debt is durable under the EDIT-scoped recovery key, so the cron replays
    // this same derivation rather than a frozen figure. #3402: through the one
    // helper that owns the edit's two keys and re-arms a closed row.
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentId: "payment-1",
        bookingModificationId: "mod-1",
      }),
    );
    // The minter's OWN catch wrote the row first, under the same EDIT-scoped
    // recovery key the caller passed it - a different string from the Stripe key
    // it tried, so one cannot stand in for the other.
    const minterRecovery = mocks.enqueueAdditionalPaymentIntentRecovery.mock
      .calls[0][0] as { idempotencyKey: string; stripeIdempotencyKey: string };
    expect(minterRecovery.idempotencyKey).toBe(
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-1"),
    );
    expect(minterRecovery.idempotencyKey).not.toBe(
      minterRecovery.stripeIdempotencyKey,
    );
    // A failed mint retires nothing.
    expect(mocks.supersedeRead).not.toHaveBeenCalled();
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
      // #3947: the sync re-reads the booking's status with the payment.
      booking: { status: "PAID" },
      stripeCustomerId: null,
    });

    const result = await syncEditFinancialReviewChargeRequest(syncArgs);

    expect(result.outcome).toBe("not-raised");
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).toHaveBeenCalledTimes(1);
  });

  /**
   * THE CONTROL for both tests above. A sync that raised the request must say so,
   * and must NOT write a recovery row - otherwise the cron would replay a debt
   * that has already been asked for.
   */
  it("reports `raised` and enqueues nothing when the mint produced an intent", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    mocks.createPaymentIntent.mockResolvedValue({
      id: "pi_additional_9",
      client_secret: "secret",
    });

    await expect(
      syncEditFinancialReviewChargeRequest(syncArgs),
    ).resolves.toEqual({
      outcome: "raised",
      paymentIntentId: "pi_additional_9",
      totalCents: 23000,
      carriedCents: 0,
    });
    expect(mocks.enqueueAdditionalPaymentIntentRecovery).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
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
      carriedCents: 0,
    });

    // Nothing was restated on a paid ask...
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
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
      carriedCents: 0,
    });
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.enqueueAdditionalPaymentIntentRecovery).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
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
 * `short-in-flight` or `short-sent`. Only the second buys a separate invoice;
 * these cases are all the sent one.
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
      recordedNightPrices: null,
    } as Parameters<typeof resolveManualRefundTask>[0], CLUB_FORMAT_TEST);
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
      supplementaryInvoice: "short-sent",
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
      supplementaryInvoice: "short-sent",
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
      supplementaryInvoice: "short-sent",
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
      supplementaryInvoice: "short-sent",
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
      format: CLUB_FORMAT_TEST,
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
      format: CLUB_FORMAT_TEST,
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
   * A REFUND settles its own amount and queues a credit note; a shortfall cannot
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
      supplementaryInvoice: "short-sent",
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


/*
  #3371 - A REVIEW CHARGE RAISED WHILE ANOTHER CHANGE'S EXTRA IS STILL UNPAID.

  ENFORCES `INV-PAY-098` (and `INV-PAY-047`, which is the ledger identity it
  keeps true).

  THE PROVED SEQUENCE, from the reachability proof on #3371:

    1. a member extends their stay; the edit cannot be priced, so it PARKS;
    2. an officer prices that review at $200 and settles it as a charge;
    3. the member does not pay - this is collected on their own pay link, so the
       window is days;
    4. a second money-affecting edit parks and raises its own review. The only
       fence checks for an OPEN review task, and settling step 2 closed it;
    5. the officer prices that review at $60 and settles it;
    6. minting the $60 request RETIRED the $200 one.

  $260 priced, $60 collected, and no member- or officer-facing surface reported
  the missing $200. Both review tasks read as completed with their amounts
  recorded; the member's pay page simply showed the newer, smaller figure.

  The owner's decision of 13 Sep 2026 is that the new charge CARRIES that unpaid
  balance, and that the carried amount is recorded as its OWN fact rather than
  folded invisibly into the share total - because the share total staying
  monotone is what lets this path run its compare-and-set with no advisory lock
  across the Stripe call.

  Clock: every figure here is integer cents; the frozen clock is inherited and
  never consulted.
*/
describe("#3371: a review charge carries the unpaid ask its mint retires", () => {
  /** The other change's live, unpaid $200 ask, as the payment records it. */
  function paymentCarrying(
    additionalAmountCents: number,
    additionalPaymentStatus: string | null,
  ) {
    return {
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 15000,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      // #3947: the sync re-reads the booking's status with the payment.
      booking: { status: "PAID" },
      stripeCustomerId: "cus_1",
      additionalAmountCents,
      additionalPaymentStatus,
    };
  }

  beforeEach(() => {
    // Step 5: this edit's own review settles at $60, and it is the only share
    // against THIS edit.
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare({ amountCents: 6000 }),
    ]);
    // No request for THIS edit yet - which is exactly what proves the $200 on
    // the payment belongs to a DIFFERENT one.
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);
    mocks.paymentFindUnique.mockResolvedValue(
      paymentCarrying(20000, PaymentStatus.PENDING),
    );
    // ...and the ledger row behind it, which the REAL supersede finds (#3341).
    mocks.supersedeRead.mockResolvedValue([
      { id: "ptx-other-change", stripePaymentIntentId: "pi_other_change", amountCents: 20000 },
    ]);
  });

  it("asks for $260, not $60 - the exact sequence the proof exhibited", async () => {
    await charge({ confirmedAmountCents: 6000 });

    const call = mint();
    // Before the fix this was 6000 and the $200 simply ceased to be owed.
    expect(call.amountCents).toBe(26000);
    expect(call.row).toMatchObject({ amountCents: 26000, carriedAskCents: 20000 });
    // And the $200 ask it absorbed really is retired, not left live beside it:
    // mint -> supersede -> one ask for everything owed.
    expect(mocks.enqueueCancel).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentTransactionId: "ptx-other-change",
      paymentIntentId: "pi_other_change",
      amountCents: 20000,
      // #4442: queued in the mint's own transaction, beside its row.
      store: expect.anything(),
    });
    expect(
      mocks.upsertPaymentIntentTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.enqueueCancel.mock.invocationCallOrder[0]);
  });

  it("keeps the carried money OUT of this edit's Xero invoice", async () => {
    // The accounting leg bills one invoice per edit (`INV-PAY-070`). The earlier
    // change has its own invoice for its own $200, so putting it on this one
    // would bill the member twice for the same money - the exact failure this
    // change exists to prevent, in the other direction.
    await charge({ confirmedAmountCents: 6000 });
    await flushDispatch();

    const xero = mocks.queueXeroBookingEditSettlement.mock.calls[0][0];
    expect(xero.priceDiffCents).toBe(6000);
  });

  it("records what it absorbed where an officer can find it", async () => {
    await charge({ confirmedAmountCents: 6000 });

    const entry = mocks.createAuditLog.mock.calls
      .map((args) => args[0])
      .find(
        (arg) =>
          arg.action === "booking.editFinancialReview.chargeCarriedUnpaidBalance",
      );
    expect(
      entry,
      "INV-PAY-098: once the earlier ask is cancelled, what it was owed for is " +
        "not derivable from anything. The audit row is the story; the ledger " +
        "column is the figure.",
    ).toBeDefined();
    expect(entry.category).toBe("payment");
    expect(entry.metadata).toMatchObject({
      bookingModificationId: "mod-1",
      shareTotalCents: 6000,
      carriedCents: 20000,
      askedTotalCents: 26000,
    });
    // The prose carries the figures, because an officer reads the list rather
    // than the metadata blob.
    expect(entry.summary).toContain("$200.00");
    expect(entry.details).toContain("$260.00");
  });

  it("carries nothing, and says nothing, when no other ask was outstanding", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentCarrying(0, null));
    mocks.supersedeRead.mockResolvedValue([]);

    await charge({ confirmedAmountCents: 6000 });

    const call = mint();
    expect(call.amountCents).toBe(6000);
    expect(call.row?.carriedAskCents).toBe(0);
    expect(mocks.enqueueCancel).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeCarriedUnpaidBalance",
      }),
    );
  });

  it("carries nothing when the other change's extra has already been PAID", async () => {
    mocks.paymentFindUnique.mockResolvedValue(
      paymentCarrying(20000, PaymentStatus.SUCCEEDED),
    );
    // A captured intent is not a live ask; the supersede finds nothing to retire.
    mocks.supersedeRead.mockResolvedValue([]);

    await charge({ confirmedAmountCents: 6000 });

    const call = mint();
    expect(call.amountCents).toBe(6000);
    expect(call.row?.carriedAskCents).toBe(0);
  });

  /*
    #3371 fix round - THE REPLAY HAZARD THE CARRIED BALANCE ADDS, and the reason
    the Stripe key moved.

    The mint's amount is re-derived on every attempt. Before #3371 the only thing
    that could move it between a failed mint and its recovery replay was a second
    review task settling; #3371 adds a second mover, and it is the commoner one -
    the member paying the earlier change's ask, which they can do at any point in
    the days the chase reminders run.

    Stripe refuses a key replayed with different parameters. On a FIXED key the
    replay would answer `idempotency_error`, the catch would re-enqueue, and every
    later replay would fail identically - the review charge never raised at all.

    Both halves are asserted: the same figure keeps the same key (so a genuine
    replay still converges on the one intent, which is #3170's whole point), and a
    moved figure gets a different one.
  */
  it("keeps the Stripe key stable across a replay of the SAME figure", async () => {
    await charge({ confirmedAmountCents: 6000 });
    await charge({ confirmedAmountCents: 6000 });

    const keys = [mint(0).idempotencyKey, mint(1).idempotencyKey];
    // A CONTROL on the comparison: two calls really happened, so this cannot
    // pass by comparing one call with itself.
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("moves the Stripe key when the carried balance is paid off between attempts", async () => {
    await charge({ confirmedAmountCents: 6000 });
    const minted = mint(0);

    // The member pays the earlier change's $200 before the replay reaches this.
    mocks.paymentFindUnique.mockResolvedValue(
      paymentCarrying(20000, PaymentStatus.SUCCEEDED),
    );
    mocks.supersedeRead.mockResolvedValue([]);
    await charge({ confirmedAmountCents: 6000 });
    const replayed = mint(1);

    expect(minted.amountCents).toBe(26000);
    expect(replayed.amountCents).toBe(6000);
    expect(
      replayed.idempotencyKey,
      "INV-PAY-098: a re-derived amount under the same Stripe key is a permanent " +
        "idempotency_error, and the charge is then never raised at all.",
    ).not.toBe(minted.idempotencyKey);
    expect(replayed.idempotencyKey).toBe(
      stripeIdempotencyKeyForAskAmount(
        buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
        6000,
      ),
    );
  });

  it("carries an extra the member's card DECLINED, which is still owed", async () => {
    mocks.paymentFindUnique.mockResolvedValue(
      paymentCarrying(7000, PaymentStatus.FAILED),
    );
    // A declined intent is already dead, so there is nothing live to retire -
    // but the money it asked for is still owed, and carried.
    mocks.supersedeRead.mockResolvedValue([]);

    await charge({ confirmedAmountCents: 6000 });

    const call = mint();
    expect(call.amountCents).toBe(13000);
    expect(call.row?.carriedAskCents).toBe(7000);
  });

  it("records NOTHING as carried when the mint produced no intent", async () => {
    // A failed mint retires nothing - the other change's ask is still live, and
    // the replay reads it again. Writing the provenance here would claim an
    // absorption that never happened.
    mocks.createPaymentIntent.mockRejectedValue(new Error("stripe is down"));

    await charge({ confirmedAmountCents: 6000 });

    expect(mocks.createAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.editFinancialReview.chargeCarriedUnpaidBalance",
      }),
    );
  });
});

/*
  #3371 - THE RE-DERIVATION, ONCE A CARRIED BALANCE IS IN THE ROW.

  This is the half the earlier negative proof said could not work. It works
  because the carried part is stored SEPARATELY from the share total: the sum is
  re-derived from the settled shares as it always was, the carried part is read
  back off the row, and the request asks for both. The sum only grows and the
  carried part never moves, so the figure is monotone and the refuse-to-lower
  rule stays correct.
*/
describe("#3371: a later share joins a request that carried a balance", () => {
  /** The $260 request the mint above wrote: $60 of shares, $200 carried. */
  function carryingRequest(overrides: Record<string, unknown> = {}) {
    return chargeRequestRow({
      amountCents: 26000,
      carriedAskCents: 20000,
      ...overrides,
    });
  }

  beforeEach(() => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(carryingRequest());
  });

  it("raises to shares-plus-carried, never to the shares alone", async () => {
    // A second task of the SAME edit settles for another $40: $100 of shares.
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare({ amountCents: 6000 }),
      settledShare({ id: "task-2", amountCents: 4000 }),
    ]);

    await charge({ confirmedAmountCents: 4000 });

    expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledWith(
      "pi_additional_1",
      30000,
    );
    expect(mocks.writeRaisedAdditionalRequestAmount).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_additional_1",
        amountCents: 30000,
        // Restated from the same value that sized the amount, and unchanged: a
        // raise supersedes nothing, so it absorbs nothing new.
        carriedAskCents: 20000,
      }),
    );
  });

  it("re-reads the carried figure off the ROW, never off the payment", async () => {
    // THE TRAP. By now `Payment.additionalAmountCents` mirrors THIS request's
    // own $260. Re-deriving the carried part from it would fold the request into
    // itself and ask for $360 against $300 of real debt.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 15000,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      // #3947: the sync re-reads the booking's status with the payment.
      booking: { status: "PAID" },
      stripeCustomerId: "cus_1",
      additionalAmountCents: 26000,
      additionalPaymentStatus: PaymentStatus.PENDING,
    });
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare({ amountCents: 6000 }),
      settledShare({ id: "task-2", amountCents: 4000 }),
    ]);

    await charge({ confirmedAmountCents: 4000 });

    expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledWith(
      "pi_additional_1",
      30000,
    );
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalledWith(
      "pi_additional_1",
      36000,
    );
  });

  it("still bills the Xero leg this edit's shares alone", async () => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare({ amountCents: 6000 }),
      settledShare({ id: "task-2", amountCents: 4000 }),
    ]);
    mocks.restatePendingSupplementaryInvoiceAmount.mockResolvedValue({
      restated: 1,
      alreadyCovering: 0,
    });

    await charge({ confirmedAmountCents: 4000 });
    await flushDispatch();

    expect(mocks.restatePendingSupplementaryInvoiceAmount).toHaveBeenCalledWith({
      bookingModificationId: "mod-1",
      priceDiffCents: 10000,
      changeFeeCents: 0,
    });
  });

  it("a STALE run still cannot lower the request", async () => {
    // Shares of $60 against a request that already asks $260. Without the
    // carried part in the comparison this would read as a $200 over-ask and
    // LOWER a live intent to $60 - handing the member back the very money the
    // fix exists to collect.
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare({ amountCents: 6000 }),
    ]);

    await charge({ confirmedAmountCents: 6000 });

    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
  });

  it("measures a shortfall against this edit's shares, not the carried total", async () => {
    // The member paid the $260 before a further $40 share could join it. The
    // club is short $40, not short nothing: without taking the carried $200 back
    // out, `derived - requested` would be 10000 - 26000 and floor at zero, and
    // the record would say the money was collected.
    //
    // The SYNC is entered directly, exactly as the #3170 fix-round test of this
    // same race does: the pre-claim refusal is the ordinary guard for a paid
    // request, and this is the window behind it.
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      carryingRequest({ status: PaymentStatus.SUCCEEDED }),
    );
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare({ amountCents: 6000 }),
      settledShare({ id: "task-2", amountCents: 4000 }),
    ]);

    await expect(
      syncEditFinancialReviewChargeRequest({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        bookingModificationId: "mod-1",
        paymentId: "payment-1",
        member: {
          id: "member-1",
          email: "grace@example.test",
          name: "Grace Hopper",
          stripeCustomerId: "cus_1",
        },
        hasIssuedXeroInvoice: true,
      }),
    ).resolves.toEqual({
      outcome: "already-paid",
      paymentIntentId: "pi_additional_1",
      // The SHARE part of what was asked for - never the $260, which the Xero
      // leg would then bill this edit for.
      totalCents: 6000,
      carriedCents: 20000,
    });

    const entry = mocks.createAuditLog.mock.calls
      .map((args) => args[0])
      .find(
        (arg) =>
          arg.action === "booking.editFinancialReview.chargeShareUncollected",
      );
    expect(entry).toBeDefined();
    expect(entry.metadata).toMatchObject({
      leg: "payment-request",
      derivedTotalCents: 10000,
      requestedTotalCents: 26000,
      carriedAskCents: 20000,
      uncollectedCents: 4000,
    });
    expect(entry.summary).toContain("$40.00");
    // And the prose says WHY the member was asked for more than this change's
    // reviews come to, so the two figures do not read as a contradiction.
    expect(entry.details).toContain("$260.00");
    expect(entry.details).toContain("carried into this request");
  });
});

/**
 * #3947 (owner decision 15 Oct 2026): a booking paid WHOLLY WITH ACCOUNT CREDIT
 * carries `{ amountCents: 0, SUCCEEDED, STRIPE }` and no PaymentIntent. Before
 * this, the review charge asked `hasCapturedPayment`, whose `amountCents > 0`
 * clause answered "no card": with no issued invoice the officer was refused,
 * and with one the charge went to a Xero supplementary invoice. The edit doors
 * have asked the card for such a booking since #3502; the review charge now
 * asks the same question (`canAskCardForReviewCharge`) at BOTH sites - the
 * chooser before the claim and the sync's mint after the commit - so the route
 * chosen as "card" is minted for rather than left to a replay that never raises.
 */
describe("#3947: a booking paid wholly with credit is asked by card", () => {
  /** The review task on a settled, credit-paid booking; `payment` overrides its row. */
  function creditPaidTask({
    status = "PAID",
    payment = {},
  }: { status?: string; payment?: Record<string, unknown> } = {}) {
    return cardReviewTask({
      booking: {
        ...cardReviewTask().booking,
        status,
        payment: {
          id: "payment-1",
          status: "SUCCEEDED",
          amountCents: 0,
          refundedAmountCents: 0,
          xeroInvoiceId: null,
          source: PaymentSource.STRIPE,
          // Credit paid it: no card was ever taken, so there may be no customer.
          stripeCustomerId: null,
          ...payment,
        },
      },
    });
  }

  /** The sync's post-commit re-read of the same payment and its booking. */
  function creditPaidReread(status = "PAID") {
    return {
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 0,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      stripeCustomerId: null,
      booking: { status },
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    };
  }

  beforeEach(() => {
    mocks.paymentFindUnique.mockResolvedValue(creditPaidReread());
  });

  it("mints a card ask with Xero OFF (no issued invoice), where it used to be refused", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(creditPaidTask());

    const result = await charge();

    expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
    const call = mint();
    expect(call.amountCents).toBe(20000);
    expect(call.row).toMatchObject({
      paymentId: "payment-1",
      kind: PaymentTransactionKind.ADDITIONAL,
      amountCents: 20000,
      status: PaymentStatus.PENDING,
    });
    // No customer on a credit-paid payment, so the minter makes one for the member.
    expect(mocks.findOrCreateCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member-1", email: "grace@example.test" }),
    );
    expect(result.additionalPaymentIntentId).toBe("pi_additional_1");
    // Raised inline: no debt is left for a replay to carry.
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("mints a card ask with an ISSUED invoice too, rather than billing a supplementary invoice", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      creditPaidTask({ payment: { xeroInvoiceId: "xero-inv-1" } }),
    );

    const result = await charge();

    expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mint().amountCents).toBe(20000);
    expect(result.additionalPaymentIntentId).toBe("pi_additional_1");
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
    // The invoice leg waits on the card ask, as on any card-route charge.
    const xero = mocks.queueXeroBookingEditSettlement.mock.calls[0][0];
    expect(xero.priceDiffCents).toBe(20000);
    expect(xero.requiresAdditionalStripePayment).toBe(true);
    expect(xero.additionalPaymentIntentId).toBe("pi_additional_1");
  });

  it("the recovery replay's re-entry raises it and may close its row", async () => {
    // `payment-recovery.ts` re-enters the sync with the frozen invoice answer
    // (here `null`, the replay's own re-entry) and closes the row only on an
    // outcome `EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY` allows. Before #3947 the
    // sync's own guard answered "no card" for this payment, so the outcome was
    // `not-raised` on every replay until the row died FAILED.
    mocks.paymentTransactionFindFirst.mockResolvedValue(null);

    const synced = await syncEditFinancialReviewChargeRequest({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      paymentId: "payment-1",
      member: {
        id: "member-1",
        email: "grace@example.test",
        name: "Grace Hopper",
        stripeCustomerId: null,
      },
      hasIssuedXeroInvoice: null,
    });

    expect(synced).toMatchObject({
      outcome: "raised",
      paymentIntentId: "pi_additional_1",
      totalCents: 20000,
    });
    expect(EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY[synced.outcome]).toBe(true);
    expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
  });

  /**
   * #3947 review rounds 1 and 2: ONE INSTRUMENT PER EDIT. The outbox read is
   * answered by EVALUATING the chooser's own `where` against these rows, so a
   * chooser that asked a narrower question (round 1's restatable set, which
   * missed RUNNING and FAILED) finds nothing and fails these tests, rather than
   * a stub agreeing with whatever it was asked.
   */
  describe("one instrument per edit (review rounds 1 and 2)", () => {
    type OutboxRow = Record<string, unknown>;
    let outboxRows: OutboxRow[] = [];

    function matches(row: OutboxRow, where: Record<string, unknown>): boolean {
      return Object.entries(where).every(([key, condition]) => {
        if (key === "OR") {
          return (condition as Record<string, unknown>[]).some((arm) => matches(row, arm));
        }
        if (condition !== null && typeof condition === "object" && "in" in condition) {
          return (condition as { in: unknown[] }).in.includes(row[key]);
        }
        if (condition !== null && typeof condition === "object" && "not" in condition) {
          return (row[key] ?? null) !== (condition as { not: unknown }).not;
        }
        if (condition !== null && typeof condition === "object" && "path" in condition) {
          const { path, equals } = condition as { path: string[]; equals: unknown };
          return (row[key] as Record<string, unknown> | undefined)?.[path[0]] === equals;
        }
        return (row[key] ?? null) === condition;
      });
    }

    /** Share A's supplementary invoice for this edit, in the given state. */
    function shareAInvoice(overrides: OutboxRow = {}): OutboxRow {
      return {
        id: "op-share-a-invoice",
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "BookingModification",
        localId: "mod-1",
        queueType: "SUPPLEMENTARY_INVOICE",
        requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", priceDiffCents: 6000 },
        status: "PENDING",
        manuallyResolvedAt: null,
        ...overrides,
      };
    }

    beforeEach(() => {
      outboxRows = [];
      mocks.xeroSyncOperationFindFirst.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          outboxRows.find((row) => matches(row, where)) ?? null,
      );
      // Share A ($60) settled before #3947 on the invoice route; this is share
      // B ($40) of the same edit, on a credit-paid booking with an issued
      // invoice and no card request for the edit.
      mocks.manualRefundTaskFindUnique.mockResolvedValue(
        creditPaidTask({ payment: { xeroInvoiceId: "xero-inv-1" } }),
      );
      mocks.manualRefundTaskFindMany.mockResolvedValue([
        settledShare({ id: "task-a", amountCents: 6000 }),
        settledShare({ id: "task-1", amountCents: 4000 }),
      ]);
    });

    /** The edit's one invoice was asked, inside the completion, for this total - and nothing re-dispatched it. */
    function expectInvoiceAskedFor(totalCents: number) {
      expect(mocks.enqueueChargeInvoiceInTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueChargeInvoiceInTransaction.mock.calls[0][0]).toMatchObject({
        bookingModificationId: "mod-1",
        totalCents,
      });
      expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
      expect(mocks.restatePendingSupplementaryInvoiceAmount).not.toHaveBeenCalled();
    }

    /** How many times the chooser asked whether the edit's invoice is still coming. */
    function stillComingReads(): number {
      return mocks.xeroSyncOperationFindFirst.mock.calls.filter(
        ([args]) => "OR" in (args as { where: Record<string, unknown> }).where,
      ).length;
    }

    /** B stayed on the invoice route: no card ask of any kind. */
    function expectNoCardAsk(result: { additionalPaymentIntentId: string | null }) {
      expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
      expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
      expect(result.additionalPaymentIntentId).toBeNull();
    }

    it("a QUEUED invoice: B joins it, and the restate bills $100 on that one invoice", async () => {
      outboxRows = [shareAInvoice({ status: "PENDING" })];

      const result = await charge({ confirmedAmountCents: 4000 });

      // The chooser asked the shared read, for this edit.
      expect(mocks.xeroSyncOperationFindFirst).toHaveBeenCalledWith({
        where: supplementaryInvoiceStillComingWhere({ localModel: "BookingModification", localId: "mod-1" }),
        select: { id: true },
      });
      expectNoCardAsk(result);
      // ...and the edit's one invoice is asked for $100, from inside B's own
      // transaction (the enqueue raises A's queued row; option 2).
      expectInvoiceAskedFor(10000);
    });

    it("a RUNNING invoice (round 2, F1): B still stays off the card", async () => {
      // The outbox is sending A's $60 right now. The restate cannot raise a
      // RUNNING row, so B's leg falls to the enqueue, which answers
      // short-in-flight and the existing short-ask audit records the $40. A
      // card ask for $100 here would leave the member asked $160 for $100.
      outboxRows = [shareAInvoice({ status: "RUNNING" })];
      mocks.enqueueChargeInvoiceInTransaction.mockResolvedValue({
        queueOperationId: "op-share-a-invoice",
        outcome: "short-in-flight",
        message: "Xero supplementary invoice for this change is already being sent and could not be raised.",
      });

      const result = await charge({ confirmedAmountCents: 4000 });

      expectNoCardAsk(result);
      expectInvoiceAskedFor(10000);
      // The enqueue's verdict reaches the one short-ask recorder after the commit.
      expect(
        mocks.createAuditLog.mock.calls.some(
          ([entry]) => entry.action === "booking.editFinancialReview.chargeShareUncollected",
        ),
      ).toBe(true);
    });

    it("a RUNNING invoice the cooldown hands back to PENDING (round 2, F1): B's in-transaction enqueue raises THAT invoice, beside no card ask", async () => {
      // Chosen while RUNNING; by the time B's enqueue decides - inside B's own
      // completion transaction since option 2 - a Xero cooldown has returned
      // A's un-attempted row to PENDING, so the enqueue raises it to $100. Had B
      // taken the card, that would be a $100 invoice beside a $100 card ask.
      outboxRows = [shareAInvoice({ status: "RUNNING" })];
      // By the time B's enqueue decides, the cooldown has handed A's row back,
      // so the enqueue raises it to the edit's total.
      mocks.enqueueChargeInvoiceInTransaction.mockImplementation(async () => {
        outboxRows = [shareAInvoice({ status: "PENDING", requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", priceDiffCents: 10000 } })];
        return { queueOperationId: "op-share-a-invoice", outcome: "covers-total", message: "raised" };
      });

      const result = await charge({ confirmedAmountCents: 4000 });

      expectNoCardAsk(result);
      expectInvoiceAskedFor(10000);
    });

    it("a FAILED invoice nobody has resolved (round 2, F2): B stays off the card, so a Requeue cannot land beside a card ask", async () => {
      outboxRows = [shareAInvoice({ status: "FAILED", manuallyResolvedAt: null })];

      const result = await charge({ confirmedAmountCents: 4000 });

      expectNoCardAsk(result);
    });

    it("a FAILED invoice an officer marked resolved in Xero is DONE (round 4, money F1): B is refused, never asked beside it", async () => {
      // The officer made A's invoice by hand (`INV-INT-025`: done, never minted
      // beside). Asking B's card for the edit's $100 next to that hand-made $60
      // would bill the member twice, so the share is refused exactly as one
      // arriving after the invoice was issued is, with the task left OPEN.
      outboxRows = [
        shareAInvoice({ status: "FAILED", manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z") }),
      ];

      await expect(charge({ confirmedAmountCents: 4000 })).rejects.toMatchObject({
        status: 409,
        message: REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
      });
      expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
      expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
      expect(mocks.enqueueChargeInvoiceInTransaction).not.toHaveBeenCalled();
    });

    it("a resolve mark WITHDRAWN between B's reads, because A's retry is running, still keeps B off the card (round 5)", async () => {
      // An officer marks A's FAILED invoice resolved; the resolve route then
      // finds a retry of it running (`findRetryOverlappingMark`) and withdraws
      // the mark. B's first read lands while the mark stands, its second after
      // it is withdrawn. Reading A's mark alone, B sees "not coming" (resolved)
      // and then "not done" (unresolved) and takes the card - while the retry
      // sends A's invoice. The live retry on the anchor is what says "coming"
      // in every state of the mark.
      const markedAt = new Date("2026-06-30T00:00:00.000Z");
      const requeue: OutboxRow = {
        id: "op-share-a-requeue",
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "REQUEUE",
        localModel: "BookingModification",
        localId: "mod-1",
        queueType: null,
        requestPayload: { originalOperationId: "op-share-a-invoice", originalOperationType: "CREATE", originalStatus: "FAILED" },
        status: "RUNNING",
        manuallyResolvedAt: null,
      };
      outboxRows = [shareAInvoice({ status: "FAILED", manuallyResolvedAt: markedAt }), requeue];
      let withdrawn = false;
      mocks.xeroSyncOperationFindFirst.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) => {
          const found = outboxRows.find((row) => matches(row, where)) ?? null;
          if (!withdrawn) {
            withdrawn = true;
            outboxRows = [shareAInvoice({ status: "FAILED", manuallyResolvedAt: null }), requeue];
          }
          return found;
        },
      );

      const result = await charge({ confirmedAmountCents: 4000 });

      expectNoCardAsk(result);
      expectInvoiceAskedFor(10000);
    });

    it("the outbox worker sending A's invoice BETWEEN B's two reads still keeps B off the card (round 4, concurrency F1)", async () => {
      // The worker moves A's row from still-coming to issued (SUCCEEDED and its
      // link) in one commit, under no lock B holds. Simulated here at the
      // instant after B's FIRST outbox-or-link read, whichever that is. Read
      // still-coming first (the fix), B sees it coming and then sees the link,
      // and is refused; read the link first, B sees "no link" and then
      // "nothing coming", and takes the card beside the invoice just sent.
      outboxRows = [shareAInvoice({ status: "RUNNING" })];
      let linked = false;
      let committed = false;
      const workerCommits = () => {
        if (committed) return;
        committed = true;
        outboxRows = [shareAInvoice({ status: "SUCCEEDED" })];
        linked = true;
      };
      mocks.xeroSyncOperationFindFirst.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) => {
          const found = outboxRows.find((row) => matches(row, where)) ?? null;
          workerCommits();
          return found;
        },
      );
      mocks.xeroObjectLinkFindFirst.mockImplementation(
        async ({ where }: { where: { role?: string } }) => {
          if (where.role !== "SUPPLEMENTARY_INVOICE") return null;
          const found = linked ? { id: "link-share-a" } : null;
          workerCommits();
          return found;
        },
      );

      await expect(charge({ confirmedAmountCents: 4000 })).rejects.toMatchObject({
        status: 409,
        message: REVIEW_CHARGE_REQUEST_CLOSED_MESSAGE,
      });
      expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("an in-transaction enqueue that THROWS rejects the completion, with no post-commit work (round 4, money F3)", async () => {
      // The invoice is written in the completion's own transaction, so a write
      // that fails takes the whole completion with it: Prisma rolls the claim
      // back and the task stays OPEN. The transaction double here only runs the
      // callback, so the rollback itself is Prisma's; that the enqueue is inside
      // the completion's ONE transaction (A cannot commit while it waits) is
      // proven against PostgreSQL in `edit-financial-review-races.realdb.test.ts`.
      outboxRows = [shareAInvoice({ status: "PENDING" })];
      mocks.enqueueChargeInvoiceInTransaction.mockRejectedValue(new Error("unique violation"));

      await expect(charge({ confirmedAmountCents: 4000 })).rejects.toThrow("unique violation");
      // It ran INSIDE the transaction, after the claim it would roll back...
      expect(mocks.enqueueChargeInvoiceInTransaction.mock.calls[0][1]).toBe(tx);
      expect(mocks.enqueueChargeInvoiceInTransaction.mock.invocationCallOrder[0]).toBeGreaterThan(
        mocks.manualRefundTaskUpdateMany.mock.invocationCallOrder[0],
      );
      // ...and nothing that runs after a commit ran at all.
      await flushDispatch();
      expect(mocks.kickOutbox).not.toHaveBeenCalled();
      expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroSecondSupplementaryInvoiceOperation).not.toHaveBeenCalled();
      expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    });

    it("an invoice-route share its queued invoice could not take (short-sent) reaches the SECOND ASK for that share alone (round 4, money F3)", async () => {
      outboxRows = [shareAInvoice({ status: "PENDING" })];
      mocks.enqueueChargeInvoiceInTransaction.mockResolvedValue({
        queueOperationId: null,
        outcome: "short-sent",
        message: "Xero supplementary invoice already linked for this modification.",
      });

      const result = await charge({ confirmedAmountCents: 4000 });

      expectNoCardAsk(result);
      await flushDispatch();
      expect(mocks.enqueueXeroSecondSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);
      const [params] = mocks.enqueueXeroSecondSupplementaryInvoiceOperation.mock.calls[0] as [
        { bookingModificationId: string; reviewTaskId: string; shareCents: number },
      ];
      // THIS share, anchored on THIS task - never the edit's $100.
      expect(params).toMatchObject({ bookingModificationId: "mod-1", reviewTaskId: "task-1", shareCents: 4000 });
      // Nothing was queued, so there is nothing to kick.
      expect(mocks.kickOutbox).not.toHaveBeenCalled();
    });

    it("CONTROL: another edit's invoice, or none, leaves B on the card", async () => {
      outboxRows = [shareAInvoice({ localId: "mod-other" })];

      const result = await charge({ confirmedAmountCents: 4000 });

      expect(stillComingReads()).toBe(1);
      expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
      expect(result.additionalPaymentIntentId).toBe("pi_additional_1");
    });

    it("CONTROL: a card-route edit's own waiting invoice does not move its next share off the card", async () => {
      // The card route's supplementary invoice waits on its request, so a card
      // request ALWAYS exists beside it; the chooser does not even ask.
      mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow());
      outboxRows = [shareAInvoice({ status: "WAITING_PAYMENT" })];
      mocks.manualRefundTaskFindMany.mockResolvedValue([
        settledShare({ id: "task-a", amountCents: 20000 }),
        settledShare({ id: "task-1", amountCents: 3000 }),
      ]);

      await charge({ confirmedAmountCents: 3000 });

      expect(stillComingReads()).toBe(0);
      expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledWith("pi_additional_1", 23000);
    });
  });

  it("CONTROL: an internet-banking booking re-priced to $0 is NOT asked by card", async () => {
    // `source` is half the question: a hand-settled $0 row has no card behind it.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      creditPaidTask({ payment: { source: PaymentSource.INTERNET_BANKING } }),
    );

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
    });
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("CONTROL: a $0 payment on a booking that has left the settled statuses is still refused", async () => {
    // The decision covered SETTLED credit-paid bookings, the edit doors' rule.
    // Not CANCELLED: that has its own refusal (#4272), below.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      creditPaidTask({ status: "AWAITING_REVIEW" }),
    );

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_NO_INSTRUMENT_MESSAGE,
    });
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
  });
});

/**
 * #4272 (owner decision 21 Oct 2026): a review charge on a CANCELLED booking is
 * REFUSED before the claim. A card ask on it is one the member can never pay
 * (`INV-ADDPAY-023`), and the recovery replay already skips a cancelled booking,
 * so the inline path now agrees with it. Before this, a cancelled booking still
 * holding card money took the card route and minted that unpayable ask.
 */
describe("#4272: a review charge on a cancelled booking is refused", () => {
  /** The card-paid review task on a CANCELLED booking; `booking` overrides it. */
  function cancelledTask(booking: Record<string, unknown> = {}) {
    return cardReviewTask({
      booking: { ...cardReviewTask().booking, status: "CANCELLED", ...booking },
    });
  }

  /** Nothing claimed, minted, raised, invoiced or audited: the task stays OPEN. */
  function expectNothingWritten() {
    expect(mocks.manualRefundTaskUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
    expect(mocks.enqueueChargeInvoiceInTransaction).not.toHaveBeenCalled();
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  }

  it("refuses a cancelled booking holding money captured on a card, before the claim", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(cancelledTask());

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE,
    });
    expectNothingWritten();
  });

  // #4316 (`INV-ADDPAY-044`): a BUMPED booking has ended too, and the sentence names it.
  it("refuses a bumped booking with the ended-booking sentence, before the claim", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(cancelledTask({ status: "BUMPED" }));

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE,
    });
    expect(REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE).toContain("has ended (cancelled or bumped)");
    expectNothingWritten();
  });

  it("refuses a cancelled booking whose edit already has an open card request, raising nothing", async () => {
    // A second share of an edit whose first share was asked by card before the
    // cancellation: raising that request would ask again on the cancelled booking.
    mocks.manualRefundTaskFindUnique.mockResolvedValue(cancelledTask());
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow());

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE,
    });
    expectNothingWritten();
  });

  it("refuses a cancelled credit-paid booking with the cancelled sentence, not the no-instrument one", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(
      cancelledTask({
        payment: { ...cardReviewTask().booking.payment, amountCents: 0, stripeCustomerId: null },
      }),
    );

    await expect(charge()).rejects.toMatchObject({
      status: 409,
      message: REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE,
    });
    expectNothingWritten();
  });

  /** The chooser called directly, so an issued invoice can be offered: the
   * completion derives it from settled statuses only, so a cancelled booking
   * never has one there. Returns the store read, which must stay untouched. */
  async function chooseCancelled(booking: { organiserSettled: boolean; parentBookingId: string | null }, source: PaymentSource) {
    const storeRead = vi.fn();
    const store = new Proxy({}, { get: () => new Proxy({}, { get: () => storeRead }) });
    const chosen = chooseEditReviewChargeRoute({
      bookingModificationId: "mod-1",
      booking: { status: "CANCELLED", ...booking },
      bookingPayment: { ...cardReviewTask().booking.payment, source },
      member: cardReviewTask().booking.member,
      hasIssuedXeroInvoice: true,
      store: store as never,
    });
    return { chosen, storeRead };
  }

  it("refuses before the organiser-paid refusal, naming the organiser, and never reaches the invoice route", async () => {
    const { chosen, storeRead } = await chooseCancelled(
      { organiserSettled: true, parentBookingId: "organiser-booking-1" },
      PaymentSource.STRIPE,
    );

    await expect(chosen).rejects.toMatchObject({ status: 409, message: REVIEW_CHARGE_BOOKING_CANCELLED_ORGANISER_MESSAGE });
    // Refused on the booking's own status: nothing about the edit was read.
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("names the organiser for a cancelled joiner the organiser settled by internet banking too", async () => {
    const { chosen, storeRead } = await chooseCancelled(
      { organiserSettled: true, parentBookingId: "organiser-booking-1" },
      PaymentSource.INTERNET_BANKING,
    );

    await expect(chosen).rejects.toMatchObject({ status: 409, message: REVIEW_CHARGE_BOOKING_CANCELLED_ORGANISER_MESSAGE });
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("CONTROL: a cancelled booking with no organiser gets the plain cancelled sentence, even with an issued invoice", async () => {
    const { chosen, storeRead } = await chooseCancelled(
      { organiserSettled: false, parentBookingId: null },
      PaymentSource.INTERNET_BANKING,
    );

    await expect(chosen).rejects.toMatchObject({ status: 409, message: REVIEW_CHARGE_BOOKING_CANCELLED_MESSAGE });
    expect(storeRead).not.toHaveBeenCalled();
  });

  it("CONTROL: the same booking, not cancelled, is asked by card as before", async () => {
    mocks.manualRefundTaskFindUnique.mockResolvedValue(cancelledTask({ status: "PAID" }));

    const result = await charge();

    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(result.additionalPaymentIntentId).toBe("pi_additional_1");
  });

  it("a cancellation landing after the commit asks nothing, records the share, skips the Xero leg and tells the officer so", async () => {
    // The chooser saw PAID under lock(1) and chose the card; the booking was
    // cancelled before the sync's post-commit re-read. Nothing is minted, the
    // share is recorded as uncollected, and no supplementary invoice is queued
    // to wait on a card request that will never exist.
    mocks.paymentFindUnique.mockResolvedValue({
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 15000,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      stripeCustomerId: "cus_1",
      booking: { status: "CANCELLED" },
    });

    const result = await charge();

    expect(mocks.manualRefundTaskUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.additionalPaymentIntentId).toBeNull();
    expect(result.chargeBookingCancelled).toEqual({ recorded: true });
    // Recorded now, so nothing is left for a recovery row to retry.
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
    expect(
      mocks.createAuditLog.mock.calls.filter(
        (call) => (call[0] as { metadata?: { cause?: string } }).metadata?.cause === "booking-cancelled",
      ),
    ).toHaveLength(1);
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();
    // The officer is told the truth: not "will be retried automatically".
    const message = completionMessage(result, CLUB_FORMAT_TEST);
    expect(message).toBe(CHARGE_BOOKING_CANCELLED_COMPLETION);
    expect(message).not.toContain("retried automatically");

    // A second completion whose share an earlier record already covers says so,
    // rather than claiming a record it did not add.
    vi.clearAllMocks();
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
    mocks.auditLogFindMany.mockResolvedValue([
      { metadata: { leg: "payment-request", cause: "booking-cancelled", bookingModificationId: "mod-1", uncollectedCents: 20000 } },
    ]);
    const again = await charge();
    expect(again.chargeBookingCancelled).toEqual({ recorded: false });
    expect(mocks.createAuditLog.mock.calls.filter(
      (call) => (call[0] as { metadata?: { cause?: string } }).metadata?.cause === "booking-cancelled",
    )).toHaveLength(0);
    expect(completionMessage(again, CLUB_FORMAT_TEST)).toBe(CHARGE_BOOKING_CANCELLED_ALREADY_RECORDED_COMPLETION);
  });

  it("queues no Xero leg when the charge was not raised and the booking is cancelled by now", async () => {
    // The sync's first read saw PAID; the cancellation landed before the mint,
    // which refused: `not-raised`. The recovery row's cancelled path records the
    // share; an invoice queued here would wait on a request never raised.
    mocks.paymentFindUnique
      .mockResolvedValueOnce(rereadWithStatus("PAID"))
      .mockResolvedValue(rereadWithStatus("CANCELLED"));
    mocks.bookingStatusFindUnique.mockResolvedValue({ status: "CANCELLED" });

    const result = await charge();

    expect(result.additionalPaymentIntentId).toBeNull();
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.queueXeroBookingEditSettlement).not.toHaveBeenCalled();

    // CONTROL: the same not-raised answer on a live booking keeps its Xero leg.
    vi.clearAllMocks();
    mocks.manualRefundTaskUpdateMany.mockResolvedValue({ count: 1 });
    mocks.paymentFindUnique
      .mockResolvedValueOnce(rereadWithStatus("PAID"))
      .mockResolvedValue(rereadWithStatus("CANCELLED"));
    mocks.bookingStatusFindUnique.mockResolvedValue({ status: "PAID" });
    await charge();
    expect(mocks.queueXeroBookingEditSettlement).toHaveBeenCalledTimes(1);
  });

  /** The sync's own arguments, as the inline completion passes them. */
  const syncArgs = {
    bookingId: "booking-1",
    bookingModificationId: "mod-1",
    paymentId: "payment-1",
    member: { id: "member-1", email: "grace@example.test", name: "Grace Hopper", stripeCustomerId: "cus_1" },
    hasIssuedXeroInvoice: false,
    format: CLUB_FORMAT_TEST,
  };

  /** The sync's re-read of the payment, with its booking's status. */
  function rereadWithStatus(status: string) {
    return {
      id: "payment-1",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 15000,
      refundedAmountCents: 0,
      source: PaymentSource.STRIPE,
      stripeCustomerId: "cus_1",
      booking: { status },
    };
  }

  it("never raises this edit's existing request on a booking cancelled since the commit", async () => {
    // A second share of an edit asked by card: the raise would ask Stripe for
    // $230 on an intent the cancellation retired.
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow());
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare(),
      settledShare({ id: "task-2", amountCents: 3000 }),
    ]);
    mocks.paymentFindUnique.mockResolvedValue(rereadWithStatus("CANCELLED"));

    const result = await syncEditFinancialReviewChargeRequest(syncArgs);

    expect(result).toMatchObject({ outcome: "booking-cancelled", paymentIntentId: null, totalCents: 23000 });
    // No provider call of any kind: no raise, no currency re-issue, no mint.
    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.writeRaisedAdditionalRequestAmount).not.toHaveBeenCalled();
    // Recorded under the claim, so no recovery row is needed.
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).not.toHaveBeenCalled();
    expect(EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY["booking-cancelled"]).toBe(true);

    // CONTROL: the same edit on a live booking raises the request as before.
    vi.clearAllMocks();
    mocks.paymentFindUnique.mockResolvedValue(rereadWithStatus("PAID"));
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow());
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare(),
      settledShare({ id: "task-2", amountCents: 3000 }),
    ]);
    mocks.getPaymentIntent.mockResolvedValue({ id: "pi_additional_1", currency: "nzd", status: "requires_payment_method", customer: "cus_1" });
    mocks.updatePaymentIntentAmount.mockImplementation(async (id: string, amount: number) => ({ id, amount }));
    mocks.writeRaisedAdditionalRequestAmount.mockResolvedValue(true);

    await expect(syncEditFinancialReviewChargeRequest(syncArgs)).resolves.toMatchObject({ outcome: "raised" });
    expect(mocks.updatePaymentIntentAmount).toHaveBeenCalledWith("pi_additional_1", 23000);
  });

  it("answers already-paid with no provider call when a paid request covers every share on the cancelled booking", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.SUCCEEDED, amountCents: 20000 }),
    );
    mocks.paymentFindUnique.mockResolvedValue(rereadWithStatus("CANCELLED"));

    const result = await syncEditFinancialReviewChargeRequest(syncArgs);

    expect(result).toMatchObject({ outcome: "already-paid", paymentIntentId: "pi_additional_1" });
    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.updatePaymentIntentAmount).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("the mint's own card question still refuses a cancellation landing after the sync's first read", async () => {
    // The first re-read sees PAID; the cancellation commits before the mint's.
    mocks.paymentFindUnique
      .mockResolvedValueOnce(rereadWithStatus("PAID"))
      .mockResolvedValue(rereadWithStatus("CANCELLED"));

    const result = await syncEditFinancialReviewChargeRequest(syncArgs);

    expect(result.outcome).toBe("not-raised");
    expect(mocks.createPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.enqueueEditFinancialReviewChargeRecovery).toHaveBeenCalledTimes(1);
  });
});

/**
 * #4272: what a cancellation left uncollected is recorded
 * (`settleCancelledEditReviewCharge`), through the one record function, so a
 * task that reads COMPLETED still has a findable trace - once per figure, net of
 * refunds, and never as a guess.
 */
describe("#4272: the uncollected share on a cancelled booking is recorded", () => {
  const args = {
    bookingId: "booking-1",
    paymentId: "payment-1",
    bookingModificationId: "mod-1",
    memberId: "member-1",
    format: CLUB_FORMAT_TEST,
  };

  function uncollectedRows() {
    return mocks.createAuditLog.mock.calls
      .map((call) => call[0] as { action: string; summary: string; details: string; metadata: Record<string, unknown> })
      .filter((entry) => entry.action === "booking.editFinancialReview.chargeShareUncollected");
  }

  beforeEach(() => {
    mocks.manualRefundTaskFindMany.mockResolvedValue([
      settledShare(),
      settledShare({ id: "task-2", amountCents: 3000 }),
    ]);
  });

  it("records the whole settled total when nothing was collected, telling the officer to collect it another way", async () => {
    // The cancellation marks the edit's request FAILED (`INV-ADDPAY-023`): it collected nothing.
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.FAILED }));

    await settleCancelledEditReviewCharge(args);

    const [row] = uncollectedRows();
    expect(uncollectedRows()).toHaveLength(1);
    expect(row.metadata).toMatchObject({ leg: "payment-request", cause: "booking-cancelled", uncollectedCents: 23000 });
    expect(row.summary).toContain("$230.00");
    expect(row.summary).toContain("cancelled");
    expect(row.details).toContain("Nothing was collected towards it.");
    expect(row.details).toContain("Collect $230.00 another way");
    expect(row.details).not.toContain("had already been paid");
  });

  it("writes ONE record when the replay runs twice for the same figure (reaper re-claim, failed close, re-arm)", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.FAILED }));

    await settleCancelledEditReviewCharge(args);
    await settleCancelledEditReviewCharge(args);

    expect(uncollectedRows()).toHaveLength(1);
  });

  it("writes only the difference when a later share grows what is owed", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.FAILED }));
    mocks.manualRefundTaskFindMany.mockResolvedValueOnce([settledShare()]);
    await settleCancelledEditReviewCharge(args);

    await settleCancelledEditReviewCharge(args);

    const rows = uncollectedRows();
    expect(rows.map((row) => row.metadata.uncollectedCents)).toEqual([20000, 3000]);
    expect(rows[1].details).toContain("An earlier record already covers $200.00 of the $230.00 still owed");
    expect(rows[1].metadata).toMatchObject({ alreadyRecordedCents: 20000, owedCents: 23000 });
  });

  it("CONTROL: another edit's or another cause's record does not count against this one", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.FAILED }));
    mocks.auditLogFindMany.mockResolvedValue([
      { metadata: { leg: "payment-request", cause: "booking-cancelled", bookingModificationId: "mod-other", uncollectedCents: 23000 } },
      { metadata: { leg: "payment-request", cause: "ask-not-raised", bookingModificationId: "mod-1", uncollectedCents: 23000 } },
    ]);

    await settleCancelledEditReviewCharge(args);

    expect(uncollectedRows()[0].metadata).toMatchObject({ uncollectedCents: 23000 });
  });

  it("nets a fully refunded request out of what was collected, and says so", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.REFUNDED, amountCents: 20000 }),
    );
    mocks.paymentTransactionFindUnique.mockResolvedValue({ refundedAmountCents: 20000, refunds: [{ status: "succeeded" }] });

    await settleCancelledEditReviewCharge(args);

    const [row] = uncollectedRows();
    expect(row.metadata).toMatchObject({ uncollectedCents: 23000, refundedCents: 20000, netPaidCents: 0 });
    expect(row.details).toContain("$200.00 of that had been refunded when this was recorded, so $0.00 counts as collected");
  });

  it("nets a partly refunded request: owed less what was kept", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.PARTIALLY_REFUNDED, amountCents: 20000 }),
    );
    mocks.paymentTransactionFindUnique.mockResolvedValue({ refundedAmountCents: 5000, refunds: [{ status: "succeeded" }] });

    await settleCancelledEditReviewCharge(args);

    expect(uncollectedRows()[0].metadata).toMatchObject({ uncollectedCents: 8000, refundedCents: 5000, netPaidCents: 15000 });
  });

  it("leaves a request still PROCESSING at Stripe to a retry rather than recording a guess", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.PROCESSING }));

    await expect(settleCancelledEditReviewCharge(args)).rejects.toBeInstanceOf(EditReviewChargeStillMovingError);
    expect(uncollectedRows()).toHaveLength(0);
  });

  it("waits for a refund Stripe has not settled, which could still fail and put the money back", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.PARTIALLY_REFUNDED, amountCents: 20000 }),
    );
    mocks.paymentTransactionFindUnique.mockResolvedValue({ refundedAmountCents: 5000, refunds: [{ status: "pending" }] });

    await expect(settleCancelledEditReviewCharge(args)).rejects.toBeInstanceOf(EditReviewChargeStillMovingError);
    expect(uncollectedRows()).toHaveLength(0);

    // CONTROL: settled and refused refunds are final, so the figure is written.
    mocks.paymentTransactionFindUnique.mockResolvedValue({
      refundedAmountCents: 5000,
      refunds: [{ status: "succeeded" }, { status: "failed" }],
    });
    await settleCancelledEditReviewCharge(args);
    expect(uncollectedRows()[0].details).toContain("had been refunded when this was recorded");
  });

  it("counts an earlier ask-closed record (the largest running total) plus earlier cancelled records (summed)", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.FAILED }));
    mocks.auditLogFindMany.mockResolvedValue([
      // The sync's paid-request records: running totals of the same shortfall.
      { metadata: { leg: "payment-request", cause: "ask-closed", bookingModificationId: "mod-1", uncollectedCents: 3000 } },
      { metadata: { leg: "payment-request", cause: "ask-closed", bookingModificationId: "mod-1", uncollectedCents: 5000 } },
      // This path's own increment.
      { metadata: { leg: "payment-request", cause: "booking-cancelled", bookingModificationId: "mod-1", uncollectedCents: 2000 } },
      // Not the card leg's: the Xero leg's record is a different ask.
      { metadata: { leg: "xero-invoice", cause: "ask-closed", bookingModificationId: "mod-1", uncollectedCents: 23000 } },
    ]);

    await settleCancelledEditReviewCharge(args);

    expect(uncollectedRows()[0].metadata).toMatchObject({ uncollectedCents: 16000, alreadyRecordedCents: 7000 });
  });

  it("throws when the audit insert fails, so the durable row retries instead of closing with no record", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.FAILED }));
    mocks.createAuditLog.mockRejectedValueOnce(new Error("audit sink down"));

    await expect(settleCancelledEditReviewCharge(args)).rejects.toThrow("audit sink down");
  });

  it("records only the part a paid request did not cover", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(chargeRequestRow({ status: PaymentStatus.SUCCEEDED }));

    await settleCancelledEditReviewCharge(args);

    expect(uncollectedRows()).toHaveLength(1);
    expect(uncollectedRows()[0].metadata).toMatchObject({ cause: "booking-cancelled", uncollectedCents: 3000, refundedCents: 0 });
  });

  it("CONTROL: records nothing when a paid request already covers every settled share", async () => {
    mocks.paymentTransactionFindFirst.mockResolvedValue(
      chargeRequestRow({ status: PaymentStatus.SUCCEEDED, amountCents: 23000 }),
    );

    await expect(settleCancelledEditReviewCharge(args)).resolves.toMatchObject({
      outcome: "already-paid",
      paymentIntentId: "pi_additional_1",
    });

    expect(uncollectedRows()).toHaveLength(0);
  });

});

describe("canAskCardForReviewCharge (#3947)", () => {
  const payment = (overrides: Record<string, unknown> = {}) => ({
    status: "SUCCEEDED",
    amountCents: 0,
    refundedAmountCents: 0,
    source: PaymentSource.STRIPE,
    ...overrides,
  });

  it.each([
    ["asks: a settled credit-paid ($0) card payment", "PAID", payment(), true],
    ["asks: a settled captured card payment", "CONFIRMED", payment({ amountCents: 15000 }), true],
    ["asks: a PAYMENT_PENDING credit-paid booking", "PAYMENT_PENDING", payment(), true],
    // The captured-card clause, kept for a booking outside the settled statuses...
    ["asks: an unsettled, uncancelled booking with money captured on a card", "AWAITING_REVIEW", payment({ amountCents: 15000 }), true],
    // ...but never for a cancelled one (#4272).
    ["refuses: a cancelled booking with money captured on a card", "CANCELLED", payment({ amountCents: 15000 }), false],
    ["refuses: a cancelled credit-paid booking", "CANCELLED", payment(), false],
    // #4316: a bumped one retires every ask too.
    ["refuses: a bumped booking with money captured on a card", "BUMPED", payment({ amountCents: 15000 }), false],
    ["refuses: a settled $0 internet-banking payment", "PAID", payment({ source: PaymentSource.INTERNET_BANKING }), false],
    ["refuses: a settled booking whose card payment never captured", "PAYMENT_PENDING", payment({ status: "PENDING" }), false],
  ])("%s", (_label, status, row, expected) => {
    expect(canAskCardForReviewCharge({ status, payment: row })).toBe(expected);
  });

  it("answers no for a booking with no payment", () => {
    expect(canAskCardForReviewCharge({ status: "PAID", payment: null })).toBe(false);
  });

  it.each([
    ["CANCELLED", true],
    ["BUMPED", true],
    ["PAID", false],
    ["CONFIRMED", false],
    ["AWAITING_REVIEW", false],
  ])("refusesReviewChargeForCancellation(%s) is %s (#4272)", (status, expected) => {
    expect(refusesReviewChargeForCancellation({ status })).toBe(expected);
  });
});
