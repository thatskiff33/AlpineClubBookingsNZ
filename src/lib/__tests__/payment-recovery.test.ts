import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaymentSource,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

const {
  mockExecuteRaw,
  mockPaymentRecoveryFindMany,
  mockPaymentRecoveryFindUnique,
  mockPaymentRecoveryFindFirst,
  mockPaymentRecoveryUpdateMany,
  mockPaymentRecoveryUpdate,
  mockPaymentRecoveryUpsert,
  mockPaymentRecoveryCreateMany,
  mockAlertCooldownUpdateMany,
  mockAlertCooldownCreate,
  mockPaymentTransactionUpdateMany,
  mockPaymentTransactionUpdate,
  mockPaymentTransactionFindUnique,
  mockPaymentFindUnique,
  mockBookingFindUnique,
  mockCancelPaymentIntentIfCancellableWithResult,
  mockProcessRefund,
  mockListRefundsForPaymentIntent,
  mockReconcilePaymentAggregates,
  mockRecordStripeRefundsAgainstTransaction,
  mockRefundPaymentTransactions,
  mockSendAdminPaymentFailureAlert,
  mockCreatePaymentIntent,
  mockFindOrCreateCustomer,
  mockUpsertPaymentIntentTransaction,
  mockPaymentTransactionFindMany,
  mockAttachIntentToWaitingOps,
  mockAttachRecoveredIntent,
  mockSendAdminXeroSyncErrorAlert,
  mockFindWaitingSupplementaryOpForIntent,
  mockExecuteGroupSettlementRefundPlan,
  mockRecordDuplicateCaptureRefundEvent,
  mockBookingEventCreate,
  mockBookingEventFindMany,
  mockReportSupersededPaymentRefund,
  mockSyncEditFinancialReviewChargeRequest,
  mockBookingModificationFindUnique,
  mockCompleteDeferredSupplementaryInvoice,
  mockRecordShortEditReviewChargeInvoice,
  mockRecordUncollectedEditReviewChargeShare,
  mockCloseCancelledEditReviewChargeReplay,
  mockFindEditReviewChargeRequest,
  mockCreateAuditLog,
  settlementModuleLoadFailure,
} = vi.hoisted(() => ({
  // #4442 review C-F1: the raw statements each transaction runs, so a test can
  // say which took the global key.
  mockExecuteRaw: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  mockPaymentRecoveryFindMany: vi.fn(),
  mockPaymentRecoveryFindUnique: vi.fn(),
  mockPaymentRecoveryFindFirst: vi.fn(),
  mockPaymentRecoveryUpdateMany: vi.fn(),
  mockPaymentRecoveryUpdate: vi.fn(),
  mockPaymentRecoveryUpsert: vi.fn(),
  mockPaymentRecoveryCreateMany: vi.fn(),
  mockAlertCooldownUpdateMany: vi.fn(),
  mockAlertCooldownCreate: vi.fn(),
  mockPaymentTransactionUpdateMany: vi.fn(),
  mockPaymentTransactionUpdate: vi.fn(),
  mockPaymentTransactionFindUnique: vi.fn(),
  mockPaymentFindUnique: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockCancelPaymentIntentIfCancellableWithResult: vi.fn(),
  mockFindEditReviewChargeRequest: vi.fn(),
  mockCreateAuditLog: vi.fn().mockResolvedValue(undefined),
  mockProcessRefund: vi.fn(),
  mockListRefundsForPaymentIntent: vi.fn().mockResolvedValue([]),
  mockReconcilePaymentAggregates: vi.fn().mockResolvedValue(undefined),
  mockRecordStripeRefundsAgainstTransaction: vi.fn().mockResolvedValue({
    createdRefundsCount: 1,
    createdRefundAmountCents: 6000,
    ledgerRefundedAmountCents: 6000,
    refundedAmountCents: 6000,
    appliedCents: 6000,
    failedLaterDebts: [],
    readAsRefused: [],
  }),
  mockRefundPaymentTransactions: vi.fn(),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockCreatePaymentIntent: vi.fn(),
  mockFindOrCreateCustomer: vi.fn(),
  mockUpsertPaymentIntentTransaction: vi.fn().mockResolvedValue({}),
  // #3341: the REAL supersede helper's ledger read (`INV-OPS-015`). Empty by
  // default, which is honest only for a fixture with no live ADDITIONAL ask; a
  // case whose payment carries one answers it with that row.
  mockPaymentTransactionFindMany: vi.fn().mockResolvedValue([]),
  mockAttachIntentToWaitingOps: vi.fn().mockResolvedValue({ attached: 0 }),
  // #3641: a spy on the recovery's attach helper that still runs the real one.
  mockAttachRecoveredIntent: vi.fn(),
  mockSendAdminXeroSyncErrorAlert: vi.fn(),
  // #3220 fix round: the withdrawal's one exception. Null is "nothing is
  // waiting on this ask", which is the shape every other test in this file
  // exercises.
  mockFindWaitingSupplementaryOpForIntent: vi.fn().mockResolvedValue(null),
  mockExecuteGroupSettlementRefundPlan: vi
    .fn()
    .mockResolvedValue({ outcome: "refunded", mirroredChildren: 1 }),
  mockRecordDuplicateCaptureRefundEvent: vi.fn().mockResolvedValue(undefined),
  mockBookingEventCreate: vi.fn().mockResolvedValue({}),
  // #4145: the member cancel's CANCELLED snapshot, read for its REFUNDED reason.
  mockBookingEventFindMany: vi.fn().mockResolvedValue([]),
  // #3340: the supersede-refund epilogue - one audit row, one booking event, one
  // member email, one admin alert. Mocked so a REPLAY can be asked whether it
  // spoke a second time.
  mockReportSupersededPaymentRefund: vi.fn().mockResolvedValue(undefined),
  mockSyncEditFinancialReviewChargeRequest: vi.fn(),
  // #3181: the edit whose additional payment is being recovered, read back for
  // the SIGNED components its deferred supplementary invoice bills.
  mockBookingModificationFindUnique: vi
    .fn()
    .mockResolvedValue({ priceDiffCents: 3000, changeFeeCents: 0 }),
  mockCompleteDeferredSupplementaryInvoice: vi
    .fn()
    .mockResolvedValue("covers-total"),
  mockRecordShortEditReviewChargeInvoice: vi.fn().mockResolvedValue(false),
  mockRecordUncollectedEditReviewChargeShare: vi.fn().mockResolvedValue(undefined),
  // #4272: the real one answers from the booking's status; so does this.
  mockCloseCancelledEditReviewChargeReplay: vi.fn(async (args: { status?: string }) => args.status === "CANCELLED"),
  /**
   * #3181 fix round: arms a failure to LOAD the settlement module, as distinct
   * from a failure of the call inside it. The worker reaches that module through
   * `await import`, and an import can throw - a module whose own top level
   * throws, a build that cannot resolve the chunk. Read through a getter on the
   * mocked namespace so the throw lands on the same destructuring line the worker
   * really executes, which is the line that used to sit outside the `try`.
   */
  settlementModuleLoadFailure: { current: null as Error | null },
}));

/**
 * #3170: reached through a DYNAMIC import inside the worker (the charge module
 * imports this one), which `vi.mock` still intercepts.
 */
vi.mock("@/lib/edit-financial-review-charge", () => ({
  syncEditFinancialReviewChargeRequest: (...args: unknown[]) =>
    mockSyncEditFinancialReviewChargeRequest(...args),
}));

// #4631: how many transactions are open, so a provider call can be pinned outside every one.
const openTransactions = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/prisma", () => {
  const prisma = {
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
    paymentRecoveryOperation: {
      findMany: (...args: unknown[]) => mockPaymentRecoveryFindMany(...args),
      findUnique: (...args: unknown[]) => mockPaymentRecoveryFindUnique(...args),
      findFirst: (...args: unknown[]) => mockPaymentRecoveryFindFirst(...args),
      updateMany: (...args: unknown[]) => mockPaymentRecoveryUpdateMany(...args),
      update: (...args: unknown[]) => mockPaymentRecoveryUpdate(...args),
      upsert: (...args: unknown[]) => mockPaymentRecoveryUpsert(...args),
      createMany: (...args: unknown[]) => mockPaymentRecoveryCreateMany(...args),
    },
    alertCooldown: {
      updateMany: (...args: unknown[]) => mockAlertCooldownUpdateMany(...args),
      create: (...args: unknown[]) => mockAlertCooldownCreate(...args),
    },
    paymentTransaction: {
      updateMany: (...args: unknown[]) => mockPaymentTransactionUpdateMany(...args),
      update: (...args: unknown[]) => mockPaymentTransactionUpdate(...args),
      findUnique: (...args: unknown[]) => mockPaymentTransactionFindUnique(...args),
      findMany: (...args: unknown[]) => mockPaymentTransactionFindMany(...args),
      findFirst: (...args: unknown[]) => mock4316.transactionFindFirst(...args),
    },
    payment: {
      findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
      update: (...args: unknown[]) => mock4316.paymentUpdate(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
    },
    bookingModification: {
      findUnique: (...args: unknown[]) =>
        mockBookingModificationFindUnique(...args),
    },
    bookingEvent: {
      create: (...args: unknown[]) => mockBookingEventCreate(...args),
      findMany: (...args: unknown[]) => mockBookingEventFindMany(...args),
    },
  };
  // #3954 review round 4: the additional-intent replay writes its row under a
  // claim hold, in one transaction, on these same mocks.
  const $transaction = async (fn: (tx: typeof prisma) => unknown) => {
    openTransactions.count += 1;
    try {
      return await fn(prisma);
    } finally {
      openTransactions.count -= 1;
    }
  };
  return { prisma: { ...prisma, $transaction } };
});

vi.mock("@/lib/recorded-card-refund-notes", () => ({ queueRecordedCardRefundNotes: vi.fn().mockResolvedValue({ queueOperationId: null }) }));
vi.mock("@/lib/stripe", () => ({
  listRefundsForPaymentIntent: (...args: unknown[]) => mockListRefundsForPaymentIntent(...args),
  cancelPaymentIntentIfCancellableWithResult: (...args: unknown[]) =>
    mockCancelPaymentIntentIfCancellableWithResult(...args),
  processRefund: (...args: unknown[]) => mockProcessRefund(...args),
  createPaymentIntent: (...args: unknown[]) => mockCreatePaymentIntent(...args),
  findRecentPaymentIntentByMetadata: (...args: unknown[]) => mockFindRecentPaymentIntentByMetadata(...args),
  findOrCreateCustomer: (...args: unknown[]) =>
    mockFindOrCreateCustomer(...args),
}));
const mockFindRecentPaymentIntentByMetadata = vi.fn();

vi.mock("@/lib/group-cancel", () => ({
  executeGroupSettlementRefundPlan: (...args: unknown[]) =>
    mockExecuteGroupSettlementRefundPlan(...args),
}));

const mockProcessOrganiserChildRefundOperation = vi.fn();
const mockReconcilePendingOrganiserChildRefunds = vi.fn().mockResolvedValue({ checked: 0, reversed: 0 });
vi.mock("@/lib/organiser-child-refund-executor", () => ({
  processOrganiserChildRefundOperation: (...args: unknown[]) =>
    mockProcessOrganiserChildRefundOperation(...args),
  reconcilePendingOrganiserChildRefunds: (...args: unknown[]) =>
    mockReconcilePendingOrganiserChildRefunds(...args),
}));
// #4104: and every other pending card refund.
const mockReconcilePendingCardRefunds = vi.fn().mockResolvedValue({ checked: 0, moved: 0 });
vi.mock("@/lib/card-refund-status-sync", () => ({
  reconcilePendingCardRefunds: (...args: unknown[]) => mockReconcilePendingCardRefunds(...args),
}));

/**
 * #3341 (`INV-OPS-015`): the ADDITIONAL supersede runs for REAL. The replay
 * asserts the ask it re-mints, and a stubbed supersede is how #3340's sizing
 * defect stayed green; its own collaborators are this module and the prisma
 * double above.
 */
vi.mock("@/lib/booking-payment-cleanup", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-payment-cleanup")),
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));

// #3639: the Xero correction a replayed late-capture approval refund queues.
const mockQueueLateCaptureRefundCreditNote = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  finishApprovedLateCaptureRefundAfterReplay: (...args: unknown[]) =>
    mockQueueLateCaptureRefundCreditNote(...args),
}));

// #3639 review F1: the superseded hand-off asks the late-capture hold. Its own
// behaviour (the setting, the booking's status, the task) is pinned against
// its real code in `late-capture-refund-hold.test.ts`; here, what the hand-off
// does with each answer.
const mockHoldSupersededLateCapture = vi.hoisted(() =>
  vi.fn().mockResolvedValue(false),
);
// #4300: the superseded machinery's composed reading, real in its own suite.
const mockSupersededMachineryOwnsCapture = vi.hoisted(() => vi.fn());
const mockFindPaymentTransactionByIntentId = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/superseded-capture-ownership", () => ({
  supersededMachineryOwnsCapture: (...args: unknown[]) => mockSupersededMachineryOwnsCapture(...args),
}));

vi.mock("@/lib/late-capture-refund-hold", () => ({
  holdSupersededLateCaptureIfRequired: (...args: unknown[]) =>
    mockHoldSupersededLateCapture(...args),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  attachPaymentIntentToWaitingSupplementaryInvoiceOperations: (
    ...args: unknown[]
  ) => mockAttachIntentToWaitingOps(...args),
  findWaitingSupplementaryInvoiceOperationForPaymentIntent: (
    ...args: unknown[]
  ) => mockFindWaitingSupplementaryOpForIntent(...args),
  // #3641: the rest of what the late-capture module imports, inert here, so
  // the real attach helper below loads against a complete double.
  OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES: ["PENDING", "RUNNING", "WAITING_PAYMENT"],
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent: vi.fn(),
  lockSupplementaryInvoiceAnchor: vi.fn(),
  releaseWaitingSupplementaryInvoiceOperations: vi.fn(),
}));

/**
 * #3641 review round: the recovery must reach the waiting invoice through
 * `attachRecoveredIntentToWaitingSupplementaryInvoice`, which alerts an officer
 * when the attach fails, never through the raw attach whose failure was only
 * logged. The spy records the call and then runs the REAL helper, so every
 * assertion on the raw attach above still reads what the helper did.
 */
vi.mock("@/lib/xero-supplementary-invoice-late-capture", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-supplementary-invoice-late-capture");
  return {
    ...actual,
    attachRecoveredIntentToWaitingSupplementaryInvoice: (
      params: Parameters<typeof actual.attachRecoveredIntentToWaitingSupplementaryInvoice>[0],
    ) => {
      mockAttachRecoveredIntent(params);
      return actual.attachRecoveredIntentToWaitingSupplementaryInvoice(params);
    },
  };
});

/**
 * #3181: both reached through DYNAMIC imports inside the worker, which `vi.mock`
 * still intercepts. Doubled here rather than left real because each pulls the
 * Xero outbox's provider-client import graph in behind it, and this file mocks
 * that module down to a single export.
 *
 * That the enqueue really raises exactly ONE invoice per anchor is proven
 * against the real outbox in `xero-operation-outbox.test.ts`; these doubles prove
 * the worker asks for it, with the right figure, on the paths that should and
 * not on the paths that should not.
 */
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  get completeDeferredXeroSupplementaryInvoice() {
    if (settlementModuleLoadFailure.current) {
      throw settlementModuleLoadFailure.current;
    }
    return (...args: unknown[]) =>
      mockCompleteDeferredSupplementaryInvoice(...args);
  },
}));

vi.mock("@/lib/edit-financial-review-charge-request", () => ({
  recordShortEditReviewChargeInvoice: (...args: unknown[]) =>
    mockRecordShortEditReviewChargeInvoice(...args),
  recordUncollectedEditReviewChargeShare: (...args: unknown[]) =>
    mockRecordUncollectedEditReviewChargeShare(...args),
  // #3220: the dead-recovery cancel reads this module for the edit's ask. The
  // factory replaces the whole module, so an export it omits throws at IMPORT
  // and kills the file before a test runs.
  findEditReviewChargeRequest: (...args: unknown[]) =>
    mockFindEditReviewChargeRequest(...args),
}));

// #4272: the cancelled-booking path, its record proved against the real request
// module in `edit-financial-review-charge.test.ts`.
vi.mock("@/lib/edit-financial-review-charge-cancelled", () => ({
  closeCancelledEditReviewChargeReplay: (args: { status?: string }) =>
    mockCloseCancelledEditReviewChargeReplay(args),
}));

vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));

const mockPlanStripeRefundAllocation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  PartialRefundError: ((await importOriginal()) as typeof import("@/lib/payment-transactions")).PartialRefundError,
  planStripeRefundAllocation: mockPlanStripeRefundAllocation,
  // #4359: the preflight's no-plan fallback and the executor share this pure filter.
  capturedStripeTransactions: ((await importOriginal()) as typeof import("@/lib/payment-transactions")).capturedStripeTransactions,
  // #4217: the runner's claim hold locks the Payment row before the recovery row.
  lockPaymentForRefundedTotal: (...args: unknown[]) => mockLockPaymentForRefundedTotal(...args),
  markPaymentIntentTransactionFailed: (...args: unknown[]) => mock4316.markFailed(...args),
  reconcilePaymentAggregates: (...args: unknown[]) =>
    mockReconcilePaymentAggregates(...args),
  recordStripeRefundsAgainstTransaction: (...args: unknown[]) =>
    mockRecordStripeRefundsAgainstTransaction(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
  // #4300: the one lookup naming an intent's payment, for the superseded check.
  findPaymentTransactionByIntentId: (...args: unknown[]) => mockFindPaymentTransactionByIntentId(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mockSendAdminPaymentFailureAlert(...args),
  sendAdminXeroSyncErrorAlert: (...args: unknown[]) =>
    mockSendAdminXeroSyncErrorAlert(...args),
}));

// #4125: the capacity race's close-and-record runs for real, on the prisma double below.
vi.mock("@/lib/booking-events", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-events")),
  recordDuplicateCaptureRefundEvent: (...args: unknown[]) =>
    mockRecordDuplicateCaptureRefundEvent(...args),
}));

vi.mock("@/lib/superseded-additional-refund", () => ({
  reportSupersededPaymentRefund: (...args: unknown[]) =>
    mockReportSupersededPaymentRefund(...args),
}));

// #4253 release 2: the released-credit branch, reduced to the one call these tests need - a release
// blocked by an unpaid edit request asks the runner to put its row back to wait.
// #4631 review (F2): a pass-through seam that can report the runner's intent as ADOPTED by matching (#4036).
const ordinaryAskMint4631 = vi.hoisted(() => ({ adopted: false }));
vi.mock("@/lib/ordinary-ask-mint", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/ordinary-ask-mint");
  return {
    ...actual,
    mintOrdinaryAskIntent: async (...args: Parameters<typeof actual.mintOrdinaryAskIntent>) => {
      const minted = await actual.mintOrdinaryAskIntent(...args);
      return ordinaryAskMint4631.adopted ? { ...minted, adopted: true } : minted;
    },
  };
});
vi.mock("@/lib/credit-release-ask", () => ({
  processCreditReleaseAskOperation: vi.fn(
    async (operation: unknown, _format: unknown, deps: { wait: (op: unknown, message: string) => Promise<unknown> }) => {
      await deps.wait(operation, "An unpaid edit request is open on this booking");
      return "waited" as const;
    },
  ),
}));
vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// #3567: the club's format is resolved through this double so a test can make
// the club's currency one no card can be charged in. Its default (the
// file-level beforeEach below) is the house fixture, so every other case reads
// the format it always did.
const clubFormatMock = vi.hoisted(() => vi.fn());
const mockLockPaymentForRefundedTotal = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined));
// #4316: what the shared retirement routine writes when a replay's booking ended mid-mint.
const mock4316 = vi.hoisted(() => ({ paymentUpdate: vi.fn(), transactionFindFirst: vi.fn(), markFailed: vi.fn() }));
// #3567: when the club format last changed, for the stale-queue alert.
const mockLoadPersistedClubFormat = vi.hoisted(() => vi.fn());
vi.mock("@/lib/club-format-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-format-settings")),
  loadPersistedClubFormatSettings: (...a: unknown[]) => mockLoadPersistedClubFormat(...a),
}));
vi.mock("@/lib/club-format-server", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-format-server")),
  clubFormatValues: (...a: unknown[]) => clubFormatMock(...a),
}));

// #3403: the superseded ask's waiting Xero invoice moves onto its carrier; the
// move is its own module's (`superseded-ask-invoice-carry.test.ts`).
const mockFollowSupersededAskInvoices = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/superseded-ask-invoice-carry", () => ({
  followSupersededAskInvoicesSafely: mockFollowSupersededAskInvoices,
}));

import logger from "@/lib/logger";
import {
  buildBookingCancellationRefundMetadata,
  buildBookingModificationRefundMetadata,
  buildRefundRequestRefundMetadata,
  bookingModificationRefundReasonForKeyPrefix,
  completeCanceledSupersededPaymentIntentRecovery,
  createAdditionalPaymentIntentRecoveryOnce,
  enqueueBookingCancellationRefundRecovery,
  enqueueBookingModificationRefundRecovery,
  enqueueCapacityClaimFailedRefundRecovery,
  enqueueEditFinancialReviewChargeRecovery,
  enqueueGroupSettlementRefundRecovery,
  enqueuePaymentIntentCancellationRecovery,
  enqueueRefundRequestRefundRecovery,
  isEditFinancialReviewChargeRecoveryDead,
  processPaymentRecoveryOperations,
  runPaymentRecoveryOperationNow,
  queueSupersededPaymentIntentRefundRecovery,
} from "@/lib/payment-recovery";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildCardRefundFailedLaterRecoveryKey,
  buildAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey,
  buildEditFinancialReviewAdditionalIntentStripeKey,
} from "@/lib/payment-recovery-keys";
import { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } from "@/lib/additional-ask-recovery-close";
import { WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE } from "@/lib/additional-ask-reissue";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

beforeEach(() => {
  clubFormatMock.mockResolvedValue(CLUB_FORMAT_TEST);
});

/**
 * #4675: the runner's SUCCEEDED close is fenced on the claim it holds - still
 * PROCESSING, with the `attempts` and `processingStartedAt` its claim read back
 * (`makeOperation`'s, unless a test says otherwise).
 */
function heldClaimWhere(id: string, attempts = 1, processingStartedAt = new Date("2026-05-23T00:00:00.000Z")) {
  return { id, status: PaymentRecoveryOperationStatus.PROCESSING, attempts, processingStartedAt };
}

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "recovery-1",
    type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
    status: PaymentRecoveryOperationStatus.PROCESSING,
    bookingId: "booking-1",
    paymentId: "payment-1",
    paymentTransactionId: "txn-1",
    paymentIntentId: "pi_superseded",
    amountCents: 6000,
    allocationPlan: null,
    stripeKeyPrefix: null,
    idempotencyKey: "payment_recovery_cancel_txn-1_pi_superseded",
    attempts: 1,
    nextRetryAt: new Date("2026-05-23T00:00:00.000Z"),
    lastError: null,
    // #3181: only CREATE_ADDITIONAL_PAYMENT_INTENT rows carry the edit's frozen
    // answer, so the generic row's honest value is "not recorded".
    hadIssuedXeroInvoice: null,
    processingStartedAt: new Date("2026-05-23T00:00:00.000Z"),
    succeededAt: null,
    createdAt: new Date("2026-05-23T00:00:00.000Z"),
    updatedAt: new Date("2026-05-23T00:00:00.000Z"),
    ...overrides,
  };
}

// Charge-backed replay tests supply the actual charge identities from their
// frozen plans; the preflight must read those, not the payment's primary intent.
// The stored plan is read with the production parser, as the worker reads it.
function setPlannedChargeFixtures(storedPlan: unknown, intent = "pi_original") {
  const plan = parseRefundAllocationPlan(storedPlan) ?? [];
  mockPaymentFindUnique.mockResolvedValue({ id: "payment-1", stripePaymentIntentId: "pi_primary",
    transactions: plan.map((slice) => ({ id: slice.paymentTransactionId, stripePaymentIntentId: intent,
      amountCents: slice.amountCents, refundedAmountCents: 0,
      status: PaymentStatus.SUCCEEDED, createdAt: new Date("2026-05-01T00:00:00.000Z") })),
  });
}

/**
 * `resetStaleProcessingOperations`'s own read, told apart from the worker's
 * queue read (#3220).
 *
 * It used to be told apart by `attempts: { gte: MAX }` - the filter the reaper's
 * SECOND arm used - and that predicate was copied into 24 `findMany` mocks in
 * this file. When the reaper's two arms became one read through the terminal
 * chokepoint, that filter stopped existing, every copy answered "this is the
 * queue read", and the sweep was handed the operation under test and failed it.
 * `processingStartedAt` is the filter only the sweep uses, and it lives here
 * once so the next change to that query has one place to correct.
 */
function isStaleWorkerSweep(args?: unknown) {
  // `unknown` rather than a shape, because the 24 mocks that ask this each
  // declare their own idea of the `where` they receive and none of them is the
  // real Prisma argument type.
  const where = (args as { where?: { processingStartedAt?: unknown } } | undefined)
    ?.where;
  return where?.processingStartedAt != null;
}

describe("payment recovery worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settlementModuleLoadFailure.current = null;
    mockListRefundsForPaymentIntent.mockReset().mockResolvedValue([]);
    mockRecordStripeRefundsAgainstTransaction.mockResolvedValue({ readAsRefused: [], payment: { id: "payment-1", source: "STRIPE" }, appliedCents: 4000, newlyCountedRefundIds: ["re_dashboard"] });
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { status?: unknown; attempts?: { gte?: number } } }) => {
        // resetStaleProcessingOperations queries for exhausted PROCESSING rows.
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([makeOperation({ status: "PENDING" })]);
      },
    );
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation());
    mockPaymentRecoveryUpdateMany.mockImplementation(({ where }: { where?: { id?: string } }) =>
      Promise.resolve({ count: where?.id ? 1 : 0 })
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockPaymentRecoveryUpsert.mockResolvedValue({});
    mockPaymentRecoveryCreateMany.mockResolvedValue({ count: 1 });
    // Default: no cooldown row exists yet, so the conditional claim matches
    // nothing and the create path wins (first alert ever).
    mockAlertCooldownUpdateMany.mockResolvedValue({ count: 0 });
    mockAlertCooldownCreate.mockResolvedValue({});
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentTransactionUpdate.mockResolvedValue({});
    mockPaymentTransactionFindUnique.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      stripePaymentIntentId: "pi_superseded",
      amountCents: 6000,
      refundedAmountCents: 0,
      status: PaymentStatus.SUCCEEDED,
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      member: {
        firstName: "Alice",
        lastName: "Example",
      },
    });
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { id: "pi_superseded", status: "canceled", amount: 6000 },
    });
    mockProcessRefund.mockResolvedValue({
      id: "re_refund",
      amount: 6000,
      currency: "nzd",
      status: "succeeded",
      payment_intent: "pi_superseded",
    });
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [
        { paymentIntentId: "pi_original", refundId: "re_recovery", amountCents: 4000 },
      ],
      totalRefundedAmountCents: 4000,
    });
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_original",
      transactions: [
        {
          id: "txn-1",
          source: "STRIPE",
          stripePaymentIntentId: "pi_original",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
    });
  });

  it("#3653: re-reads pending organiser child refunds on the cron's run only, never on an inline drain", async () => {
    mockReconcilePendingOrganiserChildRefunds.mockClear();
    await processPaymentRecoveryOperations({ limit: 1 });
    expect(mockReconcilePendingOrganiserChildRefunds).not.toHaveBeenCalled();

    // A failure there never fails the run that already processed the queue.
    mockReconcilePendingOrganiserChildRefunds.mockRejectedValueOnce(new Error("Stripe is unavailable"));
    await expect(
      processPaymentRecoveryOperations({ limit: 1, reconcilePendingChildRefunds: true }),
    ).resolves.toMatchObject({ found: expect.any(Number) });
    expect(mockReconcilePendingOrganiserChildRefunds).toHaveBeenCalledOnce();
  });

  it("#4104: re-reads every other pending card refund on the cron's run only, and a failure there fails nothing", async () => {
    mockReconcilePendingCardRefunds.mockClear();
    await processPaymentRecoveryOperations({ limit: 1 });
    expect(mockReconcilePendingCardRefunds).not.toHaveBeenCalled();

    // Neither read-back's failure stops the other, or fails the run.
    mockReconcilePendingOrganiserChildRefunds.mockRejectedValueOnce(new Error("Stripe is unavailable"));
    mockReconcilePendingCardRefunds.mockRejectedValueOnce(new Error("Stripe is unavailable"));
    await expect(
      processPaymentRecoveryOperations({ limit: 1, reconcilePendingChildRefunds: true }),
    ).resolves.toMatchObject({ found: expect.any(Number) });
    expect(mockReconcilePendingCardRefunds).toHaveBeenCalledOnce();
  });

  it("cancels a cancellable superseded PaymentIntent and marks the transaction failed", async () => {
    mockFollowSupersededAskInvoices.mockClear();
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result).toMatchObject({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "txn-1",
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      },
      data: {
        status: PaymentStatus.FAILED,
        reason: "zero_dollar_batch_modification_superseded",
      },
    });
    // #2262 H2: the terminal close is a STATUS-FENCED updateMany, so a row a
    // manual mark-paid reversal deleted can never be resurrected (P2025-free).
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: heldClaimWhere("recovery-1"),
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        nextRetryAt: null,
      }),
    });
    // #3403: the change's waiting invoice follows the money - after the row is
    // FAILED and BEFORE the recovery row completes, so a crash replays it.
    expect(mockFollowSupersededAskInvoices).toHaveBeenCalledWith({ paymentId: "payment-1" });
    const failedAt = mockPaymentTransactionUpdateMany.mock.invocationCallOrder[0]!;
    const followedAt = mockFollowSupersededAskInvoices.mock.invocationCallOrder[0]!;
    const completedAt = mockPaymentRecoveryUpdateMany.mock.invocationCallOrder.at(-1)!;
    expect(failedAt).toBeLessThan(followedAt);
    expect(followedAt).toBeLessThan(completedAt);
  });

  it("#3403: the Stripe webhook's completion of a superseded cancel moves the waiting invoice too, before it completes", async () => {
    mockFollowSupersededAskInvoices.mockClear();
    mockPaymentTransactionUpdateMany.mockClear();
    mockPaymentRecoveryUpdateMany.mockClear();
    mockPaymentRecoveryFindFirst.mockResolvedValueOnce(makeOperation());

    await expect(
      completeCanceledSupersededPaymentIntentRecovery({ paymentIntentId: "pi_superseded" }),
    ).resolves.toBe(true);

    expect(mockFollowSupersededAskInvoices).toHaveBeenCalledWith({ paymentId: "payment-1" });
    expect(mockPaymentTransactionUpdateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFollowSupersededAskInvoices.mock.invocationCallOrder[0]!,
    );
    expect(mockFollowSupersededAskInvoices.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPaymentRecoveryUpdateMany.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("#3403: a webhook cancel no supersede recovery owns moves nothing", async () => {
    mockFollowSupersededAskInvoices.mockClear();
    mockPaymentRecoveryFindFirst.mockResolvedValueOnce(null);

    await expect(
      completeCanceledSupersededPaymentIntentRecovery({ paymentIntentId: "pi_other" }),
    ).resolves.toBe(false);
    expect(mockFollowSupersededAskInvoices).not.toHaveBeenCalled();
  });

  it("treats an already-canceled PaymentIntent as a successful cancellation recovery", async () => {
    mockFollowSupersededAskInvoices.mockClear();
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: { id: "pi_superseded", status: "canceled", amount: 6000 },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // #3403: an intent cancelled elsewhere (Stripe's own expiry) is followed as well.
    expect(mockFollowSupersededAskInvoices).toHaveBeenCalledWith({ paymentId: "payment-1" });
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: heldClaimWhere("recovery-1"),
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
      }),
    });
  });

  it("retries transient Stripe cancellation failures with a later retry time", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe unavailable")
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result).toMatchObject({
      processed: 1,
      succeeded: 0,
      retried: 1,
      failed: 0,
    });
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        // #3220: fenced rather than an `update` by id, so a row a manual
        // mark-paid reversal deleted mid-flight matches nothing instead of
        // throwing out of the loop's own catch.
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
            PaymentRecoveryOperationStatus.FAILED,
          ],
        },
        // #4083: only the attempt the worker holds.
        attempts: 1,
        processingStartedAt: { not: null },
      },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "Stripe unavailable",
        processingStartedAt: null,
        nextRetryAt: expect.any(Date),
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("alerts admins when a recovery operation exhausts its retries", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation({ attempts: 5 }));
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe still unavailable")
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result).toMatchObject({
      processed: 1,
      failed: 1,
      retried: 0,
    });
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        // #3220: fenced rather than an `update` by id, so a row a manual
        // mark-paid reversal deleted mid-flight matches nothing instead of
        // throwing out of the loop's own catch.
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
            PaymentRecoveryOperationStatus.FAILED,
          ],
        },
        // #4083: only the attempt the worker holds.
        attempts: 5,
        processingStartedAt: { not: null },
      },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "Stripe still unavailable",
        nextRetryAt: null,
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Example",
        amountCents: 6000,
        paymentIntentId: "pi_superseded",
        errorMessage: expect.stringContaining("failed after 5 attempts"),
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("#4253: creates a released-credit request's row only once, and says whether this call created it", async () => {
    const input = {
      bookingId: "booking-1",
      paymentId: "payment-1",
      idempotencyKey: "credit_release_ask_rel-1",
      amountCents: 4000,
      stripeIdempotencyKey: "credit_release_ask_pi_rel-1",
      hadIssuedXeroInvoice: false,
    };
    mockPaymentRecoveryCreateMany.mockResolvedValueOnce({ count: 1 });
    expect(await createAdditionalPaymentIntentRecoveryOnce(input)).toBe(true);
    expect(mockPaymentRecoveryCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
          status: PaymentRecoveryOperationStatus.PENDING,
          idempotencyKey: "credit_release_ask_rel-1",
          paymentIntentId: "credit_release_ask_pi_rel-1",
          hadIssuedXeroInvoice: false,
          nextRetryAt: expect.any(Date),
        }),
      ],
      skipDuplicates: true,
    });
    // Another pass created it first.
    mockPaymentRecoveryCreateMany.mockResolvedValueOnce({ count: 0 });
    expect(await createAdditionalPaymentIntentRecoveryOnce(input)).toBe(false);
  });

  it("#4253: a released-credit request waiting on an unpaid edit goes back to wait, its attempt handed back, never terminal", async () => {
    // Its last attempt: a failure here would be terminal, alert the officers and never ask again.
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
        idempotencyKey: "credit_release_ask_rel-1",
        attempts: 5,
      }),
    );
    const before = Date.now();

    const result = await processPaymentRecoveryOperations({ limit: 1 });
    // A wait is a retry in the run's summary, never a completion.
    expect(result).toMatchObject({ processed: 1, succeeded: 0, retried: 1, failed: 0 });

    const waitWrite = mockPaymentRecoveryUpdateMany.mock.calls
      .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
      .find((args) => args.data?.status === PaymentRecoveryOperationStatus.FAILED);
    expect(waitWrite?.where).toMatchObject({ id: "recovery-1", attempts: 5, processingStartedAt: { not: null } });
    expect(waitWrite?.data).toMatchObject({ attempts: 4, lastError: "An unpaid edit request is open on this booking" });
    // The longest step of the schedule (12 hours), not a terminal null.
    expect((waitWrite?.data.nextRetryAt as Date).getTime() - before).toBeGreaterThanOrEqual(720 * 60_000);
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  /**
   * #3220: the three failure transitions became ONE, so these pin what that one
   * transition guarantees for every caller rather than for the arm each used to
   * live in.
   */
  it("does not alert, or act, on a failure that matched no live operation", async () => {
    // The row a manual mark-paid reversal DELETED mid-flight. The worker still
    // holds its in-memory copy and still runs its catch; before the chokepoint
    // this was `update` by id, which throws P2025 - out of the loop's own catch,
    // abandoning every remaining operation in the batch.
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation({ attempts: 5 }));
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe still unavailable")
    );
    // Only the FAILURE write misses: the claim that put the row in PROCESSING
    // still has to succeed, or the worker never reaches its catch at all.
    mockPaymentRecoveryUpdateMany.mockImplementation(
      (args: { where?: { id?: string }; data?: { status?: string } }) =>
        Promise.resolve({
          count:
            args?.data?.status === PaymentRecoveryOperationStatus.FAILED ? 0 : 1,
        })
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // The batch completes rather than throwing, and the tally is what it was
    // before this transition was centralised.
    expect(result).toMatchObject({ processed: 1, failed: 1, retried: 0 });
    // Nothing is alerted about a row that is gone or already finished.
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("never drags a SUCCEEDED operation back to FAILED", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe unavailable")
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    const failureWrites = mockPaymentRecoveryUpdateMany.mock.calls.filter(
      (call) =>
        (call[0] as { data?: { status?: string } })?.data?.status === "FAILED"
    );
    expect(failureWrites).toHaveLength(1);
    const where = (failureWrites[0][0] as {
      where: { status: { in: string[] } };
    }).where;
    expect(where.status.in).not.toContain(
      PaymentRecoveryOperationStatus.SUCCEEDED
    );
  });

  it("re-arms a stale PROCESSING row that still has attempts left, without alerting", async () => {
    // The arm that used to be a bulk `updateMany` over every stale row at once.
    // It is now the same fenced, per-row transition the exhausted arm takes -
    // with `terminal` false, which is the only thing that differs.
    const staleRetryable = makeOperation({
      id: "recovery-stale-2",
      attempts: 2,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { processingStartedAt?: unknown } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [staleRetryable] : [])
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-stale-2",
        status: { in: [PaymentRecoveryOperationStatus.PROCESSING] },
        // #3220 fix round: the exact attempt the sweep read. Status alone would
        // also match a row that has since been re-claimed. #4083: both fences, ANDed.
        AND: [
          { processingStartedAt: new Date("2026-05-01T00:00:00.000Z") },
          { attempts: 2, processingStartedAt: { not: null } },
        ],
      },
      data: {
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "Payment recovery worker timed out before completion.",
        processingStartedAt: null,
        // A retry time, not null: this row is re-armed, not dead.
        nextRetryAt: expect.any(Date),
      },
    });
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("marks stale PROCESSING rows at max attempts terminally failed and alerts admins", async () => {
    const staleExhausted = makeOperation({
      id: "recovery-stale-5",
      attempts: 5,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    mockPaymentRecoveryFindMany
      // resetStaleProcessingOperations looks for exhausted stale rows
      .mockResolvedValueOnce([staleExhausted])
      // the regular queue findMany returns nothing this tick
      .mockResolvedValueOnce([]);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-stale-5",
        status: { in: [PaymentRecoveryOperationStatus.PROCESSING] },
        // #3220 fix round: as above - the read and the write are fenced to one
        // attempt, so a re-claimed row falls out instead of being killed.
        AND: [
          { processingStartedAt: new Date("2026-05-01T00:00:00.000Z") },
          { attempts: 5, processingStartedAt: { not: null } },
        ],
      },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        nextRetryAt: null,
        processingStartedAt: null,
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Example",
        amountCents: 6000,
        paymentIntentId: "pi_superseded",
        errorMessage: expect.stringContaining("timed out on the final attempt"),
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("queues refund recovery when the superseded PaymentIntent already succeeded", async () => {
    mockFollowSupersededAskInvoices.mockClear();
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: {
        id: "pi_superseded",
        status: "succeeded",
        amount: 6000,
        payment_method: "pm_123",
      },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockPaymentTransactionUpdate).toHaveBeenCalledWith({
      where: { id: "txn-1" },
      data: expect.objectContaining({
        amountCents: 6000,
        status: PaymentStatus.SUCCEEDED,
        paymentMethodId: "pm_123",
        reason: "zero_dollar_batch_modification_late_capture",
      }),
    });
    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "payment_recovery_refund_txn-1_pi_superseded" },
      create: expect.objectContaining({
        type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        paymentIntentId: "pi_superseded",
        amountCents: 6000,
      }),
      update: expect.objectContaining({
        paymentIntentId: "pi_superseded",
        amountCents: 6000,
      }),
    });
    // #3403 review 2 (F1): captured late, it is refunded and the request after
    // it carries its balance - with every invoice already moved onto it.
    expect(mockFollowSupersededAskInvoices).toHaveBeenCalledWith({ paymentId: "payment-1" });
  });

  /*
    #4422: a supersede now also queues a DECLINED ask's cancel. The row is
    already FAILED (the card failed, not the supersede), and the intent sits in
    `requires_payment_method`, still confirmable. The runner cancels it at
    Stripe, leaves the declined row's own record alone (the FAILED write is
    fenced on an open status, so it matches nothing), moves its invoice and
    completes. A capture that won the race takes the same hand-off as an open
    ask's, and the unguarded flip takes the FAILED row to SUCCEEDED.
  */
  it("#4422: cancels a DECLINED superseded ask at Stripe and keeps the declined row's own record", async () => {
    mockFollowSupersededAskInvoices.mockClear();
    mockReconcilePaymentAggregates.mockClear();
    mockCancelPaymentIntentIfCancellableWithResult.mockClear();
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
    expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_superseded");
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "txn-1", status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
      }),
    );
    expect(mockReconcilePaymentAggregates).not.toHaveBeenCalled();
    expect(mockFollowSupersededAskInvoices).toHaveBeenCalledWith({ paymentId: "payment-1" });
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "recovery-1" }),
        data: expect.objectContaining({ status: PaymentRecoveryOperationStatus.SUCCEEDED }),
      }),
    );
  });

  it("#4422: a DECLINED superseded ask a stale tab paid first is handed to the superseded refund, never cancelled", async () => {
    mockFollowSupersededAskInvoices.mockClear();
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: { id: "pi_superseded", status: "succeeded", amount: 6000, payment_method: "pm_123" },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockPaymentTransactionUpdate).toHaveBeenCalledWith({
      where: { id: "txn-1" },
      data: expect.objectContaining({ amountCents: 6000, status: PaymentStatus.SUCCEEDED }),
    });
    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: "payment_recovery_refund_txn-1_pi_superseded" },
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          amountCents: 6000,
        }),
      }),
    );
    expect(mockFollowSupersededAskInvoices).toHaveBeenCalledWith({ paymentId: "payment-1" });
  });

  it("does not double-count a previously written refund when the recovery retries", async () => {
    // First attempt scenario: refund partially succeeded in Stripe and the
    // ledger entry was written, but the paymentTransaction row update never
    // committed. On retry, Stripe returns the same refund via idempotency
    // key. #3640: the recovery hands the refund to the one card-refund writer
    // (whose replay and ledger-floor behaviour is proved in
    // payment-transactions-refunds.test.ts) and writes no absolute
    // refundedAmountCents of its own.
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
      }),
    );
    mockPaymentTransactionFindUnique.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      stripePaymentIntentId: "pi_superseded",
      amountCents: 10000,
      refundedAmountCents: 3000,
      status: PaymentStatus.PARTIALLY_REFUNDED,
    });
    mockProcessRefund.mockResolvedValue({
      id: "re_idempotent",
      amount: 3000,
      currency: "nzd",
      status: "succeeded",
      payment_intent: "pi_superseded",
    });

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockRecordStripeRefundsAgainstTransaction).toHaveBeenCalledWith({
      paymentId: "payment-1",
      paymentTransactionId: "txn-1",
      refunds: [expect.objectContaining({ id: "re_idempotent", amount: 3000 })],
      fallbackPaymentIntentId: "pi_superseded",
    });
    expect(mockPaymentTransactionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundedAmountCents: expect.anything() }),
      }),
    );
  });

  /*
    #3340 fix round (concurrency lens F4) - THE EPILOGUE SPEAKS ONCE.

    `outstandingCents <= 0` is not an idempotence gate. It only becomes true
    after the transaction row's `refundedAmountCents` has been written, so a
    failure between the ledger entry and that write re-enters with the refund
    already made: Stripe answers the replay with the same refund under the same
    key and the ledger dedupes on the refund id, so the MONEY is safe - but the
    epilogue used to run again, sending a second "we have refunded you" email and
    a second admin alert on a change whose whole point is not confusing members
    about card movement.

    The fence is `completePaymentRecoveryOperation`'s own `updateMany`, which is
    already scoped to `status != SUCCEEDED`: exactly one attempt can win it, and
    that attempt is the one that speaks.
  */
  describe("the supersede-refund epilogue is fenced on the completion claim", () => {
    beforeEach(() => {
      mockPaymentRecoveryFindUnique.mockResolvedValue(
        makeOperation({
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        }),
      );
      mockPaymentTransactionFindUnique.mockResolvedValue({
        id: "txn-1",
        paymentId: "payment-1",
        stripePaymentIntentId: "pi_superseded",
        amountCents: 6000,
        refundedAmountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      });
      mockProcessRefund.mockResolvedValue({
        id: "re_1",
        amount: 6000,
        currency: "nzd",
        status: "succeeded",
        payment_intent: "pi_superseded",
      });
    });

    it("reports the refund on the attempt that closes the operation", async () => {
      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockReportSupersededPaymentRefund).toHaveBeenCalledWith({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentId: "payment-1",
        paymentIntentId: "pi_superseded",
        refundedAmountCents: 6000,
      });
    });

    it("says nothing on a replay whose completion claim was already won", async () => {
      // The completion `updateMany` matches nothing: another attempt closed this
      // operation, and with it sent the notices.
      mockPaymentRecoveryUpdateMany.mockImplementation(
        (args: { data?: { status?: string } }) =>
          Promise.resolve({
            count: args?.data?.status === "SUCCEEDED" ? 0 : 1,
          }),
      );

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockReportSupersededPaymentRefund).not.toHaveBeenCalled();
    });
  });

  it("alerts admins when a PENDING recovery op has been queued > 30 minutes", async () => {
    const ancientOperation = {
      ...makeOperation({
        id: "recovery-ancient",
        status: PaymentRecoveryOperationStatus.PENDING,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
      booking: {
        id: "booking-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        member: { firstName: "Alice", lastName: "Example" },
      },
    };

    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    mockPaymentRecoveryFindFirst.mockResolvedValueOnce(ancientOperation);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.PENDING,
          createdAt: expect.objectContaining({ lt: expect.any(Date) }),
          // #4104 (ops 7): a dead row - attempts spent, or no retry time - is never a stalled cron.
          attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
          nextRetryAt: { not: null },
        }),
      }),
    );
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Example",
        errorMessage: expect.stringContaining("queue is stalled"),
        paymentIntentId: "pi_superseded",
      }),
      CLUB_FORMAT_TEST,
    );
  });

  function makeStaleQueueOperation() {
    return {
      ...makeOperation({
        id: "recovery-ancient",
        status: PaymentRecoveryOperationStatus.PENDING,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
      booking: {
        id: "booking-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        member: { firstName: "Alice", lastName: "Example" },
      },
    };
  }

  it("shared cooldown fires the stale-queue alert once, then suppresses a re-tick within the window (#1211)", async () => {
    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    // Both ticks see the same stale op.
    mockPaymentRecoveryFindFirst.mockResolvedValue(makeStaleQueueOperation());
    // No row within the window matches the conditional claim on either tick,
    // so the create path decides ownership: the first tick creates the row and
    // sends; the second tick loses the unique-constraint race and stays silent.
    const uniqueViolation = Object.assign(
      new Error("Unique constraint failed on the fields: (`key`)"),
      { code: "P2002" },
    );
    mockAlertCooldownCreate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(uniqueViolation);

    await processPaymentRecoveryOperations({ limit: 1 });
    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockAlertCooldownCreate).toHaveBeenCalledTimes(2);
    expect(mockAlertCooldownCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "payment-recovery:stale-queue",
        lastAlertedAt: expect.any(Date),
      }),
    });
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringContaining("queue is stalled"),
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("re-sends the stale-queue alert once the shared cooldown window has elapsed (#1211)", async () => {
    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    mockPaymentRecoveryFindFirst.mockResolvedValue(makeStaleQueueOperation());
    // The existing row's lastAlertedAt is older than the window, so the
    // conditional claim matches and this caller wins the write directly.
    mockAlertCooldownUpdateMany.mockResolvedValue({ count: 1 });

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockAlertCooldownUpdateMany).toHaveBeenCalledWith({
      where: {
        key: "payment-recovery:stale-queue",
        lastAlertedAt: { lt: expect.any(Date) },
      },
      data: { lastAlertedAt: expect.any(Date) },
    });
    // The claim already won, so no create fallback is attempted.
    expect(mockAlertCooldownCreate).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringContaining("queue is stalled"),
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("neither claims the cooldown nor alerts when no stale op exists (#1211)", async () => {
    mockPaymentRecoveryFindMany.mockResolvedValue([]);
    mockPaymentRecoveryFindFirst.mockResolvedValue(null);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockAlertCooldownUpdateMany).not.toHaveBeenCalled();
    expect(mockAlertCooldownCreate).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  describe("#4359: Stripe evidence before any charge-backed re-send", () => {
    const dashboardRefund = {
      id: "re_dashboard", amount: 4000, currency: "nzd", status: "succeeded",
      charge: "ch_original", payment_intent: "pi_original",
      created: new Date("2026-06-30T12:00:00.000Z").getTime() / 1000, metadata: {},
    };

    function queueRefund(type: PaymentRecoveryOperationType = PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION) {
      const op = makeOperation({ type, paymentIntentId: "pi_original", createdAt: new Date("2026-06-30T12:00:00.000Z"),
        allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        idempotencyKey: "payment_recovery_modification_refund_mod-1",
      });
      setPlannedChargeFixtures([{ paymentTransactionId: "txn-1", amountCents: 4000 }]);
      mockPaymentRecoveryFindUnique.mockResolvedValue(op);
      mockPaymentTransactionFindUnique.mockResolvedValue({ id: "txn-1", paymentId: "payment-1", stripePaymentIntentId: "pi_original", status: "SUCCEEDED", amountCents: 20000, refundedAmountCents: 0 });
      return op;
    }

    it.each([PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT])("%s completes when preflight marks every slice", async (type) => {
      const op = { ...queueRefund(type), stripeKeyPrefix: "slice_test" };
      const prefix = type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT ? op.idempotencyKey : op.stripeKeyPrefix;
      mockPaymentRecoveryFindUnique.mockResolvedValue(op);
      mockListRefundsForPaymentIntent.mockResolvedValue([{ ...dashboardRefund, metadata: { refundSliceKey: `${prefix}_txn-1_4000` } }]);
      mockRefundPaymentTransactions.mockResolvedValueOnce({ refunds: [], totalRefundedAmountCents: 4000 });
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(expect.objectContaining({ allocation: [], amountCents: 0 }));
      expect(mockProcessRefund).not.toHaveBeenCalled();
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }));
    });

    it.each([PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT])("%s sends only slices left unmarked by preflight", async (type) => {
      const plan = [{ paymentTransactionId: "txn-1", amountCents: 4000 }, { paymentTransactionId: "txn-1", amountCents: 2000 }];
      const op = { ...queueRefund(type), allocationPlan: plan, amountCents: 6000, stripeKeyPrefix: "slice_test" };
      const prefix = type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT ? op.idempotencyKey : op.stripeKeyPrefix;
      mockPaymentRecoveryFindUnique.mockResolvedValue(op);
      mockListRefundsForPaymentIntent.mockResolvedValue([{ ...dashboardRefund, metadata: { refundSliceKey: `${prefix}_txn-1_4000` } }]);
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(expect.objectContaining({ allocation: [plan[1]], amountCents: 2000, idempotencyKeyPrefix: prefix }));
      expect(mockProcessRefund).not.toHaveBeenCalled();
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ status: "PROCESSING", allocationPlan: { equals: plan } }),
        data: { allocationPlan: [{ ...plan[0], madeRefundId: "re_dashboard" }, plan[1]] },
      }));
    });

    it.each([PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT])("%s sends nothing after losing the preflight plan compare-and-set", async (type) => {
      const op = { ...queueRefund(type), stripeKeyPrefix: "slice_test" };
      const prefix = type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT ? op.idempotencyKey : op.stripeKeyPrefix;
      mockPaymentRecoveryFindUnique.mockResolvedValue(op);
      mockListRefundsForPaymentIntent.mockResolvedValue([{ ...dashboardRefund, metadata: { refundSliceKey: `${prefix}_txn-1_4000` } }]);
      mockPaymentRecoveryUpdateMany.mockImplementation(({ data, where }) => Promise.resolve({ count: data.allocationPlan ? 0 : where?.id ? 1 : 0 }));
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockProcessRefund).not.toHaveBeenCalled();
    });

    it.each([PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION, PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT])("holds %s on the first runner attempt, without sending or closing it", async (type) => {
      const op = queueRefund(type);
      mockListRefundsForPaymentIntent.mockResolvedValue([dashboardRefund]);
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockProcessRefund).not.toHaveBeenCalled();
      expect(mockRecordStripeRefundsAgainstTransaction).toHaveBeenCalledWith(expect.objectContaining({ refunds: [dashboardRefund] }));
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: op.id, attempts: 1, processingStartedAt: { not: null } }),
        data: expect.objectContaining({ status: "FAILED", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null, lastError: expect.stringContaining("INV-PAY-145") }),
      }));
      expect(mockPaymentRecoveryUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }));
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: expect.stringContaining("Paid another way") }), CLUB_FORMAT_TEST);
      expect(mockCreateAuditLog).toHaveBeenCalledWith(expect.objectContaining({ category: "payment", action: "booking-payment.card-refund.resend-held" }));
    });

    it("holds the failed-later debt itself before the runner can re-send it", async () => {
      const op = queueRefund();
      const failedLaterKey = buildCardRefundFailedLaterRecoveryKey("re_failed_original");
      mockPaymentRecoveryFindUnique.mockResolvedValue({ ...op, idempotencyKey: failedLaterKey, stripeKeyPrefix: failedLaterKey });
      mockListRefundsForPaymentIntent.mockResolvedValue([dashboardRefund]);
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockProcessRefund).not.toHaveBeenCalled();
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }),
      }));
    });

    it("checks Stripe before closing a fully refunded charge as already done", async () => {
      const op = queueRefund(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT);
      mockPaymentTransactionFindUnique.mockResolvedValue({ id: "txn-1", paymentId: "payment-1", stripePaymentIntentId: "pi_original", status: "REFUNDED", amountCents: 4000, refundedAmountCents: 4000 });
      mockListRefundsForPaymentIntent.mockResolvedValue([dashboardRefund]);
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(mockPaymentRecoveryUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }));
      expect(mockProcessRefund).not.toHaveBeenCalled();
    });

    it("records an app refund and replays the original request instead of holding it", async () => {
      const op = queueRefund();
      mockListRefundsForPaymentIntent.mockResolvedValue([{ ...dashboardRefund, metadata: { bookingId: "booking-1", reason: "booking_modification_refund_recovery" } }]);
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(mockRefundPaymentTransactions).toHaveBeenCalledOnce();
      expect(mockRecordStripeRefundsAgainstTransaction.mock.invocationCallOrder[0]).toBeLessThan(mockRefundPaymentTransactions.mock.invocationCallOrder[0]!);
    });

    it("checks only the card rows the executor can refund when there is no frozen plan", async () => {
      const op = queueRefund();
      mockPaymentRecoveryFindUnique.mockResolvedValue({ ...op, allocationPlan: null, paymentTransactionId: null });
      mockPaymentFindUnique.mockResolvedValue({ id: "payment-1", stripePaymentIntentId: "pi_primary", transactions: [
        { id: "txn-bank", source: "INTERNET_BANKING", stripePaymentIntentId: null, amountCents: 10000, refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED, createdAt: new Date("2026-04-01T00:00:00.000Z") },
        { id: "txn-1", source: "STRIPE", stripePaymentIntentId: "pi_original", amountCents: 20000, refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED, createdAt: new Date("2026-05-01T00:00:00.000Z") },
      ] });
      await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST);
      expect(mockListRefundsForPaymentIntent).toHaveBeenCalledOnce();
      expect(mockListRefundsForPaymentIntent).toHaveBeenCalledWith("pi_original", expect.anything());
      expect(mockPaymentRecoveryUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ lastError: expect.stringContaining("no Stripe intent") }),
      }));
    });

    it("keeps the batch going when the hold's audit write fails", async () => {
      const op = queueRefund();
      mockListRefundsForPaymentIntent.mockResolvedValue([dashboardRefund]);
      mockCreateAuditLog.mockRejectedValueOnce(new Error("audit sink down"));
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalled();
    });

    it("sends nothing when the provider preflight fails, keeping a normal retry", async () => {
      const op = queueRefund();
      mockListRefundsForPaymentIntent.mockRejectedValue(new Error("preflight timeout"));
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockProcessRefund).not.toHaveBeenCalled();
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", nextRetryAt: expect.any(Date), lastError: "preflight timeout" }) }));
    });

    it("a lost hold claim sends no alert or audit and no refund", async () => {
      const op = queueRefund();
      mockListRefundsForPaymentIntent.mockResolvedValue([dashboardRefund]);
      mockPaymentRecoveryUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      expect(await runPaymentRecoveryOperationNow(op.id, CLUB_FORMAT_TEST)).toBe("failed");
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockProcessRefund).not.toHaveBeenCalled();
    });
  });

  // Mutation proof: dropping the door's allocationPlan made this refund 10000, not 8000 cents.
  it("replays the edit's same Stripe key after recording fails and the webhook records it (#3984)", async () => {
    const { executeBookingModificationRefund } = await import("@/lib/booking-modification-settlement");
    const { PartialRefundError } = await import("@/lib/payment-transactions");
    const { refundSliceStripeIdempotencyKey } = await import("@/lib/payment-recovery-keys");
    const slice = { paymentTransactionId: "txn-1", amountCents: 8000 };
    mockPlanStripeRefundAllocation.mockResolvedValue({ slices: [slice], plannedAmountCents: 8000, totalRefundableCents: 10000 });
    const transaction = { id: "txn-1", source: "STRIPE", stripePaymentIntentId: "pi_original", amountCents: 10000,
      refundedAmountCents: 0, status: PaymentStatus.SUCCEEDED as PaymentStatus, createdAt: new Date("2026-05-01T00:00:00Z") };
    mockPaymentFindUnique.mockResolvedValue({ id: "payment-1", transactions: [transaction] });
    const stripe = new Map<string, { id: string; amount: number; status: string; payment_intent: string; metadata: Record<string, string>; created: number }>();
    const requests: string[] = [];
    mockRefundPaymentTransactions.mockImplementation(async ({ allocation, idempotencyKeyPrefix, metadata }) => {
      const sent = allocation[0];
      const key = refundSliceStripeIdempotencyKey(idempotencyKeyPrefix, sent);
      requests.push(key);
      if (!stripe.has(key)) stripe.set(key, { id: `re_${stripe.size}`, amount: sent.amountCents, status: "succeeded",
        payment_intent: "pi_original", metadata, created: 1782864000 });
      const refund = stripe.get(key)!;
      if (requests.length === 1) throw new PartialRefundError({
        completedRefundCents: 0, refunds: [], refusedSlices: [], cause: new Error("recording failed after Stripe succeeded"), format: CLUB_FORMAT_TEST,
      });
      return { refunds: [{ refundId: refund.id, paymentIntentId: "pi_original", amountCents: refund.amount, status: refund.status, slice: sent }] };
    });

    const outcome = await executeBookingModificationRefund({ format: CLUB_FORMAT_TEST, bookingId: "booking-1",
      result: { pendingRefundAmountCents: 8000, paymentId: "payment-1", bookingModificationId: "mod-1", organiserChildRefund: null } as never,
      idempotencyKeyPrefix: "mod_dates_refund_booking-1", failureMessage: "refund failed", recoveryFailureMessage: "enqueue failed" });
    expect(outcome.refundDestination).toBe("own_card_pending");
    const data = mockPaymentRecoveryCreateMany.mock.calls[0][0].data[0];

    // charge.refunded has now recorded the $80; only $20 headroom remains.
    transaction.refundedAmountCents = 8000;
    transaction.status = PaymentStatus.PARTIALLY_REFUNDED;
    mockListRefundsForPaymentIntent.mockResolvedValue([...stripe.values()]);
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation({ ...data, id: "recovery-1", status: "PROCESSING", attempts: 1 }));
    expect(await runPaymentRecoveryOperationNow("recovery-1", CLUB_FORMAT_TEST)).toBe("succeeded");
    expect([...stripe.values()].reduce((sum, refund) => sum + refund.amount, 0)).toBe(8000);
    expect(requests).toEqual(["mod_dates_refund_booking-1_mod-1_txn-1_8000", "mod_dates_refund_booking-1_mod-1_txn-1_8000"]);
    expect(data.allocationPlan).toEqual([slice]);
  });

  it("processes a booking modification refund recovery by replaying refundPaymentTransactions", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-mod-refund",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        idempotencyKey: "payment_recovery_modification_refund_mod-1",
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { status?: unknown; attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-mod-refund",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            idempotencyKey: "payment_recovery_modification_refund_mod-1",
            paymentTransactionId: null,
          }),
        ]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        // The allocation derived on first processing is frozen on the row and
        // executed as explicit slices (#1097).
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        metadata: {
          bookingId: "booking-1",
          reason: "booking_modification_refund_recovery",
        },
        idempotencyKeyPrefix: expect.stringContaining(
          "payment_recovery_modification_refund_",
        ),
      }),
    );
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "recovery-mod-refund" },
        data: {
          allocationPlan: [
            { paymentTransactionId: "txn-1", amountCents: 4000 },
          ],
        },
      }),
    );
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: heldClaimWhere("recovery-mod-refund"),
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("replays a frozen allocation plan on retry instead of re-deriving it (#1097)", async () => {
    const planned = makeOperation({
      id: "recovery-mod-planned",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      // A previous attempt froze this plan, then died mid-refund. The current
      // payment state would derive a different allocation — the frozen slices
      // must win so the original Stripe keys are replayed.
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 1500 }],
      idempotencyKey: "payment_recovery_modification_refund_mod-2",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(planned);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...planned, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 1500,
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 1500 }],
      }),
    );
    // No re-derivation: the only operation update is the completion.
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ allocationPlan: expect.anything() }),
      }),
    );
  });

  it("replays the route's stored Stripe key prefix on modification refund recovery (#1152)", async () => {
    const stored = makeOperation({
      id: "recovery-mod-prefixed",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      idempotencyKey: "payment_recovery_modification_refund_mod-3",
      stripeKeyPrefix: "mod_dates_refund_bk1_mod-3",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(stored);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...stored, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The route's exact prefix is replayed: a refund Stripe already holds
    // under these keys is returned, not re-minted.
    // #1507: the metadata reason is ALSO reconstructed from that stored prefix
    // (mod_dates_refund_* -> "date_change_price_decrease"), so the body is
    // byte-identical to the inline date-change refund and Stripe replays the
    // original instead of rejecting the reused key.
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKeyPrefix: "mod_dates_refund_bk1_mod-3",
        metadata: {
          bookingId: "booking-1",
          reason: "date_change_price_decrease",
        },
      }),
    );
  });

  it("replays a byte-identical modification-refund Stripe body from the stored key prefix, so it converges instead of hitting idempotency_error (#1507)", async () => {
    // Regression for #1507 (booking_modification half of the #1494 pattern). The
    // inline settlement helper stamps a per-path reason (here guest removal) and
    // stores the Stripe key prefix on the recovery row (#1152). If the inline
    // Stripe refund succeeded but the local recording was lost, the cron replays
    // under that same prefix — which only converges if the request BODY matches
    // byte-for-byte. Before #1507 the cron sent
    // reason:"booking_modification_refund_recovery" while the inline path sent
    // reason:"guest_removed_price_decrease", so Stripe rejected the reused key
    // with idempotency_error and the operation retried to exhaustion. The cron
    // now reconstructs the inline reason from the persisted prefix.
    const crashed = makeOperation({
      id: "recovery-mod-lost-recording",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "payment_recovery_modification_refund_mod-9",
      stripeKeyPrefix: "guest_remove_refund_bk1_mod-9",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Exact-object assertion: the body is byte-identical to what the inline
    // guest-removal path sent (asserted against the real shared builder).
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    expect(refundArgs.metadata).toEqual(
      buildBookingModificationRefundMetadata(
        "booking-1",
        "guest_removed_price_decrease",
      ),
    );
    expect(refundArgs.metadata).toEqual({
      bookingId: "booking-1",
      reason: "guest_removed_price_decrease",
    });
    expect(refundArgs.idempotencyKeyPrefix).toBe("guest_remove_refund_bk1_mod-9");
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
  });

  // #4101: one row per Stripe key prefix a refund recovery stores, pinning the
  // request the REPLAY sends under it to a literal reason rather than to the map
  // under test. This proves the replay side only. That the inline sender stamps
  // the same literal is proved elsewhere: for the four booking-edit callers by
  // modification-refund-replay-reason.test.ts (INV-MOD-061), and for the other
  // four by their own senders' tests (payment-reconciliation, manual-refund-task
  // and the late-capture tests above). A prefix added to the map is not listed
  // here until someone adds its row.
  it.each([
    ["mod_dates_refund_booking-1_mod-1", "date_change_price_decrease"],
    ["mod_batch_refund_booking-1_mod-1", "batch_modification"],
    ["guest_remove_refund_booking-1_mod-1", "guest_removed_price_decrease"],
    ["guest_accept_refund_booking-1_mod-1", "guest_accepted_promo_reprice"],
    ["capacity_claim_failed_booking-1_pi_1", "capacity_claim_failed"],
    ["duplicate_capture_refund_booking-1_pi_1", "duplicate_capture"],
    ["edit_financial_review_refund_task-1", "edit_financial_review"],
    ["late_cancel_refund_booking-1_pi_1", "cancelled_booking_late_capture"],
  ])(
    "replays a refund stored under %s with the inline reason %s (#4101)",
    async (stripeKeyPrefix, inlineReason) => {
      const crashed = makeOperation({
        id: "recovery-replay-reason",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        idempotencyKey: "payment_recovery_modification_refund_replay-reason",
        stripeKeyPrefix,
        paymentTransactionId: null,
      });
      mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { where?: { attempts?: { gte?: number } } }) =>
          Promise.resolve(
            isStaleWorkerSweep(args) ? [] : [{ ...crashed, status: "PENDING" }],
          ),
      );

      await processPaymentRecoveryOperations({ limit: 1 });

      const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
      expect(refundArgs.idempotencyKeyPrefix).toBe(stripeKeyPrefix);
      expect(refundArgs.metadata).toEqual({
        bookingId: "booking-1",
        reason: inlineReason,
      });
    },
  );

  it("replays a treasurer-approved late-capture refund under the webhook's own prefix and body, then queues the Xero correction (#3639)", async () => {
    // The approval persisted this debt inside its claim and the inline refund
    // did not finish. The replay must send exactly what the webhook's automatic
    // refund of the same capture sends, so whichever reached Stripe first, the
    // other is answered with the original refund.
    const crashed = makeOperation({
      id: "recovery-late-approval",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 2500,
      allocationPlan: [{ paymentTransactionId: "txn-late", amountCents: 2500 }],
      idempotencyKey: "late_capture_approval_refund_recovery_pi_late",
      stripeKeyPrefix: "late_cancel_refund_booking-1_pi_late",
      // The payment's representative intent, which is not the late capture's.
      paymentIntentId: "pi_primary",
      paymentTransactionId: null,
    });
    setPlannedChargeFixtures([{ paymentTransactionId: "txn-late", amountCents: 2500 }], "pi_late");
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    expect(refundArgs.metadata).toEqual({
      bookingId: "booking-1",
      reason: "cancelled_booking_late_capture",
    });
    expect(refundArgs.idempotencyKeyPrefix).toBe("late_cancel_refund_booking-1_pi_late");
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-late", amountCents: 2500 },
    ]);
    expect(mockQueueLateCaptureRefundCreditNote).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentId: "payment-1",
        stripeKeyPrefix: "late_cancel_refund_booking-1_pi_late",
        amountCents: 2500,
      }),
    );
  });

  it("writes the approved refund's record only on the replay that moves it to SUCCEEDED (#3639 delta D6)", async () => {
    const crashed = makeOperation({
      id: "recovery-late-approval-2",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 2500,
      allocationPlan: [{ paymentTransactionId: "txn-late", amountCents: 2500 }],
      idempotencyKey: "late_capture_approval_refund_recovery_pi_late",
      stripeKeyPrefix: "late_cancel_refund_booking-1_pi_late",
      paymentTransactionId: null,
    });
    setPlannedChargeFixtures([{ paymentTransactionId: "txn-late", amountCents: 2500 }], "pi_late");
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [{ ...crashed, status: "PENDING" }]),
    );
    // Someone else (the inline close, late) already moved it.
    mockPaymentRecoveryUpdateMany.mockImplementation(
      (args: { data?: { status?: unknown } }) =>
        Promise.resolve({
          count: args.data?.status === PaymentRecoveryOperationStatus.SUCCEEDED ? 0 : 1,
        }),
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockQueueLateCaptureRefundCreditNote).not.toHaveBeenCalled();
    // #4125: the inline door can close it first, so losing that race is expected - debug, not a warning.
    const lostClose = ([, message]: unknown[]) => typeof message === "string" && message.includes("completion matched no live claim");
    expect(vi.mocked(logger.warn).mock.calls.filter(lostClose)).toHaveLength(0);
    expect(vi.mocked(logger.debug).mock.calls.filter(lostClose)).toHaveLength(1);
  });

  it("replays a byte-identical refund-request Stripe body after a lost inline recording, so it converges instead of hitting idempotency_error (#1507)", async () => {
    // Regression for #1507 (refund_request half of the #1494 pattern). The admin
    // approve route creates the appeal refund under refund_request_<id>; if it
    // fails the cron replays under the same prefix (#1039). Before #1507 the cron
    // sent reason:"refund_request_refund_recovery" while the route sent
    // reason:"refund_appeal_approved", so a Stripe-succeeded-but-unrecorded
    // refund hit idempotency_error on replay. Both now build from the shared
    // buildRefundRequestRefundMetadata helper.
    const crashed = makeOperation({
      id: "recovery-refund-request-lost-recording",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "refund_request_refund_refund-7",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    // Byte-identical to the inline appeal body asserted in
    // admin-refund-request-review-route.test.ts.
    expect(refundArgs.metadata).toEqual(
      buildRefundRequestRefundMetadata("booking-1", "refund-7"),
    );
    expect(refundArgs.metadata).toEqual({
      bookingId: "booking-1",
      reason: "refund_appeal_approved",
      refundRequestId: "refund-7",
    });
    expect(refundArgs.idempotencyKeyPrefix).toBe("refund_request_refund-7");
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
  });

  it("derives every inline modification-refund reason from its stored key prefix (#1507 freeze)", () => {
    // Freezes the map's answer for the four executeBookingModificationRefund
    // callers' prefixes, and a few others, against fixed literals: a changed
    // reason for one of these prefixes breaks it. It cannot see a NEW caller;
    // modification-refund-replay-reason.test.ts finds every caller (INV-MOD-061).
    expect(
      bookingModificationRefundReasonForKeyPrefix("mod_dates_refund_bk_mod"),
    ).toBe("date_change_price_decrease");
    expect(
      bookingModificationRefundReasonForKeyPrefix("mod_batch_refund_bk_mod"),
    ).toBe("batch_modification");
    expect(
      bookingModificationRefundReasonForKeyPrefix("guest_remove_refund_bk_mod"),
    ).toBe("guest_removed_price_decrease");
    // #4101: the guest-acceptance re-price, missing until then.
    expect(
      bookingModificationRefundReasonForKeyPrefix("guest_accept_refund_bk_mod"),
    ).toBe("guest_accepted_promo_reprice");
    // #3639: a treasurer-approved late-capture refund replays the webhook's body.
    expect(
      bookingModificationRefundReasonForKeyPrefix("late_cancel_refund_bk_pi"),
    ).toBe("cancelled_booking_late_capture");
    // Legacy rows (pre-#1152, no stored prefix) keep the historical recovery
    // reason — they were never shared-key with the inline refund.
    expect(bookingModificationRefundReasonForKeyPrefix(null)).toBe(
      "booking_modification_refund_recovery",
    );
    expect(
      bookingModificationRefundReasonForKeyPrefix(
        "payment_recovery_modification_refund_op-1",
      ),
    ).toBe("booking_modification_refund_recovery");
  });

  it("replays a refund-request recovery with the route's original Stripe key prefix (#1039)", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-refund-request",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        idempotencyKey: "refund_request_refund_refund-1",
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { status?: unknown; attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-refund-request",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            idempotencyKey: "refund_request_refund_refund-1",
            paymentTransactionId: null,
          }),
        ]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Reusing refund_request_<id> means a refund that succeeded on Stripe but
    // was never recorded locally is replayed by Stripe, not issued again.
    // #1507: the metadata is ALSO byte-identical to the inline appeal body
    // (reason "refund_appeal_approved", built from the shared helper), so the
    // reused key replays the original refund instead of being rejected as an
    // idempotency_error.
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        metadata: {
          bookingId: "booking-1",
          reason: "refund_appeal_approved",
          refundRequestId: "refund-1",
        },
        idempotencyKeyPrefix: "refund_request_refund-1",
      }),
    );
  });

  it("replays a multi-transaction refund-request recovery from its frozen plan, sending slices deep-equal to the frozen plan rather than re-deriving (#1510)", async () => {
    // #1510: the approve route freezes the inline attempt's per-transaction
    // slices on the operation BEFORE the Stripe call. On a multi-transaction
    // payment with partial refund progress, re-deriving a newest-first plan at
    // replay time — over ledger state a completed slice has already moved —
    // would shift the slice amounts and mint fresh
    // refund_request_<id>_<txn>_<amount> keys, creating NEW refunds instead of
    // replaying the originals. The frozen plan is replayed verbatim.
    const frozenPlan = [
      { paymentTransactionId: "txn-new", amountCents: 3000 },
      { paymentTransactionId: "txn-old", amountCents: 1000 },
    ];
    const crashed = makeOperation({
      id: "recovery-refund-request-multi",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: frozenPlan,
      idempotencyKey: "refund_request_refund_refund-11",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );
    // The current payment state has DIFFERENT refundable amounts than when the
    // plan was frozen: the inline attempt already fully refunded txn-new, so a
    // re-derivation would skip it and put all 4000 on txn-old — different
    // slices, different keys.
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_new",
      transactions: [
        {
          id: "txn-new",
          stripePaymentIntentId: "pi_new",
          amountCents: 3000,
          refundedAmountCents: 3000,
          status: PaymentStatus.REFUNDED,
          createdAt: new Date("2026-05-10T00:00:00.000Z"),
        },
        {
          id: "txn-old",
          stripePaymentIntentId: "pi_old",
          amountCents: 5000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      ],
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    // Verbatim frozen slices — NOT a re-derivation over the moved ledger state.
    expect(refundArgs.allocation).toEqual(frozenPlan);
    expect(refundArgs.amountCents).toBe(4000);
    expect(refundArgs.idempotencyKeyPrefix).toBe("refund_request_refund-11");
    expect(refundArgs.metadata).toEqual(
      buildRefundRequestRefundMetadata("booking-1", "refund-11"),
    );
    // The frozen plan is authoritative — no re-derivation/re-freeze.
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ allocationPlan: expect.anything() }),
      }),
    );
  });

  it("falls back to derive-at-replay for a pre-#1510 refund-request recovery with no frozen plan", async () => {
    // Operations enqueued before #1510 carry no allocationPlan. The replay
    // derives a newest-first plan from current payment state and freezes it —
    // unchanged behaviour, and post-#1507 single-transaction payments already
    // share slice keys with the inline refund, so old rows are no worse off.
    const legacy = makeOperation({
      id: "recovery-refund-request-legacy",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: null,
      idempotencyKey: "refund_request_refund_refund-legacy",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(legacy);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...legacy, status: "PENDING" }]);
      },
    );
    // Default payment: a single captured txn-1 (10000, refunded 0).

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Derived newest-first from current state and frozen on the row.
    expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "recovery-refund-request-legacy" },
        data: {
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        },
      }),
    );
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
    // Still the shared refund_request prefix + byte-identical inline body.
    expect(refundArgs.idempotencyKeyPrefix).toBe("refund_request_refund-legacy");
    expect(refundArgs.metadata).toEqual(
      buildRefundRequestRefundMetadata("booking-1", "refund-legacy"),
    );
  });

  it("enqueueRefundRequestRefundRecovery persists the route-frozen allocation plan (#1510)", async () => {
    await enqueueRefundRequestRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      refundRequestId: "refund-1",
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
    });

    expect(mockPaymentRecoveryCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({
          idempotencyKey: "refund_request_refund_refund-1",
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 4000,
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        })],
      }),
    );
  });

  it("replays the inline cancel Stripe key prefix on booking cancellation refund recovery (#1160)", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-cancel-refund",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        idempotencyKey: "booking_cancel_refund_recovery_booking-1",
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-cancel-refund",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            idempotencyKey: "booking_cancel_refund_recovery_booking-1",
            paymentTransactionId: null,
          }),
        ]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The recovery reconstructs booking_cancel_refund_<bookingId> (the inline
    // cancel key), so a refund Stripe already holds under those keys is
    // replayed, not re-minted. #1494: the metadata is ALSO byte-identical to
    // the inline body — { bookingId, reason: "cancellation" }, no
    // refundPercentage — so Stripe replays the original refund instead of
    // rejecting the reused key with idempotency_error.
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        metadata: {
          bookingId: "booking-1",
          reason: "cancellation",
        },
        idempotencyKeyPrefix: "booking_cancel_refund_booking-1",
      }),
    );
  });

  it("replays a byte-identical Stripe body (metadata + key) after a lost inline recording, so it converges instead of hitting idempotency_error (#1494)", async () => {
    // Regression for #1494. The frozen-plan design promises that if the inline
    // Stripe refund succeeds but the local recording is lost (crash window),
    // the cron replays the identical slices under the identical idempotency
    // key and Stripe answers with the ORIGINAL refund. That only holds if the
    // request BODY matches byte-for-byte too. Before #1494 the cron sent
    // metadata.reason = "booking_cancellation_refund_recovery" (and no
    // refundPercentage) while the inline path sent reason = "cancellation" +
    // refundPercentage, so Stripe rejected the reused key with
    // idempotency_error and the operation retried to exhaustion. Both callers
    // now build the body from buildBookingCancellationRefundMetadata, so the
    // replay is exactly what the inline path first sent.
    const crashed = makeOperation({
      id: "recovery-cancel-lost-recording",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "booking_cancel_refund_recovery_booking-1",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // Exact-object assertion (not objectContaining): the body is byte-identical
    // to the inline cancel body asserted in booking-cancel.test.ts.
    const [refundArgs] = mockRefundPaymentTransactions.mock.calls[0];
    expect(refundArgs.metadata).toEqual({
      bookingId: "booking-1",
      reason: "cancellation",
    });
    expect(refundArgs.idempotencyKeyPrefix).toBe("booking_cancel_refund_booking-1");
    expect(refundArgs.allocation).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4000 },
    ]);
    // The shape reconstructs purely from the persisted bookingId, so an
    // operation enqueued BEFORE this fix (no persisted metadata) replays the
    // same converged body through this same path — no fallback branch needed.
    expect(refundArgs.metadata).toEqual(
      buildBookingCancellationRefundMetadata("booking-1"),
    );
  });

  it("replays a claim-frozen allocation plan for a crashed booking cancellation refund (#1349)", async () => {
    // #1349: booking-cancel persists this operation INSIDE the claim
    // transaction, with the allocation frozen from the under-lock read. A
    // process death before (or during) the inline Stripe call leaves it
    // PENDING; the cron must execute EXACTLY the frozen slices under the
    // inline cancel key prefix — identical Stripe idempotency keys — so any
    // slice the inline path already completed is replayed by Stripe, never
    // repeated.
    const crashed = makeOperation({
      id: "recovery-cancel-crash",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      idempotencyKey: "booking_cancel_refund_recovery_booking-1",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(crashed);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...crashed, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        amountCents: 4000,
        allocation: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        idempotencyKeyPrefix: "booking_cancel_refund_booking-1",
      }),
    );
    // The frozen plan is authoritative — no re-derivation/re-freeze.
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ allocationPlan: expect.anything() }),
      }),
    );
    // Replayed to completion.
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: heldClaimWhere("recovery-cancel-crash"),
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("enqueueBookingCancellationRefundRecovery persists the claim-frozen allocation plan (#1349)", async () => {
    await enqueueBookingCancellationRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      amountCents: 4000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
    });

    expect(mockPaymentRecoveryCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({
          idempotencyKey: "booking_cancel_refund_recovery_booking-1",
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 4000,
          allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
        })],
      }),
    );
  });

  it("enqueueCapacityClaimFailedRefundRecovery persists the claim-frozen plan and the inline capacity_claim_failed Stripe key prefix", async () => {
    await enqueueCapacityClaimFailedRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentIntentId: "pi_original",
      amountCents: 10000,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
    });

    expect(mockPaymentRecoveryCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({
          idempotencyKey: "capacity_claim_failed_refund_recovery_booking-1_pi_original",
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 10000,
          stripeKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
          allocationPlan: [
            { paymentTransactionId: "txn-1", amountCents: 10000 },
          ],
        })],
      }),
    );
  });

  it("replays a capacity-race refund recovery under the stored inline Stripe key prefix with the reconstructed inline metadata", async () => {
    const capacityOp = makeOperation({
      id: "recovery-capacity",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 10000,
      idempotencyKey:
        "capacity_claim_failed_refund_recovery_booking-1_pi_original",
      stripeKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
      paymentTransactionId: null,
      paymentIntentId: "pi_original",
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(capacityOp);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...capacityOp, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The replay executes the FROZEN slices under the inline
    // `capacity_claim_failed_<bookingId>_<pi>` prefix with the byte-identical
    // metadata the inline path sent — Stripe answers a refund that already
    // succeeded with the original refund instead of idempotency_error, and
    // the ledger dedupes on refund id (never a double refund).
    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      paymentId: "payment-1",
      amountCents: 10000,
      allocation: [{ paymentTransactionId: "txn-1", amountCents: 10000 }],
      metadata: { bookingId: "booking-1", reason: "capacity_claim_failed" },
      idempotencyKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
    });
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: heldClaimWhere("recovery-capacity"),
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("dispatches a group settlement refund recovery to the frozen-plan executor (#1351)", async () => {
    const groupOp = makeOperation({
      id: "recovery-group-settlement",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 9000,
      idempotencyKey: "group_settlement_refund_recovery_settle-1",
      paymentTransactionId: null,
      paymentIntentId: "pi_settle_1",
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(groupOp);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...groupOp, status: "PENDING" }]);
      },
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockExecuteGroupSettlementRefundPlan).toHaveBeenCalledWith(
      "settle-1",
      CLUB_FORMAT_TEST,
    );
    // The anchor payment is never read and no refund is derived from it.
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: heldClaimWhere("recovery-group-settlement"),
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.SUCCEEDED,
        }),
      }),
    );
  });

  it("dispatches an organiser child's refund to its own executor, never to the child's transactions (#3653)", async () => {
    const childOp = makeOperation({
      id: "recovery-organiser-child",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 1500,
      idempotencyKey: "organiser_child_refund_mod_mod-1",
      paymentTransactionId: null,
      paymentIntentId: "pi_settle_1",
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(childOp);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [{ ...childOp, status: "PENDING" }]),
    );
    mockProcessOrganiserChildRefundOperation.mockResolvedValue("re_child");

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockProcessOrganiserChildRefundOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "recovery-organiser-child" }),
      CLUB_FORMAT_TEST,
    );
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    expect(mockExecuteGroupSettlementRefundPlan).not.toHaveBeenCalled();
  });

  it("retries a group settlement replay whose Stripe call failed, alerting only on exhaustion (#1351)", async () => {
    const groupOp = makeOperation({
      id: "recovery-group-settlement-fail",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      amountCents: 9000,
      attempts: 1,
      idempotencyKey: "group_settlement_refund_recovery_settle-1",
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(groupOp);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...groupOp, status: "PENDING" }]);
      },
    );
    mockExecuteGroupSettlementRefundPlan.mockRejectedValueOnce(
      new Error("stripe still down"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.retried).toBe(1);
    // Not exhausted yet: retry scheduled, NO admin alert.
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "recovery-group-settlement-fail",
        }),
        data: expect.objectContaining({
          status: PaymentRecoveryOperationStatus.FAILED,
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
  });

  it("enqueueGroupSettlementRefundRecovery upserts a delayed operation and re-arms it on inline failure (#1351)", async () => {
    await enqueueGroupSettlementRefundRecovery({
      organiserBookingId: "org-booking-1",
      paymentId: "org-payment-1",
      settlementId: "settle-1",
      paymentIntentId: "pi_settle_1",
      amountCents: 9000,
      retryDelayMs: 10 * 60 * 1000,
    });

    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          idempotencyKey: "group_settlement_refund_recovery_settle-1",
        },
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "org-booking-1",
          paymentId: "org-payment-1",
          paymentIntentId: "pi_settle_1",
          amountCents: 9000,
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
    const created = mockPaymentRecoveryUpsert.mock.calls[0][0].create;
    expect(created.nextRetryAt.getTime()).toBeGreaterThan(
      Date.now() + 9 * 60 * 1000,
    );

    // Inline failure re-arms for immediate retry with the error recorded.
    await enqueueGroupSettlementRefundRecovery({
      organiserBookingId: "org-booking-1",
      paymentId: "org-payment-1",
      settlementId: "settle-1",
      paymentIntentId: "pi_settle_1",
      amountCents: 9000,
      retryDelayMs: 0,
      lastError: "stripe down",
    });
    const rearm = mockPaymentRecoveryUpsert.mock.calls[1][0].update;
    expect(rearm.lastError).toBe("stripe down");
    expect(rearm.nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("skips the Stripe call when the outstanding refund balance has already been settled", async () => {
    mockPaymentRecoveryFindUnique.mockResolvedValue(
      makeOperation({
        id: "recovery-mod-settled",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        amountCents: 4000,
        paymentTransactionId: null,
      }),
    );
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          makeOperation({
            id: "recovery-mod-settled",
            type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
            status: "PENDING",
            amountCents: 4000,
            paymentTransactionId: null,
          }),
        ]);
      },
    );
    mockPaymentFindUnique.mockResolvedValue({
      id: "payment-1",
      stripePaymentIntentId: "pi_original",
      transactions: [
        {
          id: "txn-1",
          stripePaymentIntentId: "pi_original",
          amountCents: 10000,
          refundedAmountCents: 10000,
          status: PaymentStatus.REFUNDED,
        },
      ],
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
  });

  it("alerts admins when a booking modification refund recovery exhausts its retries", async () => {
    const exhaustedOperation = makeOperation({
      id: "recovery-mod-fail",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      attempts: 5,
      amountCents: 4000,
      paymentTransactionId: null,
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(exhaustedOperation);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          { ...exhaustedOperation, status: "PENDING" },
        ]);
      },
    );
    mockRefundPaymentTransactions.mockRejectedValue(
      new Error("Stripe is unavailable"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4000,
        errorMessage: expect.stringContaining(
          "REFUND_BOOKING_MODIFICATION failed after",
        ),
      }),
      CLUB_FORMAT_TEST,
    );
  });

  // #4117: a card refund's slices Stripe already made stay in its plan, marked,
  // and its amount keeps them (the cancellation's, the runner's and a refund
  // request's rows). The retries-exhausted alert names only what failed.
  it("alerts the officers for the unmade part only when a card refund with a made slice exhausts its retries", async () => {
    const exhaustedOperation = makeOperation({
      id: "recovery-made-slice-fail",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      idempotencyKey: "refund_request_refund_rq-made",
      attempts: 5,
      amountCents: 4000,
      paymentTransactionId: null,
      allocationPlan: [
        { paymentTransactionId: "txn-made", amountCents: 2500, madeRefundId: "re_made" },
        { paymentTransactionId: "txn-owed", amountCents: 1500, stripeKeySuffix: "refused1" },
      ],
    });
    mockPaymentRecoveryFindUnique.mockResolvedValue(exhaustedOperation);
    mockPaymentRecoveryFindMany.mockImplementation((args?: { where?: { attempts?: { gte?: number } } }) =>
      Promise.resolve(isStaleWorkerSweep(args) ? [] : [{ ...exhaustedOperation, status: "PENDING" }]),
    );
    mockRefundPaymentTransactions.mockRejectedValue(new Error("Stripe is unavailable"));

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1500, errorMessage: expect.stringContaining("failed after 5 attempts") }),
      CLUB_FORMAT_TEST,
    );
  });

  // #4117: the final attempt itself may make slices. The alert reads what the
  // dead row still owes AFTER it is marked failed - netting the refunds
  // recorded since, as "Refunds owed" does - never the claim-time copy.
  describe("the retries-exhausted alert reads what the final attempt left owed (#4117)", () => {
    const made = { paymentTransactionId: "txn-made", amountCents: 2500 };
    const owed = { paymentTransactionId: "txn-owed", amountCents: 1500 };
    const exhausted = () =>
      makeOperation({
        id: "recovery-final",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        idempotencyKey: "refund_request_refund_rq-final",
        attempts: 5,
        amountCents: 4000,
        paymentTransactionId: null,
        allocationPlan: [made, owed],
        createdAt: new Date("2026-05-23T00:00:00.000Z"),
      });
    // The payment as it stands after the final attempt: the made slice recorded.
    const afterFinalAttempt = (plan: unknown) => ({
      status: "PARTIALLY_REFUNDED",
      amountCents: 10000,
      refundedAmountCents: 2500,
      recoveryOperations: [{ ...exhausted(), status: "FAILED", allocationPlan: plan, succeededAt: null }],
      refunds: [
        { stripeRefundId: "re_final_made", paymentTransactionId: "txn-made", amountCents: 2500, status: "succeeded", createdAt: new Date("2026-05-23T00:05:00.000Z"), stripeCreatedAt: new Date("2026-05-23T00:05:00.000Z") },
      ],
    });
    const arm = (plan: unknown) => {
      const operation = exhausted();
      mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
      mockPaymentRecoveryFindMany.mockImplementation((args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [{ ...operation, status: "PENDING" }]),
      );
      mockPaymentFindUnique.mockImplementation(async (args?: { select?: { recoveryOperations?: unknown } }) =>
        args?.select?.recoveryOperations ? afterFinalAttempt(plan) : null,
      );
    };
    const alertedCents = () => (mockSendAdminPaymentFailureAlert.mock.calls.at(-1)?.[0] as { amountCents: number }).amountCents;

    it("one slice made and the other refused: only the refused $15.00", async () => {
      arm([{ ...made, madeRefundId: "re_final_made" }, { ...owed, stripeKeySuffix: "refused1" }]);
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [
          { status: "succeeded", slice: made, refundId: "re_final_made", paymentIntentId: "pi_made", amountCents: 2500 },
          { status: "failed", slice: owed, refundId: "re_final_refused", paymentIntentId: "pi_owed", amountCents: 1500 },
        ],
      });

      expect((await processPaymentRecoveryOperations({ limit: 1 })).failed).toBe(1);
      expect(alertedCents()).toBe(1500);
    });

    it("one slice made and the next threw: only the unmade $15.00, though the plan was never re-planned", async () => {
      arm([made, owed]);
      // A partial failure's shape: the slice answered before the throw rides along.
      mockRefundPaymentTransactions.mockRejectedValue(
        Object.assign(new Error("Stripe is unavailable"), {
          refunds: [{ status: "succeeded", slice: made, refundId: "re_final_made", paymentIntentId: "pi_made", amountCents: 2500 }],
        }),
      );

      expect((await processPaymentRecoveryOperations({ limit: 1 })).failed).toBe(1);
      expect(alertedCents()).toBe(1500);
    });
  });

  // #4083 (`INV-PAY-128`): a replay Stripe answered `failed` or `canceled`
  // returns normally from `refundPaymentTransactions`. The row must stay owed,
  // and its retry must not replay the refused key - Stripe answers a repeated
  // key with the original refusal for 24 hours.
  describe("#4083: a refund Stripe refused is still owed and is retried under a fresh key", () => {
    const refusedRefund = (slice: Record<string, unknown>, status: string) => ({
      paymentIntentId: "pi_original",
      refundId: `re_${status}`,
      amountCents: slice.amountCents,
      status,
      slice,
    });

    function queueOperation(overrides: Record<string, unknown>) {
      const operation = makeOperation({
        id: "recovery-refused",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        paymentTransactionId: null,
        ...overrides,
      });
      setPlannedChargeFixtures(operation.allocationPlan);
      mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
      mockPaymentRecoveryFindMany.mockImplementation((args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [{ ...operation, status: "PENDING" }]),
      );
      return operation;
    }

    const planWrites = () =>
      mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
        .filter((args) => "allocationPlan" in args.data);
    const closed = () =>
      mockPaymentRecoveryUpdateMany.mock.calls.some(
        ([args]) => (args as { data: { status?: string } }).data.status === PaymentRecoveryOperationStatus.SUCCEEDED,
      );

    it.each([
      ["an edit's refund", "booking_modification_refund_mod-1", "failed"],
      ["an edit's refund", "booking_modification_refund_mod-1", "canceled"],
      ["a cancellation's refund", "booking_cancel_refund_recovery_booking-1", "failed"],
      ["an approved refund request's refund", "refund_request_refund_rq-1", "canceled"],
    ])("%s answered %s: not closed; the slice moves to its next key on the attempt held; the attempt is retried", async (_label, idempotencyKey, status) => {
      const slice = { paymentTransactionId: "txn-1", amountCents: 1500 };
      const operation = queueOperation({ idempotencyKey, amountCents: 1500, allocationPlan: [slice] });
      mockRefundPaymentTransactions.mockResolvedValue({ refunds: [refusedRefund(slice, status)], totalRefundedAmountCents: 1500 });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 0, retried: 1, failed: 0 });
      expect(closed()).toBe(false);
      expect(planWrites()).toEqual([
        {
          where: { id: operation.id, status: PaymentRecoveryOperationStatus.PROCESSING, processingStartedAt: operation.processingStartedAt },
          data: { allocationPlan: [{ ...slice, stripeKeySuffix: "refused1" }] },
        },
      ]);
      // The officers hear of it once, from the write that moved the row off its first keys.
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 1500,
          errorMessage: "Stripe refused $15.00 of this card refund (failed or cancelled), so that $15.00 did not go back and is still owed; it will be retried automatically.",
        }),
        CLUB_FORMAT_TEST,
      );
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentRecoveryOperationStatus.FAILED,
            lastError: expect.stringContaining("still owed"),
            nextRetryAt: expect.any(Date),
          }),
        }),
      );
    });

    it("the retry sends the refused slice under its fresh key generation, and closes once Stripe makes it", async () => {
      const moved = { paymentTransactionId: "txn-1", amountCents: 1500, stripeKeySuffix: "refused1" };
      queueOperation({
        idempotencyKey: "booking_modification_refund_mod-1",
        stripeKeyPrefix: "mod_dates_refund_booking-1_mod-1",
        amountCents: 1500,
        allocationPlan: [moved],
        attempts: 2,
      });
      mockRefundPaymentTransactions.mockResolvedValue({ refunds: [refusedRefund(moved, "succeeded")], totalRefundedAmountCents: 1500 });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 1, retried: 0 });
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ allocation: [moved], idempotencyKeyPrefix: "mod_dates_refund_booking-1_mod-1" }),
      );
      expect(planWrites()).toEqual([]);
      expect(closed()).toBe(true);
    });

    it("a slice marked made is never sent again: the retry sends only the refused one, and closes once Stripe makes it", async () => {
      const made = { paymentTransactionId: "txn-2", amountCents: 1000, madeRefundId: "re_made" };
      const moved = { paymentTransactionId: "txn-1", amountCents: 500, stripeKeySuffix: "refused1" };
      queueOperation({ idempotencyKey: "booking_cancel_refund_recovery_booking-1", amountCents: 1500, allocationPlan: [made, moved], attempts: 2 });
      mockRefundPaymentTransactions.mockResolvedValue({ refunds: [refusedRefund(moved, "succeeded")], totalRefundedAmountCents: 500 });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 1 });
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 500, allocation: [moved] }));
      expect(planWrites()).toEqual([]);
      expect(closed()).toBe(true);
    });

    it("a second refusal moves the slice on again, never back to a key already refused", async () => {
      const moved = { paymentTransactionId: "txn-1", amountCents: 1500, stripeKeySuffix: "refused1" };
      queueOperation({ idempotencyKey: "booking_modification_refund_mod-1", amountCents: 1500, allocationPlan: [moved], attempts: 2 });
      mockRefundPaymentTransactions.mockResolvedValue({ refunds: [refusedRefund(moved, "failed")], totalRefundedAmountCents: 1500 });

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(planWrites()[0]?.data).toEqual({ allocationPlan: [{ ...moved, stripeKeySuffix: "refused2" }] });
      // Once per row: it was already off its first keys, so no second alert.
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });

    it("one slice made, one refused: the made slice is marked and never sent again, the refused one moves, and the amount stays the plan's", async () => {
      const made = { paymentTransactionId: "txn-2", amountCents: 1000 };
      const refused = { paymentTransactionId: "txn-1", amountCents: 500 };
      queueOperation({ idempotencyKey: "booking_cancel_refund_recovery_booking-1", amountCents: 1500, allocationPlan: [made, refused] });
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [refusedRefund(made, "succeeded"), refusedRefund(refused, "failed")],
        totalRefundedAmountCents: 1500,
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 0, retried: 1 });
      // #4083 review: the made slice stays this row's - the owed figure fills it
      // with its refund, and the census reads the amount as the plan's total.
      expect(planWrites()[0]?.data).toEqual({
        allocationPlan: [{ ...made, madeRefundId: "re_succeeded" }, { ...refused, stripeKeySuffix: "refused1" }],
      });
      expect(closed()).toBe(false);
    });

    it("a slice refused before a later slice threw moves on in place; the rest keep their keys, and the attempt fails with the thrown error", async () => {
      const refused = { paymentTransactionId: "txn-2", amountCents: 1000 };
      const unsent = { paymentTransactionId: "txn-1", amountCents: 500 };
      queueOperation({ idempotencyKey: "booking_modification_refund_mod-1", amountCents: 1500, allocationPlan: [refused, unsent] });
      mockRefundPaymentTransactions.mockRejectedValue(
        Object.assign(new Error("Stripe is unavailable"), { completedRefundCents: 0, refunds: [refusedRefund(refused, "failed")], refusedSlices: [refused] }),
      );

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 0, retried: 1 });
      expect(planWrites()[0]?.data).toEqual({ allocationPlan: [{ ...refused, stripeKeySuffix: "refused1" }, unsent] });
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastError: "Stripe is unavailable" }) }),
      );
    });

    it("spent retries: the row dies owed and the treasurer is alerted, never closed as paid", async () => {
      const slice = { paymentTransactionId: "txn-1", amountCents: 1500 };
      queueOperation({ idempotencyKey: "booking_modification_refund_mod-1", amountCents: 1500, allocationPlan: [slice], attempts: 5 });
      mockRefundPaymentTransactions.mockResolvedValue({ refunds: [refusedRefund(slice, "failed")], totalRefundedAmountCents: 1500 });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 0, failed: 1 });
      expect(closed()).toBe(false);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 1500, errorMessage: expect.stringContaining("still owed") }),
        CLUB_FORMAT_TEST,
      );
    });
  });

  // #4103 (`INV-PAY-130`): the superseded-payment refund (`REFUND_SUPERSEDED_PAYMENT`)
  // is asked under the row's own key first, as it always was. A refusal must not
  // close the row or tell the member "we have refunded you": it moves to a
  // one-slice plan on a fresh key, which every later attempt sends.
  describe("#4103: a superseded-payment refund Stripe refuses is still owed", () => {
    const slice = { paymentTransactionId: "txn-1", amountCents: 6000 };
    function queueSuperseded(overrides: Record<string, unknown> = {}) {
      const operation = makeOperation({ type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, ...overrides });
      mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
      mockPaymentRecoveryFindMany.mockImplementation((args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [{ ...operation, status: "PENDING" }]),
      );
      mockPaymentTransactionFindUnique.mockResolvedValue({
        id: "txn-1",
        paymentId: "payment-1",
        stripePaymentIntentId: "pi_superseded",
        amountCents: 6000,
        refundedAmountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      });
      return operation;
    }
    const stripeRefund = (status: string) => ({ id: `re_${status}`, amount: 6000, currency: "nzd", status, payment_intent: "pi_superseded" });
    const planWrites = () =>
      mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
        .filter((args) => "allocationPlan" in args.data);
    const closed = () =>
      mockPaymentRecoveryUpdateMany.mock.calls.some(
        ([args]) => (args as { data: { status?: string } }).data.status === PaymentRecoveryOperationStatus.SUCCEEDED,
      );

    it.each([["failed"], ["canceled"]])("answered %s: not closed, no 'refunded' notice; moved to a fresh key on the attempt held, alerted once", async (status) => {
      const operation = queueSuperseded();
      mockProcessRefund.mockResolvedValue(stripeRefund(status));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 0, retried: 1 });
      // The first ask is the row's own key, as before this release.
      expect(mockProcessRefund).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 6000, idempotencyKey: operation.idempotencyKey }));
      expect(closed()).toBe(false);
      expect(mockReportSupersededPaymentRefund).not.toHaveBeenCalled();
      expect(planWrites()).toEqual([
        {
          where: { id: operation.id, status: PaymentRecoveryOperationStatus.PROCESSING, processingStartedAt: operation.processingStartedAt },
          data: { allocationPlan: [{ ...slice, stripeKeySuffix: "refused1" }] },
        },
      ]);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 6000, errorMessage: expect.stringContaining("will be retried automatically") }),
        CLUB_FORMAT_TEST,
      );
    });

    // #4104 review (ML2): a replay of the row's own key reads Stripe's original
    // `pending` for a refund that failed since; the ledger hands it back as
    // refused, so the row moves its key and asks again instead of closing.
    it("MUTATION: a replayed refund the ledger reads as failed since is not closed on: moved to a fresh key", async () => {
      const operation = queueSuperseded();
      mockProcessRefund.mockResolvedValue(stripeRefund("pending"));
      mockRecordStripeRefundsAgainstTransaction.mockResolvedValueOnce({ failedLaterDebts: [], readAsRefused: ["re_pending"] });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 0, retried: 1 });
      expect(closed()).toBe(false);
      expect(mockReportSupersededPaymentRefund).not.toHaveBeenCalled();
      expect(planWrites()).toEqual([
        {
          where: { id: operation.id, status: PaymentRecoveryOperationStatus.PROCESSING, processingStartedAt: operation.processingStartedAt },
          data: { allocationPlan: [{ ...slice, stripeKeySuffix: "refused1" }] },
        },
      ]);
    });

    it("the retry sends the moved slice under the row's key and its generation, then closes and reports once Stripe makes it", async () => {
      const moved = { ...slice, stripeKeySuffix: "refused1" };
      const operation = queueSuperseded({ allocationPlan: [moved], attempts: 2 });
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [{ paymentIntentId: "pi_superseded", refundId: "re_made", amountCents: 6000, status: "succeeded", slice: moved }],
        totalRefundedAmountCents: 6000,
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 1 });
      expect(mockProcessRefund).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ allocation: [moved], amountCents: 6000, idempotencyKeyPrefix: operation.idempotencyKey }),
      );
      expect(closed()).toBe(true);
      expect(mockReportSupersededPaymentRefund).toHaveBeenCalledWith(expect.objectContaining({ refundedAmountCents: 6000 }));
    });

    it("a second refusal moves it on again, never back to a refused key, and is not alerted twice", async () => {
      const moved = { ...slice, stripeKeySuffix: "refused1" };
      queueSuperseded({ allocationPlan: [moved], attempts: 2 });
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [{ paymentIntentId: "pi_superseded", refundId: "re_again", amountCents: 6000, status: "failed", slice: moved }],
        totalRefundedAmountCents: 6000,
      });

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(planWrites()[0]?.data).toEqual({ allocationPlan: [{ ...slice, stripeKeySuffix: "refused2" }] });
      expect(closed()).toBe(false);
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });

    it("a refused attempt whose answer was lost (it threw) keeps its key: the next attempt asks the same", async () => {
      const operation = queueSuperseded();
      mockProcessRefund.mockRejectedValue(new Error("Stripe is unavailable"));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ succeeded: 0, retried: 1 });
      expect(planWrites()).toEqual([]);
      expect(closed()).toBe(false);
      expect(mockReportSupersededPaymentRefund).not.toHaveBeenCalled();
      expect(mockProcessRefund).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: operation.idempotencyKey }));
    });

    it("a replay whose re-plan lost the attempt's fence moves nothing and alerts nobody; the next attempt reads the refusal again", async () => {
      queueSuperseded();
      mockProcessRefund.mockResolvedValue(stripeRefund("failed"));
      mockPaymentRecoveryUpdateMany.mockImplementation((args: { data?: Record<string, unknown> }) =>
        Promise.resolve({ count: args?.data && "allocationPlan" in args.data ? 0 : 1 }),
      );

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(closed()).toBe(false);
      expect(mockReportSupersededPaymentRefund).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });
  });

  // #4083 review: a repeat enqueue refreshes only a row no worker has picked up.
  // One claimed, failed or closed keeps its plan, amount and prefix - its slices
  // may already have been sent under their keys.
  it("a repeat ledger refund enqueue updates only a PENDING row, never one a worker holds (#4083)", async () => {
    mockPaymentRecoveryCreateMany.mockResolvedValueOnce({ count: 0 });

    const result = await enqueueBookingModificationRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      bookingModificationId: "mod-7",
      amountCents: 4000,
      stripeKeyPrefix: "mod_batch_refund_booking-1_mod-7",
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000, stripeKeySuffix: "refused1" }],
    });

    expect(result).toMatchObject({ created: false });
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: { idempotencyKey: "payment_recovery_modification_refund_mod-7", status: PaymentRecoveryOperationStatus.PENDING },
      data: expect.objectContaining({
        amountCents: 4000,
        stripeKeyPrefix: "mod_batch_refund_booking-1_mod-7",
        allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000, stripeKeySuffix: "refused1" }],
      }),
    });
  });

  // #4103 review C2: a redelivery's fresh plan carries no refusal; it must not
  // put a row a refusal re-planned back on the key Stripe answers with that
  // refusal, nor overwrite a plan another writer moves meanwhile.
  describe("a repeat enqueue with a fresh plan, over a row a refusal re-planned (#4103)", () => {
    const enqueueFresh = () =>
      enqueueBookingModificationRefundRecovery({
        bookingId: "booking-1",
        paymentId: "payment-1",
        bookingModificationId: "mod-7",
        amountCents: 4000,
        stripeKeyPrefix: "mod_batch_refund_booking-1_mod-7",
        allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000 }],
      });

    it.each([
      ["a slice moved to its next key", { stripeKeySuffix: "refused1" }],
      ["a slice marked made", { madeRefundId: "re_1" }],
    ])("keeps the held plan when it carries %s", async (_label, progress) => {
      mockPaymentRecoveryCreateMany.mockResolvedValueOnce({ count: 0 });
      mockPaymentRecoveryFindUnique.mockResolvedValueOnce({ allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4000, ...progress }] });

      await expect(enqueueFresh()).resolves.toMatchObject({ created: false });

      expect(mockPaymentRecoveryUpdateMany).not.toHaveBeenCalled();
    });

    it("refreshes an untouched row compare-and-set on the plan it read", async () => {
      const held = [{ paymentTransactionId: "txn-1", amountCents: 4000 }];
      mockPaymentRecoveryCreateMany.mockResolvedValueOnce({ count: 0 });
      mockPaymentRecoveryFindUnique.mockResolvedValueOnce({ allocationPlan: held });

      await enqueueFresh();

      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
        where: {
          idempotencyKey: "payment_recovery_modification_refund_mod-7",
          status: PaymentRecoveryOperationStatus.PENDING,
          allocationPlan: { equals: held },
        },
        data: expect.objectContaining({ allocationPlan: held }),
      });
    });
  });

  it("enqueueBookingModificationRefundRecovery picks the latest captured PaymentIntent", async () => {
    mockPaymentFindUnique.mockResolvedValueOnce({
      id: "payment-1",
      stripePaymentIntentId: "pi_legacy",
      transactions: [
        {
          id: "txn-additional",
          source: PaymentSource.STRIPE,
          stripePaymentIntentId: "pi_additional",
          amountCents: 5000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
        {
          id: "txn-primary",
          source: PaymentSource.STRIPE,
          stripePaymentIntentId: "pi_primary",
          amountCents: 10000,
          refundedAmountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
      ],
    });

    await enqueueBookingModificationRefundRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      bookingModificationId: "mod-7",
      amountCents: 4000,
      stripeKeyPrefix: "mod_batch_refund_booking-1_mod-7",
    });

    expect(mockPaymentRecoveryCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [expect.objectContaining({
          idempotencyKey: "payment_recovery_modification_refund_mod-7",
          type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
          status: PaymentRecoveryOperationStatus.PENDING,
          bookingId: "booking-1",
          paymentId: "payment-1",
          paymentIntentId: "pi_additional",
          amountCents: 4000,
          stripeKeyPrefix: "mod_batch_refund_booking-1_mod-7",
        })],
      }),
    );
  });

  describe("card charges while the club's currency cannot be charged in (#3567)", () => {
    // A queue that honours the worker's own `where` and `take`, so a filter
    // dropped from the query (and moved back into the loop) shows up as the
    // batch filling with charges it then skips.
    type TypeWhere = { where?: { type?: string | { not?: string } } };
    function queueOf(rows: ReturnType<typeof makeOperation>[]) {
      const matches = (row: ReturnType<typeof makeOperation>, where?: TypeWhere["where"]) =>
        where?.type === undefined ||
        (typeof where.type === "string" ? row.type === where.type : row.type !== where.type.not);
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { take?: number } & TypeWhere) =>
          Promise.resolve(
            isStaleWorkerSweep(args) ? [] : rows.filter((r) => matches(r, args?.where)).slice(0, args?.take ?? rows.length),
          ),
      );
      mockPaymentRecoveryFindFirst.mockImplementation((args?: TypeWhere) =>
        Promise.resolve(rows.find((r) => matches(r, args?.where)) ?? null),
      );
    }
    const stalledAlerts = () =>
      mockSendAdminPaymentFailureAlert.mock.calls.filter(([a]) => /queue is stalled/.test((a as { errorMessage?: string })?.errorMessage ?? ""));
    const WAITING_LOG = expect.stringContaining("leaving card charges unclaimed");
    const charges = Array.from({ length: 12 }, (_, n) =>
      makeOperation({
        id: `recovery-charge-${n}`,
        type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
        status: "PENDING",
        paymentIntentId: `mod_guest_bk1_mod-${n}`,
        paymentTransactionId: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)),
      }),
    );
    const refund = makeOperation({
      id: "recovery-mod-refund",
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      status: "PENDING",
      amountCents: 4000,
      idempotencyKey: "payment_recovery_modification_refund_mod-1",
      paymentTransactionId: null,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    it("keeps more than a batch of waiting charges out of the query, so the refund queued behind them still runs", async () => {
      clubFormatMock.mockResolvedValue({ currencyCode: "JPY", locale: "ja-JP" });
      queueOf([...charges, refund]);
      mockPaymentRecoveryFindUnique.mockResolvedValue(refund);

      const result = await processPaymentRecoveryOperations({ limit: 10 });

      expect(result).toMatchObject({ found: 1, processed: 1, succeeded: 1, skipped: 0 });
      const claimedIds = mockPaymentRecoveryUpdateMany.mock.calls
        .filter(([call]) => call?.data?.status === PaymentRecoveryOperationStatus.PROCESSING)
        .map(([call]) => call?.where?.id);
      expect(claimedIds).toEqual(["recovery-mod-refund"]);
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4000 }));
      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    });

    it("does not call deliberately waiting charges a stalled queue", async () => {
      clubFormatMock.mockResolvedValue({ currencyCode: "JPY", locale: "ja-JP" });
      queueOf(charges);

      const result = await processPaymentRecoveryOperations({ limit: 10 });

      expect(result).toMatchObject({ found: 0, processed: 0 });
      expect(mockPaymentRecoveryFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ type: { not: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT } }),
        }),
      );
      expect(stalledAlerts()).toHaveLength(0);
    });

    it("claims charges again once the currency is fixed, without calling the wait a stalled cron", async () => {
      // The admin fixed the currency ten minutes ago; these charges waited for months.
      mockLoadPersistedClubFormat.mockResolvedValueOnce({ updatedAt: new Date(Date.now() - 10 * 60 * 1000) });
      queueOf([charges[0]]);
      await processPaymentRecoveryOperations({ limit: 10 });
      const queueRead = mockPaymentRecoveryFindMany.mock.calls.find(([a]) => !isStaleWorkerSweep(a));
      expect(queueRead?.[0]?.where).not.toHaveProperty("type");
      expect(stalledAlerts()).toHaveLength(0);
    });

    it("does alert on a charge still waiting once the club format has been unchanged past the stale window", async () => {
      mockLoadPersistedClubFormat.mockResolvedValueOnce({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
      queueOf([charges[0]]);
      mockPaymentRecoveryFindUnique.mockResolvedValue(null);
      await processPaymentRecoveryOperations({ limit: 10 });
      expect(stalledAlerts()).toHaveLength(1);
    });

    it("says charges are waiting once per run, at warn, and only while one is actually waiting", async () => {
      clubFormatMock.mockResolvedValue({ currencyCode: "JPY", locale: "ja-JP" });
      queueOf([refund]);
      mockPaymentRecoveryFindUnique.mockResolvedValue(refund);
      await processPaymentRecoveryOperations({ limit: 10 });
      expect(logger.warn).not.toHaveBeenCalledWith(WAITING_LOG);
      expect(logger.error).not.toHaveBeenCalledWith(WAITING_LOG);

      queueOf([...charges, refund]);
      await processPaymentRecoveryOperations({ limit: 10 });
      expect(vi.mocked(logger.warn).mock.calls.filter(([m]) => typeof m === "string" && m.includes("leaving card charges unclaimed"))).toHaveLength(1);
    });
  });

  describe("additional PaymentIntent recovery (#1096)", () => {
    function additionalIntentOperation(overrides: Record<string, unknown> = {}) {
      return makeOperation({
        id: "recovery-additional",
        type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
        amountCents: 3000,
        // The stored Stripe idempotency key until the intent exists.
        paymentIntentId: "mod_guest_bk1_mod-9",
        idempotencyKey: "payment_recovery_additional_intent_mod-9",
        paymentTransactionId: null,
        // #3181: this edit HAD a primary Xero invoice when it dispatched, which
        // is what makes a deferred supplementary invoice the right completion.
        hadIssuedXeroInvoice: true,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        ...overrides,
      });
    }

    function primeQueue(operation: ReturnType<typeof makeOperation>) {
      mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { where?: { attempts?: { gte?: number } } }) => {
          if (isStaleWorkerSweep(args)) {
            return Promise.resolve([]);
          }
          return Promise.resolve([{ ...operation, status: "PENDING" }]);
        },
      );
    }

    beforeEach(() => {
      mockPaymentFindUnique.mockResolvedValue({
        id: "payment-1",
        stripeCustomerId: "cus_123",
        stripePaymentIntentId: "pi_original",
        transactions: [
          {
            id: "txn-1",
            kind: "PRIMARY",
            stripePaymentIntentId: "pi_original",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: PaymentStatus.SUCCEEDED,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        ],
        booking: {
          id: "booking-1",
          memberId: "m1",
          member: {
            id: "m1",
            email: "alice@test.com",
            firstName: "Alice",
            lastName: "Smith",
          },
        },
      });
      mockCreatePaymentIntent.mockResolvedValue({
        id: "pi_recovered",
        client_secret: "secret_recovered",
      });
    });

    /**
     * #3641 review round: a failed attach used to be logged and forgotten, and
     * the invoice then waited on no intent until the age backstop retired it
     * while the member paid. The recovery still completes (the intent exists),
     * and an officer is told.
     */
    it("alerts an officer, and still completes, when the waiting invoice cannot be pointed at the recovered intent", async () => {
      primeQueue(additionalIntentOperation());
      mockAttachIntentToWaitingOps.mockRejectedValueOnce(new Error("database is down"));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockSendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: "SUPPLEMENTARY_INVOICE_INTENT_NOT_ATTACHED",
          errorMessage: expect.stringContaining("pi_recovered"),
        }),
      );
    });

    /**
     * #4036: the replay sends the request the DOOR sent under that key - the
     * door's own reason, named by the key frozen on the row - so Stripe answers
     * it with the intent a lost reply minted rather than an `idempotency_error`.
     * The ledger row it writes keeps the runner's own reason.
     */
    it("replays the door's request: the door's reason, named by the frozen key", async () => {
      primeQueue(additionalIntentOperation({ paymentIntentId: "mod_dates_booking-1_mod-9" }));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledWith({
        format: expect.anything(),
        amountCents: 3000,
        customerId: "cus_123",
        metadata: { bookingId: "booking-1", type: "modification_additional", reason: "date_change_price_increase" },
        idempotencyKey: "mod_dates_booking-1_mod-9",
      });
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_recovered", reason: "modification_additional_recovery" }),
      );
    });

    /**
     * #4081: an ask write refused because its intent is another edit's
     * (`AdditionalAskAttributionConflictError`) meets the same row on every
     * retry, so the recovery ends on the first refusal: FAILED with no retry,
     * at the attempt ceiling the claim and the stuck-state page read, the cause
     * named for the officer, and one alert now rather than after five attempts.
     */
    const recoveryFailureAlerts = () =>
      mockSendAdminPaymentFailureAlert.mock.calls
        .map(([alert]) => (alert as { errorMessage: string }).errorMessage)
        .filter((message) => message.startsWith("Stripe payment recovery CREATE_ADDITIONAL_PAYMENT_INTENT failed"));

    it("#4081: an ask write refused for another edit's row ends the recovery at once - one alert naming the cause, no retry", async () => {
      primeQueue(additionalIntentOperation({ attempts: 1 }));
      mockBookingModificationFindUnique.mockResolvedValue({ priceDiffCents: 3000, changeFeeCents: 0, modificationType: "GUEST_ADD" });
      const { AdditionalAskAttributionConflictError } = await import("@/lib/payment-intent-ledger-row-write");
      mockUpsertPaymentIntentTransaction.mockRejectedValueOnce(
        new AdditionalAskAttributionConflictError("pi_recovered", "mod-9"),
      );

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ processed: 1, failed: 1, retried: 0, succeeded: 0 });
      const failureWrites = mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
        .filter((args) => args.data?.status === PaymentRecoveryOperationStatus.FAILED);
      expect(failureWrites).toHaveLength(1);
      expect(failureWrites[0]!.where).toMatchObject({ id: "recovery-additional", attempts: 1 });
      expect(failureWrites[0]!.data).toEqual({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: expect.stringContaining("which is already recorded for another change to the same booking"),
        processingStartedAt: null,
        nextRetryAt: null,
        // The claim refuses a row here (`attempts < MAX`), and every dead-row reader counts it.
        attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
      });
      expect(failureWrites[0]!.data.lastError).toContain("pi_recovered");
      // One failure alert (the stale-queue alert this fixture's old row also raises is not one).
      expect(recoveryFailureAlerts()).toEqual([
        expect.stringMatching(/failed after 1 attempt: The card request for the "Guests Added" change to this booking could not be recorded: Stripe returned card request pi_recovered, which is already recorded for another change/),
      ]);
      // An ordinary ask's dead recovery withdraws nothing: the intent is the other edit's ask.
      expect(mockCancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
    });

    it("#4217: an ask write refused because its intent's row is on another payment ends the recovery at once", async () => {
      primeQueue(additionalIntentOperation({ attempts: 1 }));
      mockBookingModificationFindUnique.mockResolvedValue({ priceDiffCents: 3000, changeFeeCents: 0, modificationType: "GUEST_ADD" });
      const { IntentLedgerRowOnAnotherPaymentError } = await import("@/lib/payment-intent-ledger-row-write");
      mockUpsertPaymentIntentTransaction.mockRejectedValueOnce(
        new IntentLedgerRowOnAnotherPaymentError("pi_recovered", "payment-1", "payment-other"),
      );

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ processed: 1, failed: 1, retried: 0, succeeded: 0 });
      const failureWrites = mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
        .filter((args) => args.data?.status === PaymentRecoveryOperationStatus.FAILED);
      expect(failureWrites).toHaveLength(1);
      expect(failureWrites[0]!.data).toMatchObject({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: expect.stringContaining("already filed under a different payment"),
        nextRetryAt: null,
        attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
      });
    });

    it("#4081: any other failure of the same replay still backs off and retries, silently", async () => {
      primeQueue(additionalIntentOperation({ attempts: 1 }));
      mockUpsertPaymentIntentTransaction.mockRejectedValueOnce(new Error("connection reset"));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result).toMatchObject({ processed: 1, failed: 0, retried: 1 });
      const failure = mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { data: Record<string, unknown> })
        .find((args) => args.data?.status === PaymentRecoveryOperationStatus.FAILED);
      expect(failure!.data).toEqual({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: "connection reset",
        processingStartedAt: null,
        nextRetryAt: expect.any(Date),
      });
      expect(recoveryFailureAlerts()).toEqual([]);
    });

    it("re-creates the intent with the stored modification-scoped Stripe key", async () => {
      primeQueue(additionalIntentOperation());

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 3000,
          customerId: "cus_123",
          idempotencyKey: "mod_guest_bk1_mod-9",
          metadata: expect.objectContaining({
            bookingId: "booking-1",
            type: "modification_additional",
          }),
        }),
      );
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: "payment-1",
          paymentIntentId: "pi_recovered",
          amountCents: 3000,
          status: PaymentStatus.PENDING,
          // #3954 rounds 7 and 8: the edit's frozen invoice answer, and the
          // edit itself, ride onto the row the replay writes.
          hadIssuedXeroInvoice: true,
          bookingModificationId: "mod-9",
        }),
      );
      // The real supersede looked for older live asks, excluding this one.
      expect(mockPaymentTransactionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            paymentId: "payment-1",
            kind: "ADDITIONAL",
            stripePaymentIntentId: { not: "pi_recovered" },
          }),
        }),
      );
      // The waiting supplementary Xero op is pointed at the recovered intent,
      // through the helper that alerts if that fails (#3641).
      expect(mockAttachRecoveredIntent).toHaveBeenCalledWith({
        bookingModificationId: "mod-9",
        paymentIntentId: "pi_recovered",
        recoveryOperationId: "recovery-additional",
      });
      expect(mockAttachIntentToWaitingOps).toHaveBeenCalledWith({
        bookingModificationId: "mod-9",
        paymentIntentId: "pi_recovered",
      });
      // The row's placeholder key is replaced by the real intent id.
      expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "recovery-additional" },
          data: { paymentIntentId: "pi_recovered" },
        }),
      );
    });

    /*
      #3340 fix round — THE ASK IS RE-DERIVED HERE, NOT REPLAYED.

      Before #3340 the ask was a delta: a fact about an edit, which never goes
      stale, so freezing it on the recovery row was exactly right. Since #3340 it
      is the edit's net PLUS whatever is still unpaid on the ask it supersedes -
      a fact about a MOMENT - and a frozen moment can OVERCHARGE.

      The shape: edit 1 raises $70 and is NOT cancelled, because the mint that
      would have superseded it is the one that failed. Edit 2 sizes $140 and
      freezes it. The member's page still renders edit 1's live secret and they
      pay that $70. The cron then replays $140 against $70 genuinely outstanding.
    */
    function paymentWithAsk(
      additionalAmountCents: number,
      additionalPaymentStatus: string,
    ) {
      return {
        id: "payment-1",
        stripeCustomerId: "cus_123",
        stripePaymentIntentId: "pi_original",
        additionalAmountCents,
        additionalPaymentStatus,
        transactions: [
          {
            id: "txn-1",
            kind: "PRIMARY",
            stripePaymentIntentId: "pi_original",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: PaymentStatus.SUCCEEDED as PaymentStatus,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        ],
        booking: {
          id: "booking-1",
          memberId: "m1",
          member: {
            id: "m1",
            email: "alice@test.com",
            firstName: "Alice",
            lastName: "Smith",
          },
        },
      };
    }

    describe("a price reduction's re-issued ask (#3954 round 4)", () => {
      const REISSUE_KEY = "mod_reissued_ask_mod-9";
      beforeEach(() => {
        // The reducing edit's own net is negative: the replay sizes a re-issue.
        mockBookingModificationFindUnique.mockResolvedValueOnce({ priceDiffCents: -2000, changeFeeCents: 0 });
      });

      it("MUTATION: overtaken by a later ask that did not fold it in, it still mints - its own $30 plus that ask's unpaid $20, superseding it", async () => {
        primeQueue(additionalIntentOperation({ amountCents: 3000, paymentIntentId: REISSUE_KEY }));
        const base = paymentWithAsk(2000, PaymentStatus.PENDING);
        const later = { ...base, transactions: [...base.transactions as Array<Record<string, unknown>>] };
        later.transactions.push({
          id: "txn-later",
          kind: "ADDITIONAL",
          stripePaymentIntentId: "pi_later_review_charge",
          amountCents: 2000,
          refundedAmountCents: 0,
          status: PaymentStatus.PENDING,
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        });
        mockPaymentFindUnique.mockResolvedValue(later);
        mockPaymentTransactionFindMany.mockResolvedValueOnce([
          { id: "txn-later", stripePaymentIntentId: "pi_later_review_charge", amountCents: 2000 },
        ]);

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
          expect.objectContaining({ amountCents: 5000, idempotencyKey: `${REISSUE_KEY}_5000` }),
        );
        expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
          expect.objectContaining({ amountCents: 5000, carriedAskCents: 5000 }),
        );
      });

      it("MUTATION (round 6): sends the one request the door sends for the same key - the fixed reason and the key in its metadata", async () => {
        primeQueue(additionalIntentOperation({ amountCents: 3000, paymentIntentId: REISSUE_KEY }));
        mockPaymentFindUnique.mockResolvedValue(paymentWithAsk(2000, PaymentStatus.SUCCEEDED));

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        const { planReissuedAskMint } = await import("@/lib/reissued-ask-mint");
        const plan = planReissuedAskMint({
          bookingId: "booking-1",
          recovery: { amountCents: 3000, stripeKey: REISSUE_KEY },
          payment: { additionalAmountCents: 2000, additionalPaymentStatus: PaymentStatus.SUCCEEDED },
        });
        expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
          expect.objectContaining({ amountCents: 3000, idempotencyKey: REISSUE_KEY, metadata: plan.metadata }),
        );
        expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
          expect.objectContaining({ reason: plan.reason }),
        );
      });

      it("MUTATION (round 6): an idempotency_error on the key the door already minted under writes the door's intent rather than failing for ever", async () => {
        primeQueue(additionalIntentOperation({ amountCents: 3000, paymentIntentId: REISSUE_KEY }));
        mockPaymentFindUnique.mockResolvedValue(paymentWithAsk(2000, PaymentStatus.SUCCEEDED));
        mockCreatePaymentIntent.mockRejectedValueOnce(
          Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { rawType: "idempotency_error" }),
        );
        mockFindRecentPaymentIntentByMetadata.mockResolvedValueOnce({ id: "pi_door_minted", amount: 3000, client_secret: "s" });

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
          expect.objectContaining({ paymentIntentId: "pi_door_minted", amountCents: 3000 }),
        );
      });

      it("MUTATION: settled once its OWN row exists - a retry after a later failure mints nothing twice", async () => {
        primeQueue(additionalIntentOperation({ amountCents: 3000, paymentIntentId: "pi_own_reissue" }));
        const ownBase = paymentWithAsk(3000, PaymentStatus.PENDING);
        const written = { ...ownBase, transactions: [...ownBase.transactions as Array<Record<string, unknown>>] };
        written.transactions.push({
          id: "txn-own",
          kind: "ADDITIONAL",
          stripePaymentIntentId: "pi_own_reissue",
          amountCents: 3000,
          refundedAmountCents: 0,
          status: PaymentStatus.PENDING,
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        });
        mockPaymentFindUnique.mockResolvedValue(written);

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
        expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      });
    });

    it("MUTATION (#3954 round 6): an increase that folded a waiting re-issue in asks for it again on its replay - the fold closed that re-issue's own recovery", async () => {
      primeQueue(additionalIntentOperation({ amountCents: 5000 }));
      mockBookingModificationFindUnique.mockResolvedValueOnce({
        priceDiffCents: 3000,
        changeFeeCents: 0,
        newData: { foldedReissuedAskCents: 2000, foldedReissuedAskModificationIds: ["mod-reduction"] },
      });
      mockPaymentFindUnique.mockResolvedValue(paymentWithAsk(7000, PaymentStatus.SUCCEEDED));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 5000, idempotencyKey: "mod_guest_bk1_mod-9" }),
      );
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 5000, carriedAskCents: 2000 }),
      );
    });

    it.each([
      ["missing change", null, PaymentStatus.SUCCEEDED],
      ["zero-net change", { priceDiffCents: 0, changeFeeCents: 0 }, PaymentStatus.SUCCEEDED],
      ["refunded capture", null, PaymentStatus.REFUNDED],
      ["partly refunded capture", null, PaymentStatus.PARTIALLY_REFUNDED],
    ] as const)("refuses an unverifiable frozen replay after a capture (%s), on every retry", async (_name, modification, status) => {
      const payment = paymentWithAsk(7000, PaymentStatus.SUCCEEDED);
      payment.transactions.push({
        ...payment.transactions[0]!,
        id: "txn-a",
        kind: "ADDITIONAL",
        stripePaymentIntentId: "pi_a",
        amountCents: 7000,
        status,
      });
      mockPaymentFindUnique.mockResolvedValue(payment);
      for (const attempts of [1, 2, MAX_PAYMENT_RECOVERY_ATTEMPTS]) {
        mockBookingModificationFindUnique.mockResolvedValueOnce(modification);
        primeQueue(additionalIntentOperation({ amountCents: 10000, attempts }));
        const result = await processPaymentRecoveryOperations({ limit: 1 });
        expect(result).toMatchObject({
          succeeded: 0,
          retried: attempts < MAX_PAYMENT_RECOVERY_ATTEMPTS ? 1 : 0,
          failed: attempts < MAX_PAYMENT_RECOVERY_ATTEMPTS ? 0 : 1,
        });
      }

      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      expect(mockPaymentTransactionFindMany).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(expect.objectContaining({
        errorMessage: expect.stringContaining("cannot safely replay its frozen amount"),
      }), expect.anything());
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ lastError: expect.stringContaining("cannot safely replay its frozen amount") }),
      }));
    });

    it("re-derives a smaller ask when the superseded one was paid in the meantime", async () => {
      primeQueue(additionalIntentOperation({ amountCents: 10000 }));
      // $70 was outstanding when edit 2 sized its $100 ask; the member has since
      // paid it, so only the edit's own $30 is still owed.
      mockPaymentFindUnique.mockResolvedValue(
        paymentWithAsk(7000, PaymentStatus.SUCCEEDED),
      );

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 3000,
          // A changed amount is a different request. Stripe refuses a key reused
          // with different parameters, so replaying the stored key here would be
          // a permanent idempotency_error on every remaining attempt.
          idempotencyKey: "mod_guest_bk1_mod-9_3000",
        }),
      );
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: "pi_recovered",
          amountCents: 3000,
        }),
      );
    });

    it("keeps the stored Stripe key when the re-derivation lands on the frozen figure", async () => {
      primeQueue(additionalIntentOperation({ amountCents: 10000 }));
      // Nothing was paid in between: the superseded $70 is still outstanding, so
      // the ask is the same $100 the row froze.
      mockPaymentFindUnique.mockResolvedValue(
        paymentWithAsk(7000, PaymentStatus.PENDING),
      );
      // ...and the ledger row behind that live $70, which the real supersede
      // reads and must retire once the replay has absorbed it (#3341).
      mockPaymentTransactionFindMany.mockResolvedValueOnce([
        { id: "txn-add-1", stripePaymentIntentId: "pi_edit1", amountCents: 7000 },
      ]);

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 10000,
          idempotencyKey: "mod_guest_bk1_mod-9",
        }),
      );
      // The absorbed $70 intent is retired through the durable queue, not left
      // live beside the $100 ask that now carries it.
      expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
            paymentTransactionId: "txn-add-1",
            paymentIntentId: "pi_edit1",
            amountCents: 7000,
          }),
        }),
      );
    });

    /*
      #3340 fix round — the replay writes the NEW intent's row before retiring
      the old one, for the reason spelled out in
      `superseded-additional-mint-ordering.test.ts`: the cancel reconciles the
      payment aggregates, and a reconcile run before this row exists mirrors the
      intent being retired back over the Payment.
    */
    it("writes the recovered intent's ADDITIONAL row before queueing the supersede", async () => {
      primeQueue(additionalIntentOperation());

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(
        mockUpsertPaymentIntentTransaction.mock.invocationCallOrder[0],
      ).toBeLessThan(mockPaymentTransactionFindMany.mock.invocationCallOrder[0]);
    });

    // #4217 review (F1): Payment, then the recovery row - the order a reduction
    // that gave credit back (and so already wrote the Payment row) closes this
    // recovery in. The recovery first deadlocks it.
    it("MUTATION (#4217): the claim hold locks the Payment row before it re-stamps the recovery row", async () => {
      const operation = additionalIntentOperation();
      primeQueue(operation);

      await processPaymentRecoveryOperations({ limit: 1 });

      const holdIndex = mockPaymentRecoveryUpdateMany.mock.calls.findIndex(([args]) => {
        const { where, data } = args as { where: Record<string, unknown>; data: Record<string, unknown> };
        return where.status === "PROCESSING" && "processingStartedAt" in data && !("status" in data);
      });
      expect(holdIndex).toBeGreaterThanOrEqual(0);
      expect(mockLockPaymentForRefundedTotal).toHaveBeenCalledWith(expect.anything(), operation.paymentId);
      expect(mockLockPaymentForRefundedTotal.mock.invocationCallOrder[0]!).toBeLessThan(
        mockPaymentRecoveryUpdateMany.mock.invocationCallOrder[holdIndex]!,
      );
    });

    it("MUTATION (#3954 round 4): writes its row only while it still holds its claim - a reduction that closed it mid-mint gets no row, no supersede, no completion", async () => {
      primeQueue(additionalIntentOperation({ status: "PROCESSING", attempts: 1, processingStartedAt: new Date("2026-06-30T23:00:00.000Z") }));
      // The claim succeeds; the hold, re-asserting that claim before the row is
      // written, finds the recovery closed by a price reduction.
      mockPaymentRecoveryUpdateMany.mockImplementation(async (args: { data?: { status?: string } }) =>
        args.data?.status === "PROCESSING" ? { count: 1 } : { count: 0 },
      );

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
      const hold = mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
        .find((args) => args.where.status === "PROCESSING" && "processingStartedAt" in args.data);
      expect(hold?.where).toMatchObject({ id: "recovery-additional", attempts: 1 });
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      expect(mockPaymentTransactionFindMany).not.toHaveBeenCalled();
      expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalled();
    });

    /**
     * #4631: the hold lost, so the intent the runner minted is written nowhere.
     * When the recovery ended without it - a net-off, a fold, or (#4652) a stale
     * reclaim's runner that closed it with another intent or none - and nothing
     * names the intent, it is cancelled at Stripe as abandoned - after the hold's transaction has
     * ended, on #4052's proof re-read just before the cancel. The proof itself
     * is `reissued-ask-abandoned-intent.test.ts`'s; the real-PostgreSQL races
     * are `additional-ask-reduction.realdb.test.ts`'s.
     */
    describe("#4631: a lost claim hold cancels the runner's own unwritten intent", () => {
      const CLOSED_READ = { status: true, lastError: true, paymentIntentId: true };
      /** The Stripe key the recovery names until a hold writes an intent over it. */
      const KEY = "mod_guest_bk1_mod-9";
      const transactionsOpenAtCancel: number[] = [];
      // `clearAllMocks` keeps implementations; this one has no `beforeEach` default to restore it.
      afterEach(() => {
        mockPaymentRecoveryFindFirst.mockReset();
        ordinaryAskMint4631.adopted = false;
      });

      function loseHoldTo(moved: { status: string; lastError: string | null; paymentIntentId?: string }, owners: { row?: { id: string } | null; recovery?: { id: string } | null } = {}) {
        const operation = additionalIntentOperation({ status: "PROCESSING", attempts: 1, processingStartedAt: new Date("2026-06-30T23:00:00.000Z") });
        primeQueue(operation);
        // The claim succeeds; the hold, re-asserting it before the row is written, finds it gone.
        mockPaymentRecoveryUpdateMany.mockImplementation(async (args: { data?: { status?: string } }) =>
          args.data?.status === "PROCESSING" ? { count: 1 } : { count: 0 },
        );
        mockPaymentRecoveryFindUnique.mockImplementation(async (args: { select?: unknown }) =>
          JSON.stringify(args?.select) === JSON.stringify(CLOSED_READ) ? { paymentIntentId: KEY, ...moved } : operation,
        );
        const defaultRow = mockPaymentTransactionFindUnique.getMockImplementation();
        mockPaymentTransactionFindUnique.mockImplementation(async (args: { where?: { stripePaymentIntentId?: string } }) =>
          args?.where?.stripePaymentIntentId === "pi_recovered" ? (owners.row ?? null) : defaultRow?.(args),
        );
        mockPaymentRecoveryFindFirst.mockImplementation(async (args: { where?: { paymentIntentId?: unknown } }) =>
          args?.where?.paymentIntentId === "pi_recovered" ? (owners.recovery ?? null) : null,
        );
        transactionsOpenAtCancel.length = 0;
        mockCancelPaymentIntentIfCancellableWithResult.mockReset();
        mockCancelPaymentIntentIfCancellableWithResult.mockImplementation(async (id: string) => {
          transactionsOpenAtCancel.push(openTransactions.count);
          return { canceled: true, paymentIntent: { id, status: "canceled" } };
        });
      }

      /** Not vacuous: the run minted, lost its hold, and re-read the recovery for the proof. */
      function expectReachedLostHold() {
        expect(mockCreatePaymentIntent).toHaveBeenCalledTimes(1);
        expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
        expect(mockPaymentRecoveryFindUnique).toHaveBeenCalledWith({ where: { id: "recovery-additional" }, select: CLOSED_READ });
      }

      it.each([
        ["netted off by a price reduction", PENDING_ASK_NETTED_BY_REDUCTION_NOTE, KEY],
        ["folded into a later increase's ask", WAITING_REISSUE_FOLDED_BY_INCREASE_NOTE, KEY],
        // #4652: a stale reclaim's runner closed it with another (amount-suffixed) intent, or with none.
        ["closed by a reclaiming runner with ANOTHER intent", null, "pi_reclaimer"],
        ["closed by a reclaiming runner with no intent", null, KEY],
      ])("MUTATION: a recovery %s has the runner's intent cancelled as abandoned, outside every transaction, and the run ends cleanly", async (_label, lastError, paymentIntentId) => {
        loseHoldTo({ status: "SUCCEEDED", lastError, paymentIntentId });

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expectReachedLostHold();
        expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledTimes(1);
        expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_recovered", { cancellationReason: "abandoned" });
        // The pin: never inside a transaction - the hold's had ended.
        expect(transactionsOpenAtCancel).toEqual([0]);
        const holdIndex = mockPaymentRecoveryUpdateMany.mock.calls.findIndex(([args]) => {
          const { where, data } = args as { where: Record<string, unknown>; data: Record<string, unknown> };
          return where.status === "PROCESSING" && "processingStartedAt" in data && !("status" in data);
        });
        expect(mockPaymentRecoveryUpdateMany.mock.invocationCallOrder[holdIndex]!).toBeLessThan(
          mockCancelPaymentIntentIfCancellableWithResult.mock.invocationCallOrder[0]!,
        );
        expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
      });

      it.each([
        ["a payment row", { row: { id: "txn_recorded" } }],
        ["a recovery (its own, another's, a queued cancel)", { recovery: { id: "op_other" } }],
      ])("MUTATION: an intent %s names is never cancelled", async (_label, owners) => {
        loseHoldTo({ status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE }, owners);
        await processPaymentRecoveryOperations({ limit: 1 });
        expectReachedLostHold();
        expect(mockCancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
      });

      // The interleaving: a writer records the intent after the proof's re-read
      // of the recovery and before its owner check - the cancel never reaches a recorded intent.
      it("MUTATION: a writer recording the intent between the proof's re-read and the owner check wins - nothing cancelled", async () => {
        const owners: { row: { id: string } | null } = { row: null };
        loseHoldTo({ status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE }, owners);
        const proofRead = mockPaymentRecoveryFindUnique.getMockImplementation()!;
        mockPaymentRecoveryFindUnique.mockImplementation(async (args: { select?: unknown }) => {
          const answer = await proofRead(args);
          if (JSON.stringify(args?.select) === JSON.stringify(CLOSED_READ)) owners.row = { id: "txn_written_meanwhile" };
          return answer;
        });

        await processPaymentRecoveryOperations({ limit: 1 });

        expectReachedLostHold();
        expect(mockPaymentTransactionFindUnique).toHaveBeenCalledWith({ where: { stripePaymentIntentId: "pi_recovered" }, select: { id: true } });
        expect(mockCancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
      });

      // #4631 review (F2): an intent found by matching is not the runner's own -
      // another edit's stalled door or recovery may still record it under its key.
      it("MUTATION: an ADOPTED intent (#4036) is never cancelled, even after a net-off", async () => {
        loseHoldTo({ status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE });
        ordinaryAskMint4631.adopted = true;

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expectReachedLostHold();
        expect(mockCancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: "reissued-ask.abandoned-intent-cleanup", outcome: "adopted", paymentIntentId: "pi_recovered", operationId: "recovery-additional" }),
          expect.any(String),
        );
        expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
      });

      it.each([
        ["reset for a retry (PENDING)", { status: "PENDING", lastError: null }],
        ["reclaimed by another runner (PROCESSING)", { status: "PROCESSING", lastError: null }],
        // #4652: stated limits - a live claim that already wrote another intent, and the
        // reclaiming runner's own write of THIS intent (Stripe answered its key with it).
        ["reclaimed by a runner that already wrote ANOTHER intent (PROCESSING)", { status: "PROCESSING", lastError: null, paymentIntentId: "pi_reclaimer" }],
        ["closed naming THIS intent", { status: "SUCCEEDED", lastError: null, paymentIntentId: "pi_recovered" }],
      ])("MUTATION: a recovery %s may yet record the intent, or has - nothing cancelled", async (_label, moved) => {
        loseHoldTo(moved);
        await processPaymentRecoveryOperations({ limit: 1 });
        expectReachedLostHold();
        expect(mockCancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
      });

      it("a Stripe cancel that fails is logged and swallowed: the run still ends cleanly", async () => {
        loseHoldTo({ status: "SUCCEEDED", lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE });
        mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValueOnce(new Error("Stripe is down"));

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
      });
    });

    it("MUTATION (#3954 round 6, F6): re-checks its claim after the supersede and queues no invoice once a reduction has retired the row it wrote", async () => {
      primeQueue(additionalIntentOperation({ status: "PROCESSING", attempts: 1, processingStartedAt: new Date("2026-06-30T23:00:00.000Z") }));
      // The claim and the hold that writes the row succeed; the re-check after
      // the Stripe cancels finds the recovery closed by a price reduction.
      let holds = 0;
      mockPaymentRecoveryUpdateMany.mockImplementation(async (args: { where?: { status?: string }; data?: { status?: string; processingStartedAt?: Date } }) => {
        if (args.data?.status === "PROCESSING") return { count: 1 };
        if (args.where?.status === "PROCESSING" && args.data?.processingStartedAt) {
          holds += 1;
          return { count: holds === 1 ? 1 : 0 };
        }
        return { count: 1 };
      });

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledTimes(1);
      expect(holds).toBe(2);
      const recheck = mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
        .filter((args) => args.where.status === "PROCESSING" && "processingStartedAt" in args.data)[1];
      // Fenced on the claim time the first hold stamped, not the original.
      expect(recheck?.where.processingStartedAt).not.toEqual(new Date("2026-06-30T23:00:00.000Z"));
      expect(mockAttachRecoveredIntent).not.toHaveBeenCalled();
      expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
    });

    /**
     * #4675 (`INV-PAY-120`): the runner's SUCCEEDED close is fenced on the claim
     * this attempt holds. A stale attempt that read "nothing owed" (a later ask
     * settled it) wakes after the reaper handed its row to another runner; its
     * close matches nothing, and it writes, mints and sends nothing more.
     */
    describe("#4675: a close is fenced on the claim the attempt holds", () => {
      const SUCCEEDED_CLOSES = () =>
        mockPaymentRecoveryUpdateMany.mock.calls
          .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
          .filter((args) => args.data.status === PaymentRecoveryOperationStatus.SUCCEEDED);

      function settledByLaterAsk() {
        mockPaymentFindUnique.mockResolvedValue({
          id: "payment-1",
          stripeCustomerId: "cus_123",
          transactions: [
            {
              id: "txn-newer",
              kind: "ADDITIONAL",
              stripePaymentIntentId: "pi_later_edit",
              amountCents: 4500,
              refundedAmountCents: 0,
              status: PaymentStatus.PENDING,
              createdAt: new Date("2026-06-02T00:00:00.000Z"),
            },
          ],
          booking: { id: "booking-1", memberId: "m1", member: { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" } },
        });
      }

      it("MUTATION: a stale attempt's 'nothing owed' close is fenced on its own attempts and claim time, and on losing does nothing more", async () => {
        const claimedAt = new Date("2026-06-30T23:00:00.000Z");
        primeQueue(additionalIntentOperation({ attempts: 2, processingStartedAt: claimedAt }));
        settledByLaterAsk();
        // The reaper handed the row back and another runner reclaimed it: this close loses.
        mockPaymentRecoveryUpdateMany.mockImplementation(async (args: { where?: { id?: string }; data?: { status?: unknown } }) =>
          ({ count: args.data?.status === PaymentRecoveryOperationStatus.SUCCEEDED ? 0 : args.where?.id ? 1 : 0 }));

        await processPaymentRecoveryOperations({ limit: 1 });

        expect(SUCCEEDED_CLOSES().map((close) => close.where)).toEqual([heldClaimWhere("recovery-additional", 2, claimedAt)]);
        expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
        expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
        expect(mockAttachRecoveredIntent).not.toHaveBeenCalled();
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
        const lostClose = ([, message]: unknown[]) => typeof message === "string" && message.includes("completion matched no live claim");
        expect(vi.mocked(logger.warn).mock.calls.filter(lostClose)).toHaveLength(1);
      });

      it("MUTATION: the close after a mint is fenced on the claim time the last hold re-stamped, not the one the run was handed", async () => {
        const claimedAt = new Date("2026-06-30T23:00:00.000Z");
        primeQueue(additionalIntentOperation({ attempts: 1, processingStartedAt: claimedAt }));
        // The clock is frozen, so each hold would stamp the same instant and a close on an
        // earlier claim would pass unseen. A minute passes after every re-stamp instead.
        const frozen = new Date();
        const isHold = (args: { where?: { status?: unknown }; data?: Record<string, unknown> }) =>
          args.where?.status === "PROCESSING" && args.data !== undefined && "processingStartedAt" in args.data && !("status" in args.data);
        const counted = mockPaymentRecoveryUpdateMany.getMockImplementation()!;
        mockPaymentRecoveryUpdateMany.mockImplementation(async (args: { where?: { status?: unknown }; data?: Record<string, unknown> }) => {
          const answer = await counted(args);
          if (isHold(args)) vi.setSystemTime(new Date(Date.now() + 60_000));
          return answer;
        });

        try {
          await processPaymentRecoveryOperations({ limit: 1 });
        } finally {
          vi.setSystemTime(frozen);
        }

        const holds = mockPaymentRecoveryUpdateMany.mock.calls
          .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
          .filter(isHold);
        expect(holds).toHaveLength(2);
        const [first, second] = holds.map((hold) => hold.data.processingStartedAt as Date);
        // The second hold re-asserts the first's re-stamped claim, and stamps a later one.
        expect(holds[1]!.where.processingStartedAt).toEqual(first);
        expect(second!.getTime()).toBeGreaterThan(first!.getTime());
        expect(first).not.toEqual(claimedAt);
        // The close is fenced on the LAST hold's claim, not the first's or the run's own.
        expect(SUCCEEDED_CLOSES().map((close) => close.where)).toEqual([heldClaimWhere("recovery-additional", 1, second)]);
      });
    });

    it("completes without creating when a later edit already minted a newer additional intent", async () => {
      primeQueue(additionalIntentOperation());
      mockPaymentFindUnique.mockResolvedValue({
        id: "payment-1",
        stripeCustomerId: "cus_123",
        transactions: [
          {
            id: "txn-newer",
            kind: "ADDITIONAL",
            stripePaymentIntentId: "pi_later_edit",
            amountCents: 4500,
            refundedAmountCents: 0,
            status: PaymentStatus.PENDING,
            // Created after the operation was enqueued: it superseded ours.
            createdAt: new Date("2026-06-02T00:00:00.000Z"),
          },
        ],
        booking: {
          id: "booking-1",
          memberId: "m1",
          member: {
            id: "m1",
            email: "alice@test.com",
            firstName: "Alice",
            lastName: "Smith",
          },
        },
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
    });

    // #1358 (F29): a booking cancelled after the modification has no increase
    // left to collect — the cancel flow tore down its additional intents, so
    // recovery must complete without minting a live intent or re-arming the
    // waiting supplementary Xero operation.
    it("completes without creating anything when the booking is CANCELLED (#1358)", async () => {
      primeQueue(additionalIntentOperation());
      // #4316: the runner asks the door's own guard, which re-reads the booking.
      mockBookingFindUnique.mockResolvedValueOnce({ status: "CANCELLED" });
      mockPaymentFindUnique.mockResolvedValue({
        id: "payment-1",
        stripeCustomerId: "cus_123",
        stripePaymentIntentId: "pi_original",
        transactions: [
          {
            id: "txn-1",
            kind: "PRIMARY",
            stripePaymentIntentId: "pi_original",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: PaymentStatus.SUCCEEDED,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        ],
        booking: {
          id: "booking-1",
          memberId: "m1",
          status: "CANCELLED",
          member: {
            id: "m1",
            email: "alice@test.com",
            firstName: "Alice",
            lastName: "Smith",
          },
        },
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      expect(mockPaymentTransactionFindMany).not.toHaveBeenCalled();
      expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
    });

    // #4316 (`INV-ADDPAY-044`): the door's own guard - BUMPED retires every ask too.
    it("completes without creating anything when the booking is BUMPED (#4316)", async () => {
      primeQueue(additionalIntentOperation());
      mockBookingFindUnique.mockResolvedValueOnce({ status: "BUMPED" });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
    });

    // #4316: a cancel committing between the replay's check and its row write
    // read a mirror with no such intent; the replay retires the intent it wrote
    // through the cancel's own routine, closes its debt and raises no invoice.
    it("retires the intent it wrote when the booking is cancelled after its row write, and closes the debt with no invoice (#4316)", async () => {
      primeQueue(additionalIntentOperation());
      mockBookingFindUnique.mockResolvedValueOnce({ status: "PAID" }).mockResolvedValueOnce({ status: "CANCELLED" });
      const house = mockPaymentFindUnique.getMockImplementation()!;
      // The mirror the row write's reconcile derived: the recovered ask, outstanding.
      mockPaymentFindUnique.mockImplementation((args?: { select?: Record<string, unknown> }) =>
        args?.select?.additionalPaymentIntentId
          ? Promise.resolve({ id: "payment-1", additionalPaymentIntentId: "pi_recovered", additionalPaymentStatus: "PENDING" })
          : house(args),
      );
      mock4316.transactionFindFirst.mockResolvedValueOnce({ id: "txn-recovered", amountCents: 3000 });
      mockPaymentRecoveryUpsert.mockResolvedValueOnce({ id: "op-cancel-recovered" });
      const operation = additionalIntentOperation();
      mockPaymentRecoveryFindUnique.mockImplementation((args?: { where?: { id?: string } }) =>
        Promise.resolve(
          args?.where?.id === "op-cancel-recovered"
            ? makeOperation({ id: "op-cancel-recovered", paymentIntentId: "pi_recovered", paymentTransactionId: "txn-recovered" })
            : operation,
        ),
      );
      mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({ paymentIntent: { id: "pi_recovered", status: "canceled" }, canceled: true });

      let result: Awaited<ReturnType<typeof processPaymentRecoveryOperations>>;
      try {
        result = await processPaymentRecoveryOperations({ limit: 1 });
      } finally {
        // Nothing this case queued may reach the next one (an unread status would).
        mockBookingFindUnique.mockReset();
        mockPaymentRecoveryFindUnique.mockReset();
      }

      expect(result.succeeded).toBe(1);
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_recovered" }));
      // The cancel claim's own writes: the mirror and the row FAILED, a durable cancellation.
      expect(mock4316.paymentUpdate).toHaveBeenCalledWith({ where: { id: "payment-1" }, data: { additionalPaymentStatus: "FAILED" } });
      expect(mock4316.markFailed).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_recovered" }));
      expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ type: "CANCEL_PAYMENT_INTENT", paymentIntentId: "pi_recovered" }) }),
      );
      // ...run now, and the intent is dead at Stripe.
      expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_recovered");
      mockCancelPaymentIntentIfCancellableWithResult.mockReset();
      // Nothing is owed on an ended booking: no invoice waits on the dead intent.
      expect(mockAttachRecoveredIntent).not.toHaveBeenCalled();
      expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
    });

    // #4316 review round 2: a retirement that fails is not logged and forgotten -
    // the runner throws, so its own row backs off and retries.
    it("throws, leaving its row to retry, when the ask it wrote on an ended booking cannot be retired (#4316)", async () => {
      primeQueue(additionalIntentOperation());
      mockBookingFindUnique.mockResolvedValueOnce({ status: "PAID" }).mockResolvedValueOnce({ status: "CANCELLED" });
      const house = mockPaymentFindUnique.getMockImplementation()!;
      mockPaymentFindUnique.mockImplementation((args?: { select?: Record<string, unknown> }) =>
        args?.select?.additionalPaymentIntentId
          ? Promise.resolve({ id: "payment-1", additionalPaymentIntentId: "pi_recovered", additionalPaymentStatus: "PENDING" })
          : house(args),
      );
      mock4316.paymentUpdate.mockRejectedValueOnce(new Error("deadlock detected"));

      let result: Awaited<ReturnType<typeof processPaymentRecoveryOperations>>;
      try {
        result = await processPaymentRecoveryOperations({ limit: 1 });
      } finally {
        mockBookingFindUnique.mockReset();
      }

      expect(result.succeeded).toBe(0);
      expect(result.retried + result.failed).toBe(1);
      expect(mockAttachRecoveredIntent).not.toHaveBeenCalled();
      expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
    });

    // #4316 review round 2: the retry then finds the booking ended BEFORE its
    // mint, and retires the ask the failed attempt left outstanding on the
    // mirror before it closes - minting nothing.
    it("on a retry, retires the ask its earlier attempt left outstanding on an ended booking, then closes (#4316)", async () => {
      // Round 3 (M1): a REAL retry. The first attempt wrote its ADDITIONAL row
      // (after the operation was created) and named its intent on the
      // operation, so `isRecoveryReplaySettled` reads that row as settling
      // this debt - the ended-booking check has to come first.
      const operation = additionalIntentOperation({ paymentIntentId: "pi_recovered" });
      primeQueue(operation);
      mockBookingFindUnique.mockResolvedValueOnce({ status: "CANCELLED" });
      const house = mockPaymentFindUnique.getMockImplementation()!;
      mockPaymentFindUnique.mockImplementation(async (args?: { select?: Record<string, unknown> }) => {
        if (args?.select?.additionalPaymentIntentId) {
          return { id: "payment-1", additionalPaymentIntentId: "pi_recovered", additionalPaymentStatus: "PENDING" };
        }
        const fixture = (await house(args)) as { transactions: unknown[] };
        return {
          ...fixture,
          transactions: [
            ...fixture.transactions,
            {
              id: "txn-recovered",
              kind: "ADDITIONAL",
              stripePaymentIntentId: "pi_recovered",
              amountCents: 3000,
              carriedAskCents: 0,
              refundedAmountCents: 0,
              status: PaymentStatus.PENDING,
              withdrawnAt: null,
              bookingModificationId: "mod-9",
              createdAt: new Date("2026-06-02T00:00:00.000Z"),
            },
          ],
        };
      });
      mock4316.transactionFindFirst.mockResolvedValueOnce({ id: "txn-recovered", amountCents: 3000 });
      mockPaymentRecoveryUpsert.mockResolvedValueOnce({ id: "op-cancel-recovered" });
      // The queued cancellation is its own row; the immediate run reads that one.
      mockPaymentRecoveryFindUnique.mockImplementation((args?: { where?: { id?: string } }) =>
        Promise.resolve(
          args?.where?.id === "op-cancel-recovered"
            ? makeOperation({ id: "op-cancel-recovered", paymentIntentId: "pi_recovered", paymentTransactionId: "txn-recovered" })
            : operation,
        ),
      );
      mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({ paymentIntent: { id: "pi_recovered", status: "canceled" }, canceled: true });

      let result: Awaited<ReturnType<typeof processPaymentRecoveryOperations>>;
      try {
        result = await processPaymentRecoveryOperations({ limit: 1 });
      } finally {
        mockBookingFindUnique.mockReset();
        mockPaymentRecoveryFindUnique.mockReset();
      }

      expect(result.succeeded).toBe(1);
      expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_recovered");
      mockCancelPaymentIntentIfCancellableWithResult.mockReset();
      expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      expect(mock4316.paymentUpdate).toHaveBeenCalledWith({ where: { id: "payment-1" }, data: { additionalPaymentStatus: "FAILED" } });
      expect(mock4316.markFailed).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_recovered" }));
      expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ type: "CANCEL_PAYMENT_INTENT", paymentIntentId: "pi_recovered" }) }),
      );
    });

    /**
     * #3181: THE INVOICE THE INLINE PATH DEFERRED IS RAISED HERE, OR NOWHERE.
     *
     * The edit path skips the supplementary invoice while no additional
     * PaymentIntent exists and defers to this replay, and the replay used only to
     * ATTACH the recovered intent to an operation already waiting - which, on
     * exactly the edits that skipped, does not exist. The member could pay and
     * the club's books never saw the charge.
     */
    describe("the deferred supplementary invoice (#3181)", () => {
      function paymentWithIssuedInvoice(
        overrides: Record<string, unknown> = {},
      ) {
        return {
          id: "payment-1",
          stripeCustomerId: "cus_123",
          stripePaymentIntentId: "pi_original",
          status: PaymentStatus.SUCCEEDED,
          xeroInvoiceId: "xero-inv-1",
          transactions: [
            {
              id: "txn-1",
              kind: "PRIMARY",
              stripePaymentIntentId: "pi_original",
              amountCents: 10000,
              refundedAmountCents: 0,
              status: PaymentStatus.SUCCEEDED,
              createdAt: new Date("2026-05-01T00:00:00.000Z"),
            },
          ],
          booking: {
            id: "booking-1",
            memberId: "m1",
            member: {
              id: "m1",
              email: "alice@test.com",
              firstName: "Alice",
              lastName: "Smith",
            },
          },
          ...overrides,
        };
      }

      /**
       * #4442 review C-F1: an earlier attempt wrote this recovery's row and
       * recorded its intent on the recovery, then failed before the invoice
       * steps (its re-stamp timed out behind a long holder of the global key).
       * The retry finds its OWN row: it must not read it as a later edit's
       * overtake and complete with no invoice. It resumes the steps, minting
       * nothing, and its write-free re-stamp takes only the Payment row.
       */
      it("#4442 C-F1: a retry that finds its own row resumes the invoice steps instead of completing as overtaken", async () => {
        primeQueue(additionalIntentOperation({ paymentIntentId: "pi_recovered" }));
        const base = paymentWithIssuedInvoice();
        mockPaymentFindUnique.mockResolvedValue({
          ...base,
          transactions: [
            ...base.transactions,
            {
              id: "txn-own",
              kind: "ADDITIONAL",
              stripePaymentIntentId: "pi_recovered",
              amountCents: 3000,
              refundedAmountCents: 0,
              status: PaymentStatus.PENDING,
              // After the recovery was queued: the overtake rule alone would read it as a later ask.
              createdAt: new Date("2026-06-02T00:00:00.000Z"),
            },
          ],
        });
        mockExecuteRaw.mockClear();

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
        expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
        expect(mockAttachIntentToWaitingOps).toHaveBeenCalledWith(
          expect.objectContaining({ paymentIntentId: "pi_recovered" }),
        );
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
          expect.objectContaining({ bookingModificationId: "mod-9", paymentIntentId: "pi_recovered" }),
        );
        expect(mockLockPaymentForRefundedTotal, "the re-stamp takes the Payment row").toHaveBeenCalledWith(expect.anything(), "payment-1");
        const statements = mockExecuteRaw.mock.calls.map(([sql]) => (sql as readonly string[]).join("?"));
        expect(statements.filter((sql) => sql.includes("pg_advisory_xact_lock(1)")), "and not the global key").toEqual([]);
      });

      /**
       * #4442 re-lens F1: the same own row, but a price reduction retired it
       * (`withdrawnAt`) while the recovery sat PENDING. Its money is accounted
       * for by the reduction, so the retry finishes without parking an invoice
       * on an intent nobody can pay.
       */
      it("#4442 C-F1: a retry whose own row a reduction withdrew completes without the invoice steps", async () => {
        primeQueue(additionalIntentOperation({ paymentIntentId: "pi_recovered" }));
        const base = paymentWithIssuedInvoice();
        mockPaymentFindUnique.mockResolvedValue({
          ...base,
          transactions: [
            ...base.transactions,
            {
              id: "txn-own",
              kind: "ADDITIONAL",
              stripePaymentIntentId: "pi_recovered",
              amountCents: 3000,
              refundedAmountCents: 0,
              status: PaymentStatus.FAILED,
              withdrawnAt: new Date("2026-06-02T01:00:00.000Z"),
              createdAt: new Date("2026-06-02T00:00:00.000Z"),
            },
          ],
        });

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
        expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      it("raises it against the recovered intent once the mint succeeds", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledTimes(1);
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
          expect.objectContaining({
            bookingId: "booking-1",
            bookingModificationId: "mod-9",
            paymentIntentId: "pi_recovered",
            hasIssuedXeroInvoice: true,
          }),
        );
      });

      /**
       * #3181 fix round: THE EDIT'S ANSWER, NOT THE PASSAGE OF TIME.
       *
       * The booking's primary Xero invoice had NOT been minted when the edit
       * committed, so the edit queued nothing - correctly, because the primary
       * invoice reads the booking's CURRENT state when its own outbox operation
       * finally runs and therefore bills the edit itself. By the time the replay
       * arrives that invoice exists and `payment.xeroInvoiceId` is set, so a
       * replay that re-derived the flag would raise a SECOND ask for money the
       * primary invoice already carries: $600 of Xero income and a $50
       * receivable for a $550 booking, and only because Stripe blinked.
       *
       * The payment row below deliberately CARRIES the invoice id. That is the
       * whole point: the fact that would mislead a re-derivation is present, and
       * the frozen `hadIssuedXeroInvoice: false` is what stops it.
       */
      it("bills the edit's own answer when the payment row now says otherwise", async () => {
        primeQueue(additionalIntentOperation({ hadIssuedXeroInvoice: false }));
        // Deliberately CARRYING the invoice id: this is the fact that would
        // mislead a re-derivation, and the frozen `false` is what stops it. A
        // `false` reaches the dispatcher rather than short-circuiting here,
        // because "no primary invoice means no supplementary invoice" is
        // `classifyXeroBookingEditSettlement`'s decision and belongs in one
        // place (`INV-SSOT`); the outbox suite's control proves it queues
        // nothing.
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
          expect.objectContaining({ hasIssuedXeroInvoice: false }),
        );
      });

      /**
       * A row enqueued before that answer was recorded cannot be asked, so it is
       * not guessed. The asymmetry is the argument: an invoice this pass fails to
       * raise is surfaced by the booking-vs-Xero repair pass as a critical,
       * one-click finding, while a duplicate it raises in error is surfaced by
       * nobody and lands on the member.
       */
      it("raises nothing when the edit's answer was never recorded", async () => {
        primeQueue(additionalIntentOperation({ hadIssuedXeroInvoice: null }));
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * The recovery row carries what STRIPE is collecting; the invoice bills the
       * edit's two SIGNED components (#1356), which a price reduction plus a
       * larger late-change fee separates. Reaching for `operation.amountCents`
       * would gross-bill the fee and drop the reduction, and would read as
       * correct on every single-component edit.
       */
      it("bills the modification's signed components, not the row's collectable amount", async () => {
        primeQueue(additionalIntentOperation({ amountCents: 3000 }));
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockBookingModificationFindUnique.mockResolvedValue({
          priceDiffCents: -500,
          changeFeeCents: 1000,
        });

        await processPaymentRecoveryOperations({ limit: 1 });

        expect(mockBookingModificationFindUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "mod-9" } }),
        );
        expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
          expect.objectContaining({ priceDiffCents: -500, changeFeeCents: 1000 }),
        );
      });

      /**
       * CONTROL. The cancel flow retired this booking's additional intents, so
       * nothing is minted - and an invoice for money that must never be captured
       * would be worse than the silence this issue removes.
       */
      it("raises nothing when the booking was cancelled", async () => {
        primeQueue(additionalIntentOperation());
        mockBookingFindUnique.mockResolvedValueOnce({ status: "CANCELLED" }); // #4316: the guard's own read
        mockPaymentFindUnique.mockResolvedValue(
          paymentWithIssuedInvoice({
            booking: {
              id: "booking-1",
              memberId: "m1",
              status: "CANCELLED",
              member: {
                id: "m1",
                email: "alice@test.com",
                firstName: "Alice",
                lastName: "Smith",
              },
            },
          }),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * CONTROL. A later edit repriced from current state and minted its own
       * collectable, so this modification's ask is gone; billing for it would
       * invoice money nobody is being asked to pay.
       */
      it("raises nothing when a later edit already superseded this one", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(
          paymentWithIssuedInvoice({
            transactions: [
              {
                id: "txn-newer",
                kind: "ADDITIONAL",
                stripePaymentIntentId: "pi_later_edit",
                amountCents: 4500,
                refundedAmountCents: 0,
                status: PaymentStatus.PENDING,
                createdAt: new Date("2026-06-02T00:00:00.000Z"),
              },
            ],
          }),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * A failure to queue must not re-open the recovery row. The replay has
       * already written this edit's ADDITIONAL transaction, and the processor's
       * own "a LATER edit superseded this one" check would read that very row as
       * a supersession on the next pass - so a retry would complete having done
       * nothing, turning a missing invoice into a missing invoice plus a spurious
       * FAILED row. The intent, which is this operation's actual job, succeeded.
       */
      it("still closes the operation when the invoice could not be queued", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockCompleteDeferredSupplementaryInvoice.mockRejectedValueOnce(
          new Error("outbox unavailable"),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { paymentIntentId: "pi_recovered" },
          }),
        );
      });

      it("raises nothing when the modification anchor no longer exists", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockBookingModificationFindUnique.mockResolvedValue(null);

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result.succeeded).toBe(1);
        expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
      });

      /**
       * #3181 fix round: THE MODIFICATION READ HAPPENS WHERE A THROW IS STILL A
       * RETRY, and this test is about WHERE, not about whether.
       *
       * Reading the edit's signed components is a plain database query, and a
       * plain database query can fail transiently. Below the
       * `upsertPaymentIntentTransaction` that throw is unrecoverable in the exact
       * way this file's docblock spells out: the ADDITIONAL row now exists, so on
       * the next pass the "a LATER edit superseded this one" check finds the row
       * THIS replay wrote, reads it as a supersession, and completes the
       * operation having done nothing at all. A $50 guest add collected with no
       * invoice behind it, and a recovery row reading SUCCEEDED.
       *
       * So the read is hoisted above the mint, and the two assertions below are
       * what pin it there: the operation is left retryable, and NOTHING has been
       * written that a retry would trip over. Move the read back down and the
       * second assertion fails, because the transaction is written before the
       * read that throws.
       */
      it("retries without writing anything when the modification read fails", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        mockBookingModificationFindUnique.mockRejectedValueOnce(
          new Error("database connection reset"),
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result).toMatchObject({ succeeded: 0, retried: 1, failed: 0 });
        // Nothing a second pass could mistake for a later edit's collectable.
        expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
        // And no provider round trip paid for on the way to the failure.
        expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
      });

      /**
       * #3181 fix round: A MODULE THAT FAILS TO LOAD IS A FAILURE TO QUEUE, not
       * an escape hatch out of this worker.
       *
       * The settlement module is reached through `await import`, and that line
       * used to sit OUTSIDE the `try` whose `catch` turns a failed enqueue into a
       * recorded one. An import throws like anything else - a chunk that will not
       * resolve, a module whose own top level fails - and the throw escaped into
       * `failPaymentRecoveryOperation`, buying the retry the docblock explains
       * cannot work. The operation must close on its actual job (the intent, which
       * was minted) with the invoice recorded as unraised.
       */
      it("still closes the operation when the settlement module cannot be loaded", async () => {
        primeQueue(additionalIntentOperation());
        mockPaymentFindUnique.mockResolvedValue(paymentWithIssuedInvoice());
        settlementModuleLoadFailure.current = new Error(
          "Cannot find module '@/lib/xero-booking-edit-settlement'",
        );

        const result = await processPaymentRecoveryOperations({ limit: 1 });

        expect(result).toMatchObject({ succeeded: 1, retried: 0, failed: 0 });
        expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledTimes(1);
        expect(mockPaymentRecoveryUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { paymentIntentId: "pi_recovered" },
          }),
        );
      });
    });

    it("enqueues exactly one recovery row per booking modification", async () => {
      const { enqueueAdditionalPaymentIntentRecovery } = await import(
        "@/lib/payment-recovery"
      );

      await enqueueAdditionalPaymentIntentRecovery({
        bookingId: "booking-1",
        paymentId: "payment-1",
        // #3170: the key is passed rather than derived, so the review-completion
        // charge can scope its own to the TASK. The ordinary edit path still
        // builds the modification-scoped key and this asserts the same string.
        idempotencyKey: "payment_recovery_additional_intent_mod-9",
        amountCents: 3000,
        stripeIdempotencyKey: "mod_guest_bk1_mod-9",
        hadIssuedXeroInvoice: true,
      });

      // #3181: the edit's answer is frozen on CREATE and deliberately absent
      // from UPDATE - a colliding second caller for one debt must not rewrite a
      // fact the cron may already be acting on, so first-writer-wins keeps the
      // earliest edit-time answer.
      {
        const upsert = mockPaymentRecoveryUpsert.mock.calls[0][0] as {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        };
        expect(upsert.create).toMatchObject({ hadIssuedXeroInvoice: true });
        expect(upsert.update).not.toHaveProperty("hadIssuedXeroInvoice");
      }

      expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            idempotencyKey: "payment_recovery_additional_intent_mod-9",
          },
          create: expect.objectContaining({
            type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
            status: PaymentRecoveryOperationStatus.PENDING,
            bookingId: "booking-1",
            paymentId: "payment-1",
            paymentIntentId: "mod_guest_bk1_mod-9",
            amountCents: 3000,
          }),
        }),
      );
    });

    it("never rewrites an existing debt's amount on a colliding upsert (#3170)", async () => {
      /*
        The update clause used to carry `amountCents`, so a second caller landing
        on the same key silently rewrote a debt the recovery cron might already be
        part way through. That is the hazard
        `buildEditFinancialReviewRefundRecoveryIdempotencyKey` was task-scoped to
        avoid on the REFUND side, and it sat unremarked on the charge side - where
        one edit raising two review tasks over one BookingModification row would
        have collided by construction.

        Under a correct key a repeat carries the same amount, so dropping it from
        the update changes nothing that is right and makes the wrong thing
        unrepresentable.
      */
      const { enqueueAdditionalPaymentIntentRecovery } = await import(
        "@/lib/payment-recovery"
      );

      await enqueueAdditionalPaymentIntentRecovery({
        bookingId: "booking-1",
        paymentId: "payment-1",
        idempotencyKey: "edit_financial_review_additional_intent_recovery_task-1",
        amountCents: 3000,
        stripeIdempotencyKey: "edit_financial_review_additional_task-1",
        hadIssuedXeroInvoice: true,
      });

      const call = mockPaymentRecoveryUpsert.mock.calls[0][0] as {
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      };
      expect(call.update).not.toHaveProperty("amountCents");
      // A CONTROL: the update clause still exists and still refreshes what a
      // repeat cannot change, so the assertion above is about the amount rather
      // than about the clause having been emptied.
      expect(call.update).toMatchObject({
        bookingId: "booking-1",
        paymentId: "payment-1",
      });
      // And the amount is still written when the row is CREATED - the debt has
      // to start life with a figure.
      expect(call.create).toMatchObject({ amountCents: 3000 });
    });
  });

  describe("#1992 duplicate-capture refund recovery replay (#2008)", () => {
    function makeDuplicateCaptureOp() {
      return makeOperation({
        id: "recovery-dup",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        bookingId: "booking-1",
        paymentId: "payment-1",
        // The op's paymentIntentId is the FIRST captured intent, not necessarily
        // the duplicate; the duplicate is the suffix of the idempotency key.
        paymentIntentId: "pi_settled",
        idempotencyKey: "duplicate_capture_booking-1_pi_dup",
        stripeKeyPrefix: "duplicate_capture_refund_booking-1_pi_dup",
        amountCents: 5000,
        allocationPlan: [{ paymentTransactionId: "txn-dup", amountCents: 5000 }],
      });
    }

    it("records the admin-only history event EXACTLY ONCE on a successful cron replay, keyed off the terminal SUCCEEDED transition", async () => {
      const dupOp = makeDuplicateCaptureOp();
      setPlannedChargeFixtures([{ paymentTransactionId: "txn-dup", amountCents: 5000 }], "pi_dup");
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { where?: { attempts?: { gte?: number } } }) => {
          if (isStaleWorkerSweep(args)) {
            return Promise.resolve([]);
          }
          return Promise.resolve([dupOp]);
        },
      );
      mockPaymentRecoveryFindUnique.mockResolvedValue(dupOp);

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      // Replays the frozen slice under the shared duplicate_capture_refund prefix.
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKeyPrefix: "duplicate_capture_refund_booking-1_pi_dup",
          allocation: [
            { paymentTransactionId: "txn-dup", amountCents: 5000 },
          ],
        }),
      );
      // The event lands exactly once, with the duplicate intent parsed from the
      // key and a null settling intent (not persisted on the operation).
      expect(mockRecordDuplicateCaptureRefundEvent).toHaveBeenCalledTimes(1);
      expect(mockRecordDuplicateCaptureRefundEvent).toHaveBeenCalledWith({
        bookingId: "booking-1",
        amountCents: 5000,
        duplicatePaymentIntentId: "pi_dup",
        settledPaymentIntentId: null,
      });
    });

    it("does NOT record the event when the terminal transition finds the operation already SUCCEEDED (count 0)", async () => {
      const dupOp = makeDuplicateCaptureOp();
      setPlannedChargeFixtures([{ paymentTransactionId: "txn-dup", amountCents: 5000 }], "pi_dup");
      mockPaymentRecoveryFindMany.mockImplementation(
        (args?: { where?: { attempts?: { gte?: number } } }) => {
          if (isStaleWorkerSweep(args)) {
            return Promise.resolve([]);
          }
          return Promise.resolve([dupOp]);
        },
      );
      mockPaymentRecoveryFindUnique.mockResolvedValue(dupOp);
      // The claim updateMany (status IN [PENDING,FAILED]) still flips, but the
      // duplicate-capture terminal transition (fenced on the held claim, #4675)
      // finds the row already SUCCEEDED — the inline path won the race and recorded it.
      mockPaymentRecoveryUpdateMany.mockImplementation(
        (args: { where?: { id?: string }; data?: { status?: unknown } }) => {
          if (args.data?.status === PaymentRecoveryOperationStatus.SUCCEEDED) {
            return Promise.resolve({ count: 0 });
          }
          return Promise.resolve({ count: args.where?.id ? 1 : 0 });
        },
      );

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockRecordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
      // #4125: losing to the inline close is expected here, so it is no warning.
      const lostClose = ([, message]: unknown[]) => typeof message === "string" && message.includes("completion matched no live claim");
      expect(vi.mocked(logger.warn).mock.calls.filter(lostClose)).toHaveLength(0);
      expect(vi.mocked(logger.debug).mock.calls.filter(lostClose)).toHaveLength(1);
    });
  });

  // #4125: the capacity race's refund made by the runner is recorded - a
  // REFUNDED event, so the member's history stops reading "on its way" -
  // exactly once, by the close that moved the row to SUCCEEDED, for what the
  // frozen plan refunded.
  describe("capacity-race refund recovery replay records the refund (#4125)", () => {
    function makeCapacityOp() {
      return makeOperation({
        id: "recovery-capacity",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        amountCents: 10000,
        idempotencyKey: "capacity_claim_failed_refund_recovery_booking-1_pi_original",
        stripeKeyPrefix: "capacity_claim_failed_booking-1_pi_original",
        // The ledger showed 9,000 refundable at the claim, so that is what was refunded.
        allocationPlan: [
          { paymentTransactionId: "txn-1", amountCents: 6000 },
          { paymentTransactionId: "txn-2", amountCents: 3000 },
        ],
        paymentTransactionId: null,
        paymentIntentId: "pi_original",
      });
    }
    function queue(op: ReturnType<typeof makeCapacityOp>) {
      setPlannedChargeFixtures(op.allocationPlan);
      mockPaymentRecoveryFindMany.mockImplementation((args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [op]),
      );
      mockPaymentRecoveryFindUnique.mockResolvedValue(op);
    }

    it("records REFUNDED once, for the plan's total, on the close that succeeds the row", async () => {
      queue(makeCapacityOp());

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockBookingEventCreate).toHaveBeenCalledTimes(1);
      expect(mockBookingEventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ bookingId: "booking-1", type: "REFUNDED", amountCents: 9000, actorMemberId: null, reason: "Automatic refund after lodge capacity was no longer available." }),
      });
      expect(mockRecordDuplicateCaptureRefundEvent).not.toHaveBeenCalled();
    });

    it("records nothing when the row was already closed - the inline close recorded it (count 0)", async () => {
      queue(makeCapacityOp());
      // #4675: the close (data SUCCEEDED, fenced on the held claim) loses; the claim still flips.
      mockPaymentRecoveryUpdateMany.mockImplementation((args: { where?: { id?: string }; data?: { status?: unknown } }) => {
        if (args.data?.status === PaymentRecoveryOperationStatus.SUCCEEDED) return Promise.resolve({ count: 0 });
        return Promise.resolve({ count: args.where?.id ? 1 : 0 });
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockBookingEventCreate).not.toHaveBeenCalled();
    });

    // #4125: the close and the event commit together - an event that cannot be
    // written fails the attempt, so the row is not left closed without it.
    it("an event insert that fails fails the attempt, so the row is retried rather than closed unrecorded", async () => {
      queue(makeCapacityOp());
      mockBookingEventCreate.mockRejectedValueOnce(new Error("insert failed"));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(0);
      expect(mockBookingEventCreate).toHaveBeenCalledTimes(1);
    });

    it("records nothing when the replay's refund throws - the row is not closed", async () => {
      queue(makeCapacityOp());
      mockRefundPaymentTransactions.mockRejectedValueOnce(new Error("Stripe is unavailable (503)"));

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockBookingEventCreate).not.toHaveBeenCalled();
    });
  });

  // #4145: a member cancel's card refund the runner makes is recorded the same
  // way - one REFUNDED event, dated by the close that moved the row, for what
  // the frozen plan refunded, with the cancel's own reason.
  describe("member-cancel refund recovery replay records the refund (#4145)", () => {
    function makeCancelOp(overrides: Record<string, unknown> = {}) {
      return makeOperation({
        id: "recovery-cancel",
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        amountCents: 3000,
        idempotencyKey: "booking_cancel_refund_recovery_booking-1",
        allocationPlan: [
          { paymentTransactionId: "txn-1", amountCents: 2000 },
          { paymentTransactionId: "txn-2", amountCents: 1000 },
        ],
        paymentTransactionId: null,
        ...overrides,
      });
    }
    function queue(op: ReturnType<typeof makeCancelOp>) {
      setPlannedChargeFixtures(op.allocationPlan);
      mockPaymentRecoveryFindMany.mockImplementation((args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [op]),
      );
      mockPaymentRecoveryFindUnique.mockResolvedValue(op);
    }
    const cancelledSnapshot = (extra: Record<string, unknown> = {}) => ({
      type: "CANCELLED",
      reason: null,
      snapshot: { refundMethod: "card", refundPercentage: 50, paidAmountCents: 6000, settledAmountCents: 3000, retainedAmountCents: 3000, ...extra },
    });

    it("records REFUNDED once, for the plan's total, with the cancel's reason and no actor", async () => {
      queue(makeCancelOp());
      mockBookingEventFindMany.mockResolvedValueOnce([cancelledSnapshot()]);

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockBookingEventFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { bookingId: "booking-1", type: { in: ["CANCELLED", "REFUNDED"] } } }));
      expect(mockBookingEventCreate).toHaveBeenCalledTimes(1);
      expect(mockBookingEventCreate).toHaveBeenCalledWith({
        data: { bookingId: "booking-1", type: "REFUNDED", amountCents: 3000, actorMemberId: null, reason: "50% refunded to the original payment method.", snapshot: Prisma.JsonNull },
      });
    });

    it("says the card's part on a card refund shortfall, as the inline cancel would", async () => {
      queue(makeCancelOp());
      mockBookingEventFindMany.mockResolvedValueOnce([cancelledSnapshot({ settledAmountCents: 5000, cardShortfall: { cardCents: 3000, bankCents: 2000, checkCents: 0 } })]);

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockBookingEventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ amountCents: 3000, reason: "$30.00 of the 50% refund ($50.00) refunded to the original payment method." }),
      });
    });

    it("names the amount when the cancel left no card snapshot, skipping a marker CANCELLED event", async () => {
      queue(makeCancelOp());
      mockBookingEventFindMany.mockResolvedValueOnce([
        { type: "CANCELLED", reason: null, snapshot: { kind: "manual_settlement_reversal" } },
        { type: "CANCELLED", reason: null, snapshot: null },
      ]);

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockBookingEventCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ amountCents: 3000, reason: "$30.00 refunded to the original payment method." }),
      });
    });

    it("counts a slice the inline attempt made (a partial) in the amount, without sending it again", async () => {
      queue(makeCancelOp({ allocationPlan: [
        { paymentTransactionId: "txn-1", amountCents: 2000, madeRefundId: "re_inline" },
        { paymentTransactionId: "txn-2", amountCents: 1000 },
      ] }));
      mockBookingEventFindMany.mockResolvedValueOnce([cancelledSnapshot()]);

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1000, allocation: [{ paymentTransactionId: "txn-2", amountCents: 1000 }] }));
      expect(mockBookingEventCreate).toHaveBeenCalledTimes(1);
      expect(mockBookingEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: 3000 }) });
    });

    it("records nothing when the row was already closed - the inline close recorded it (count 0), and that is no warning", async () => {
      queue(makeCancelOp());
      // #4675: the close (data SUCCEEDED, fenced on the held claim) loses; the claim still flips.
      mockPaymentRecoveryUpdateMany.mockImplementation((args: { where?: { id?: string }; data?: { status?: unknown } }) => {
        if (args.data?.status === PaymentRecoveryOperationStatus.SUCCEEDED) return Promise.resolve({ count: 0 });
        return Promise.resolve({ count: args.where?.id ? 1 : 0 });
      });

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockBookingEventCreate).not.toHaveBeenCalled();
      const lostClose = ([, message]: unknown[]) => typeof message === "string" && message.includes("completion matched no live claim");
      expect(vi.mocked(logger.warn).mock.calls.filter(lostClose)).toHaveLength(0);
    });

    // #4145 review: a cancel made before #4145 wrote its event up front; the
    // runner closes its row after the deploy and records no second one.
    it("closes the row but records nothing when the cancel already has its card refund event (the deploy boundary)", async () => {
      queue(makeCancelOp());
      mockBookingEventFindMany.mockResolvedValueOnce([
        { type: "REFUNDED", reason: "50% refunded to the original payment method.", snapshot: null },
        cancelledSnapshot(),
      ]);

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(1);
      expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }));
      expect(mockBookingEventCreate).not.toHaveBeenCalled();
    });

    it("an event insert that fails fails the attempt, so the row is retried rather than closed unrecorded", async () => {
      queue(makeCancelOp());
      mockBookingEventCreate.mockRejectedValueOnce(new Error("insert failed"));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(result.succeeded).toBe(0);
      expect(mockBookingEventCreate).toHaveBeenCalledTimes(1);
    });

    it("records nothing when the replay's refund throws - the row is not closed", async () => {
      queue(makeCancelOp());
      mockRefundPaymentTransactions.mockRejectedValueOnce(new Error("Stripe is unavailable (503)"));

      await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockBookingEventCreate).not.toHaveBeenCalled();
    });
  });
});

/**
 * #2262 H1/H2 — the manual mark-paid reversal DELETES the settle's hygiene
 * operations, and every write that could act on a stale in-memory copy of one
 * is status-fenced so a deleted operation is inert everywhere:
 *  - the webhook-side handoff finder simply finds nothing (the capture settles
 *    the booking normally);
 *  - the succeeded-intent handoff re-claims before flipping money state and
 *    ABANDONS when the claim matches nothing;
 *  - the terminal completion is a fenced updateMany that cannot P2025-throw or
 *    resurrect a deleted row;
 *  - a re-mark re-arms cancel hygiene through the enqueue upsert's CREATE arm.
 */
describe("#2262 — deleted-operation coherence (H1/H2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockPaymentRecoveryUpsert.mockResolvedValue({});
    mockPaymentTransactionUpdate.mockResolvedValue({});
    mockReconcilePaymentAggregates.mockResolvedValue(undefined);
  });

  it("H1 — after the reversal's delete, a post-reversal capture is NOT handed to the superseded-refund machinery (webhook side settles normally)", async () => {
    // The reversal deleted the CANCEL_PAYMENT_INTENT row, so the liveness
    // finder (status != SUCCEEDED) finds nothing and the webhook handler falls
    // through to the ordinary settlement path.
    mockPaymentRecoveryFindFirst.mockResolvedValue(null);
    mockSupersededMachineryOwnsCapture.mockResolvedValue(false);

    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: "pi_stale_pay_tab", amount: 10000, payment_method: "pm_1" }),
    ).resolves.toBe(false);

    // No transaction flip, no refund enqueued — the capture is the caller's to
    // settle as ordinary money.
    expect(mockPaymentTransactionUpdate).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
  });

  it("H2 — the succeeded-intent handoff re-claims before moving money and ABANDONS when the reversal deleted the operation mid-PROCESSING", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindFirst.mockResolvedValue(op);
    // The handoff's own claim (data -> PROCESSING) matches nothing: the row
    // was deleted between the worker's Stripe call and this write.
    mockPaymentRecoveryUpdateMany.mockImplementation(
      (args: { data?: { status?: unknown }; where?: { id?: string } }) => {
        if (args.data?.status === PaymentRecoveryOperationStatus.PROCESSING) {
          return Promise.resolve({ count: 0 });
        }
        return Promise.resolve({ count: args.where?.id ? 1 : 0 });
      },
    );

    // #4300 (F4): an abandoned hand-off moved nothing, so the rows are asked
    // again rather than answered `true` - the row is gone, nothing owns it.
    mockSupersededMachineryOwnsCapture.mockResolvedValue(false);
    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: "pi_superseded", amount: 6000, payment_method: "pm_1" }),
    ).resolves.toBe(false);

    // Abandoned loudly: no SUCCEEDED flip on the transaction, no fresh
    // REFUND_SUPERSEDED_PAYMENT the reversal's disarm never covered.
    expect(mockPaymentTransactionUpdate).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
  });

  // #4320 (`INV-LOCK-002`): the re-claim, the SUCCEEDED flip and the rebuild run
  // under the Payment row, taken first, so a manual mark-paid reversal (which
  // holds that row from its "no settled card money" check to its commit) can
  // never see the transaction unsettled and then have it flipped under it.
  it("MUTATION (#4320): the hand-off locks the Payment row before it re-claims, then flips and rebuilds on that transaction", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindFirst.mockResolvedValue(op);

    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: "pi_superseded", amount: 6000, payment_method: "pm_1" }),
    ).resolves.toBe(true);

    expect(mockLockPaymentForRefundedTotal).toHaveBeenCalledWith(expect.anything(), op.paymentId);
    const lockedAt = mockLockPaymentForRefundedTotal.mock.invocationCallOrder[0]!;
    const claimAt = mockPaymentRecoveryUpdateMany.mock.calls.findIndex(
      ([args]) => (args as { data?: { status?: unknown } }).data?.status === PaymentRecoveryOperationStatus.PROCESSING,
    );
    expect(lockedAt).toBeLessThan(mockPaymentRecoveryUpdateMany.mock.invocationCallOrder[claimAt]!);
    expect(mockPaymentRecoveryUpdateMany.mock.invocationCallOrder[claimAt]!).toBeLessThan(mockPaymentTransactionUpdate.mock.invocationCallOrder[0]!);
    expect(mockPaymentTransactionUpdate.mock.invocationCallOrder[0]!).toBeLessThan(mockReconcilePaymentAggregates.mock.invocationCallOrder[0]!);
    expect(mockReconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: op.paymentId, store: expect.anything() });
  });

  // #4083 review: the webhook takes a row from outside any worker's attempt, so
  // its claim counts an attempt - the worker it took the row from cannot then
  // write FAILED over it (the failure write is fenced on the attempt).
  it("#4083 — the webhook's hand-off claim counts an attempt; a worker's own hand-off does not", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PROCESSING });
    mockPaymentRecoveryFindFirst.mockResolvedValue(op);
    const handOffClaims = () =>
      mockPaymentRecoveryUpdateMany.mock.calls
        .map(([args]) => args as { data: Record<string, unknown> })
        .filter((args) => args.data.status === PaymentRecoveryOperationStatus.PROCESSING && "processingStartedAt" in args.data && !("lastError" in args.data));

    await queueSupersededPaymentIntentRefundRecovery({ id: "pi_superseded", amount: 6000, payment_method: "pm_1" });
    expect(handOffClaims()).toEqual([expect.objectContaining({ data: expect.objectContaining({ attempts: { increment: 1 } }) })]);

    vi.clearAllMocks();
    mockPaymentRecoveryUpdateMany.mockImplementation(({ where }: { where?: { id?: string } }) => Promise.resolve({ count: where?.id ? 1 : 0 }));
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) => Promise.resolve(isStaleWorkerSweep(args) ? [] : [makeOperation({ status: "PENDING" })]));
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation());
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: { id: "pi_superseded", status: "succeeded", amount: 6000, payment_method: "pm_123" },
    });
    await processPaymentRecoveryOperations({ limit: 1 });
    const workerHandOff = mockPaymentRecoveryUpdateMany.mock.calls
      .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
      .find((args) => args.data.status === PaymentRecoveryOperationStatus.PROCESSING && !("attempts" in args.where));
    expect(workerHandOff).toBeDefined();
    expect(workerHandOff?.data).not.toHaveProperty("attempts");
  });

  /**
   * #4675: a hand-off holds the claim its own write took - read back under that
   * write's row lock - and closes only while it still holds it. The webhook's
   * close of a cancel Stripe reports cancelled holds no claim, and is fenced off
   * SUCCEEDED alone.
   */
  it("#4675 — a hand-off's close is fenced on the claim its own write took, read back under the row lock", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING, attempts: 2 });
    mockPaymentRecoveryFindFirst.mockResolvedValue(op);
    const handedAt = new Date("2026-07-01T00:00:00.000Z");
    mockPaymentRecoveryFindUnique.mockResolvedValue({ id: op.id, attempts: 3, processingStartedAt: handedAt });

    await expect(queueSupersededPaymentIntentRefundRecovery({ id: "pi_superseded", amount: 6000, payment_method: "pm_1" })).resolves.toBe(true);

    expect(mockPaymentRecoveryFindUnique).toHaveBeenCalledWith({ where: { id: op.id }, select: { id: true, attempts: true, processingStartedAt: true } });
    const closes = mockPaymentRecoveryUpdateMany.mock.calls
      .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
      .filter((args) => args.data.status === PaymentRecoveryOperationStatus.SUCCEEDED);
    expect(closes.map((close) => close.where)).toEqual([heldClaimWhere(op.id, 3, handedAt)]);
  });

  it("#4675 — the webhook's close of a cancelled superseded intent holds no claim: fenced off SUCCEEDED only", async () => {
    mockPaymentRecoveryFindFirst.mockResolvedValueOnce(makeOperation({ status: PaymentRecoveryOperationStatus.FAILED }));

    await expect(completeCanceledSupersededPaymentIntentRecovery({ paymentIntentId: "pi_superseded" })).resolves.toBe(true);

    const closes = mockPaymentRecoveryUpdateMany.mock.calls
      .map(([args]) => args as { where: Record<string, unknown>; data: Record<string, unknown> })
      .filter((args) => args.data.status === PaymentRecoveryOperationStatus.SUCCEEDED);
    expect(closes.map((close) => close.where)).toEqual([{ id: "recovery-1", status: { not: PaymentRecoveryOperationStatus.SUCCEEDED } }]);
  });

  it("#3639 — a hand-off the club holds for a treasurer moves no money: no superseded refund, the cancel op completes", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindFirst.mockResolvedValue(op);
    mockHoldSupersededLateCapture.mockResolvedValueOnce(true);

    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: op.paymentIntentId, amount: 6000, payment_method: "pm_1" }),
    ).resolves.toBe(true);

    expect(mockHoldSupersededLateCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: op.bookingId,
        paymentIntentId: op.paymentIntentId,
        paymentTransactionId: op.paymentTransactionId,
        amountCents: 6000,
      }),
    );
    // Stripe holds the money, so the row says captured; nothing is refunded.
    expect(mockPaymentTransactionUpdate).toHaveBeenCalled();
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: op.id }),
        data: expect.objectContaining({ status: PaymentRecoveryOperationStatus.SUCCEEDED }),
      }),
    );
  });

  it("#3639 — a hand-off the club does NOT hold still queues the superseded refund, as before", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindFirst.mockResolvedValue(op);
    mockHoldSupersededLateCapture.mockResolvedValueOnce(false);

    await queueSupersededPaymentIntentRefundRecovery({ id: op.paymentIntentId, amount: 6000, payment_method: "pm_1" });

    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        }),
      }),
    );
  });

  it("#3639 — the recovery cron's hand-off asks the same question when Stripe reports the intent succeeded", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) =>
        Promise.resolve(isStaleWorkerSweep(args) ? [] : [op]),
    );
    mockPaymentRecoveryFindUnique.mockResolvedValue(op);
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: { id: op.paymentIntentId, status: "succeeded", amount: 6000, payment_method: "pm_1" },
    });
    mockHoldSupersededLateCapture.mockResolvedValueOnce(true);

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockHoldSupersededLateCapture).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: op.paymentIntentId, amountCents: 6000 }),
    );
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
        }),
      }),
    );
  });

  it("H2 — the fenced completion cannot resurrect a deleted operation (count 0 is handled, never a P2025 throw)", async () => {
    const op = makeOperation({ status: PaymentRecoveryOperationStatus.PENDING });
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([op]);
      },
    );
    mockPaymentRecoveryFindUnique.mockResolvedValue(makeOperation());
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { id: "pi_superseded", status: "canceled", amount: 6000 },
    });
    // Every fenced write (including the terminal completion) matches nothing —
    // the reversal deleted the row under the worker.
    mockPaymentRecoveryUpdateMany.mockImplementation(
      (args: {
        where?: { id?: string; status?: unknown; nextRetryAt?: unknown };
      }) =>
        // Only the initial cron claim (which carries nextRetryAt) still wins.
        Promise.resolve({ count: args.where?.nextRetryAt ? 1 : 0 }),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // No throw, no update-by-id resurrection: the worker records success for
    // its own run and the deleted row stays deleted.
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(mockPaymentRecoveryUpdate).not.toHaveBeenCalled();
  });

  it("M2 — enqueuePaymentIntentCancellationRecovery's CREATE arm re-arms a deleted operation fresh (PENDING, immediate retry)", async () => {
    await enqueuePaymentIntentCancellationRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      paymentTransactionId: "txn-1",
      paymentIntentId: "pi_live",
      amountCents: 10000,
    });

    // The reversal DELETED the old row, so the upsert cannot land in its
    // update arm: the create arm mints a fresh PENDING op with nextRetryAt now
    // — mark -> reverse -> re-mark keeps its durable cancel hygiene.
    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "payment_recovery_cancel_txn-1_pi_live" },
      create: expect.objectContaining({
        type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
        status: PaymentRecoveryOperationStatus.PENDING,
        nextRetryAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        paymentIntentId: "pi_live",
      }),
    });
  });
});

describe("#2262 L3 — the recovery dispatcher is exhaustive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
  });

  it("FAILS an operation of an unhandled type loudly instead of executing it as a superseded-payment refund", async () => {
    const rogue = makeOperation({
      id: "recovery-rogue",
      type: "SOME_FUTURE_TYPE" as PaymentRecoveryOperationType,
      status: PaymentRecoveryOperationStatus.PENDING,
    });
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([rogue]);
      },
    );
    mockPaymentRecoveryFindUnique.mockResolvedValue(rogue);

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.retried).toBe(1);
    // Never dispatched to the superseded-refund executor: no transaction read,
    // no Stripe refund.
    expect(mockPaymentTransactionFindUnique).not.toHaveBeenCalled();
    expect(mockProcessRefund).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-rogue",
        // #3220: fenced rather than an `update` by id, so a row a manual
        // mark-paid reversal deleted mid-flight matches nothing instead of
        // throwing out of the loop's own catch.
        status: {
          in: [
            PaymentRecoveryOperationStatus.PENDING,
            PaymentRecoveryOperationStatus.PROCESSING,
            PaymentRecoveryOperationStatus.FAILED,
          ],
        },
        // #4083: only the attempt the worker holds.
        attempts: 1,
        processingStartedAt: { not: null },
      },
      data: expect.objectContaining({
        status: PaymentRecoveryOperationStatus.FAILED,
        lastError: expect.stringContaining(
          "Unhandled payment recovery operation type",
        ),
      }),
    });
  });
});

/**
 * #3170 (epic #2797): the recovery half of ONE EDIT, ONE REQUEST.
 *
 * The worker used to derive a `BookingModification` id by slicing the ORDINARY
 * edit key's prefix off whatever key the operation carried. That is correct for
 * the ordinary key and silently wrong for every other shape - a review-charge key
 * sliced to `"tent_recovery_<taskId>"`, and the Xero attach then looked for
 * waiting operations under an id that cannot exist. The builder had been moved
 * into `payment-recovery-keys.ts` and made a required argument; the parser was
 * left behind, which is the half-move `INV-SSOT` exists to stop.
 */
describe("additional-intent recovery keys read back to their edit (#3170)", () => {
  it("round-trips BOTH shapes of the key, and refuses anything else", () => {
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        buildAdditionalIntentRecoveryIdempotencyKey("mod-9"),
      ),
    ).toBe("mod-9");
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-9"),
      ),
    ).toBe("mod-9");
    // A CONTROL on the claim above: the two keys are genuinely different
    // strings, so a parser that understood only one of them would have to fail
    // here rather than agree by coincidence.
    expect(buildAdditionalIntentRecoveryIdempotencyKey("mod-9")).not.toBe(
      buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-9"),
    );
    // FAIL-CLOSED: an unrecognised key yields null and the caller does nothing,
    // rather than a slice of a string that is not an id.
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        "payment_recovery_cancel_txn-1_pi_x",
      ),
    ).toBeNull();
    expect(
      bookingModificationIdForAdditionalIntentRecoveryKey(
        "payment_recovery_additional_intent_",
      ),
    ).toBeNull();
    expect(bookingModificationIdForAdditionalIntentRecoveryKey(null)).toBeNull();
  });
});

describe("edit-financial-review charge recovery (#3170)", () => {
  function chargeOperation(overrides: Record<string, unknown> = {}) {
    return makeOperation({
      id: "recovery-review-charge",
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      amountCents: 20000,
      paymentIntentId:
        buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
      idempotencyKey:
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-1"),
      paymentTransactionId: null,
      // #3181: frozen by the settlement that raised this charge.
      hadIssuedXeroInvoice: true,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const operation = chargeOperation();
    mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...operation, status: "PENDING" }]);
      },
    );
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockBookingFindUnique.mockResolvedValue({
      status: "PAID",
      member: {
        id: "m1",
        email: "alice@test.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      payment: {
        stripeCustomerId: "cus_123",
        // #3181: the invoice's local paid/refunded state is classified from
        // this. Whether an invoice EXISTS is deliberately NOT read here - the
        // recovery row carries the edit's own answer.
        status: PaymentStatus.SUCCEEDED,
      },
    });
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "raised",
      paymentIntentId: "pi_additional_1",
      totalCents: 23000,
    });
  });

  /** Did this run mark the operation SUCCEEDED? */
  function wasClosedSuccessfully() {
    return mockPaymentRecoveryUpdateMany.mock.calls.some(
      (call) =>
        (call[0] as { data?: { status?: string } })?.data?.status ===
        "SUCCEEDED",
    );
  }

  /** Did this run leave the operation FAILED with a retry still to come? */
  function wasLeftForRetry() {
    return mockPaymentRecoveryUpdateMany.mock.calls.some((call) => {
      const args = call[0] as {
        where?: { id?: string };
        data?: Record<string, unknown>;
      };
      // Scoped to THIS operation (#3220). Every failure transition is one
      // fenced `updateMany` now, and the stale-worker reaper writes the same
      // shape - so a helper matching on the data alone would answer for a row
      // this test never asked about.
      if (args?.where?.id !== "recovery-review-charge") return false;
      const data = args?.data;
      return data?.status === "FAILED" && data?.nextRetryAt != null;
    });
  }

  it("re-derives the edit's combined total instead of replaying the frozen amount", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    // The replay asks the SHARES what is owed, so a row carrying a stale $200
    // cannot mint for the wrong figure. That is what makes ONE edit-scoped
    // recovery row safe where the first round needed one row per task.
    expect(mockSyncEditFinancialReviewChargeRequest).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      // #3181: the settlement's own answer, read back off this row rather than
      // re-derived - a second, disagreeing answer in the one place the frozen
      // one exists to prevent.
      hasIssuedXeroInvoice: true,
      paymentId: "payment-1",
      member: {
        id: "m1",
        email: "alice@test.com",
        name: "Alice Smith",
        stripeCustomerId: "cus_123",
      },
    });
    // It must NOT fall through to the ordinary path, whose "a newer additional
    // supersedes this one" check would see the request this very edit already
    // minted and complete having minted nothing - exactly how the first round's
    // second share was dropped.
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
    expect(mockPaymentTransactionFindMany).not.toHaveBeenCalled();
    // The waiting supplementary Xero op is pointed at the request, under the
    // anchor the shared parser read back - never a slice of the key - and
    // through the helper that alerts if that fails (#3641).
    expect(mockAttachRecoveredIntent).toHaveBeenCalledWith({
      bookingModificationId: "mod-1",
      paymentIntentId: "pi_additional_1",
      recoveryOperationId: "recovery-review-charge",
    });
    expect(mockAttachIntentToWaitingOps).toHaveBeenCalledWith({
      bookingModificationId: "mod-1",
      paymentIntentId: "pi_additional_1",
    });
  });

  /**
   * #3170 fix round (F1) - THE REPLAY MUST NOT CLOSE A DEBT IT DID NOT RAISE.
   *
   * The provider is still down when the cron replays. The mint arm swallows its
   * failure and re-enqueues - and the row it re-enqueues is THIS row, whose
   * upsert `update` branch deliberately does not reset `status`, so that
   * re-enqueue is a no-op on a PROCESSING row. Completing here marked the
   * operation SUCCEEDED having minted nothing: two shares of $200 and $30 both
   * read COMPLETED and the club collected neither.
   */
  it("leaves the operation open when the replay raised no request", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // NOT closed, and NOT counted as a success.
    expect(result.succeeded).toBe(0);
    expect(wasClosedSuccessfully()).toBe(false);
    // Handed to the machinery that already exists for this: back off, retry, and
    // on exhaustion mark it FAILED and raise the admin payment-failure alert. The
    // $230 stays owed, visible and recoverable.
    expect(result.retried).toBe(1);
    expect(wasLeftForRetry()).toBe(true);
    // Nothing was attached to a Xero operation either, because there is no intent
    // to attach.
    expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
  });

  /**
   * #3402: the same refusal to close, for the other way a replay can raise
   * nothing - another run (an officer's inline settlement, say) holds the edit's
   * raise claim, so this replay called no provider at all. Closing here would
   * trust a holder that may yet die mid-raise.
   */
  it("leaves the operation open when another run holds the edit's raise claim", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "deferred",
      paymentIntentId: null,
      totalCents: 23000,
      carriedCents: 0,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(0);
    expect(wasClosedSuccessfully()).toBe(false);
    expect(result.retried).toBe(1);
    expect(wasLeftForRetry()).toBe(true);
    expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
  });

  /**
   * #3402: the replay's close is fenced on the `nextRetryAt` it was claimed with.
   * A share deferred (or refused) onto this edit while the replay ran moves that
   * value on the PROCESSING row; the replay must then hand the row back to
   * PENDING instead of closing it over a share it never raised for.
   */
  it("hands the row back instead of closing it when a share was deferred onto it mid-replay", async () => {
    const { nextRetryAt: claimedRetryAt, processingStartedAt: claimedAttempt } = chargeOperation();
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where, data }: { where?: { id?: string; nextRetryAt?: Date }; data?: { status?: string } }) =>
        Promise.resolve({
          // The fenced close matches nothing: the row's retry time has moved.
          count: data?.status === "SUCCEEDED" && where?.nextRetryAt ? 0 : where?.id ? 1 : 0,
        }),
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    const calls = mockPaymentRecoveryUpdateMany.mock.calls.map(
      (call) => call[0] as { where?: Record<string, unknown>; data?: Record<string, unknown> },
    );
    const close = calls.find((call) => call.data?.status === "SUCCEEDED");
    expect(close?.where).toMatchObject({
      id: "recovery-review-charge",
      nextRetryAt: claimedRetryAt,
      processingStartedAt: claimedAttempt,
    });
    const handBack = calls.find((call) => call.data?.status === "PENDING");
    // Fenced on the exact attempt too, so it can only hand back THIS worker's claim.
    expect(handBack).toEqual({
      where: { id: "recovery-review-charge", status: "PROCESSING", processingStartedAt: claimedAttempt },
      data: { status: "PENDING", attempts: 0, processingStartedAt: null, lastError: null },
    });
  });

  /**
   * #3402: a worker that stalls past the stale-worker threshold is reaped and its
   * row re-claimed by worker B (a new `processingStartedAt`). The stalled
   * worker's late close and hand-back must both be no-ops on B's live claim -
   * otherwise a third worker could run the debt alongside B, and B's `attempts`
   * would reset past `MAX_PAYMENT_RECOVERY_ATTEMPTS`.
   */
  it("a stalled worker's late close and hand-back cannot touch the attempt that re-claimed the row", async () => {
    const { nextRetryAt: stalledRetryAt, processingStartedAt: stalledAttempt } = chargeOperation();
    // The row as worker B left it: reaped (nextRetryAt moved), re-claimed.
    const live = {
      status: "PROCESSING",
      nextRetryAt: new Date("2026-05-23T00:31:00.000Z"),
      processingStartedAt: new Date("2026-05-23T00:31:00.000Z"),
      attempts: 2,
    };
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where, data }: { where?: Record<string, unknown>; data?: Record<string, unknown> }) => {
        if (where?.id !== "recovery-review-charge") return Promise.resolve({ count: 0 });
        // The stalled worker's own claim, back when it began (it then read the
        // fixture row); everything after is the late close and hand-back.
        if (data?.status === "PROCESSING") return Promise.resolve({ count: 1 });
        // Evaluate the where against B's row, as PostgreSQL would.
        const matches = Object.entries(where).every(([field, expected]) => {
          if (field === "id") return true;
          const actual = live[field as keyof typeof live];
          if (expected && typeof expected === "object" && "not" in expected) {
            return actual !== (expected as { not: unknown }).not;
          }
          return actual instanceof Date && expected instanceof Date
            ? actual.getTime() === expected.getTime()
            : actual === expected;
        });
        if (matches) Object.assign(live, data);
        return Promise.resolve({ count: matches ? 1 : 0 });
      },
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    const writes = mockPaymentRecoveryUpdateMany.mock.calls
      .map((call) => call[0] as { where?: Record<string, unknown>; data?: Record<string, unknown> })
      .filter((call) => call.where?.id === "recovery-review-charge" && call.data?.status !== "PROCESSING");
    // Both writes were attempted with the stalled worker's own fence...
    const at = (value: unknown) => (value instanceof Date ? value.getTime() : value);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes.some((w) => at(w.where?.nextRetryAt) === stalledRetryAt.getTime())).toBe(true);
    expect(writes.every((w) => at(w.where?.processingStartedAt) === stalledAttempt.getTime())).toBe(true);
    // ...and neither moved B's row.
    expect(live).toEqual({
      status: "PROCESSING",
      nextRetryAt: new Date("2026-05-23T00:31:00.000Z"),
      processingStartedAt: new Date("2026-05-23T00:31:00.000Z"),
      attempts: 2,
    });
  });

  /**
   * The CONTROL for the guard above. A replay that DID raise the request must
   * still close - a check that refused everything would pass the test above and
   * would wedge every recovered charge in a retry loop.
   */
  it("closes the operation when the replay did raise the request", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(wasClosedSuccessfully()).toBe(true);
    expect(wasLeftForRetry()).toBe(false);
  });

  /**
   * The other two outcomes are terminal rather than recoverable, and closing on
   * them is the point: retrying would loop for ever on a question no retry can
   * answer.
   */
  it("closes the operation when there is nothing owed", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "nothing-owed",
      paymentIntentId: null,
      totalCents: 0,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(wasClosedSuccessfully()).toBe(true);
  });

  it("closes the operation when the member had already paid the request", async () => {
    // The remaining share is collected by hand; the charge module writes the
    // audit row that tells an officer so. Nothing a retry can improve.
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "already-paid",
      paymentIntentId: "pi_additional_1",
      totalCents: 20000,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(wasClosedSuccessfully()).toBe(true);
  });

  /**
   * #3181: the review charge re-enters the ordinary price-increase path, so it
   * deferred its supplementary invoice for the same reason and this replay has to
   * complete it for the same reason. The issue reported one defect and predicted
   * one fix would close both halves; the worker forks on the recovery key, so
   * both forks needed the completion.
   */
  it("raises the deferred supplementary invoice for the edit's combined total", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledTimes(1);
    expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        bookingModificationId: "mod-1",
        paymentIntentId: "pi_additional_1",
        // The COMBINED total the sync re-derived from the settled shares - one
        // edit, one ask - never the row's advisory $200.
        priceDiffCents: 23000,
        changeFeeCents: 0,
        hasIssuedXeroInvoice: true,
      }),
    );
  });

  /**
   * The enqueue's own verdict, recorded through the one function that decides
   * what counts as short. `short-sent` means this edit's invoice had already
   * gone out and could not be raised to the settled total, so the difference has
   * to be billed by hand and an officer has to be able to find that.
   */
  it("records a short ask when the invoice had already left the queue", async () => {
    mockCompleteDeferredSupplementaryInvoice.mockResolvedValueOnce("short-sent");

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockRecordShortEditReviewChargeInvoice).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      outcome: "short-sent",
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      /**
       * #3193: BOTH NULL, and that is a refusal rather than an omission.
       *
       * Since the owner's 31 Aug 2026 decision a sent-short ask raises a SECOND,
       * separate invoice for the difference - but only where the caller holds
       * the single settled share to bill, because billing anything else asks
       * the member for money they have already been asked for. This replay
       * holds no task: it re-derives the edit's COMBINED total across every
       * share and cannot say which part of it the sent invoice already carries,
       * so the only figure it could invoice is the whole $230 on top of the
       * $200 already with the member. Passing the total here would be the
       * double-bill the decision is explicitly bounded away from.
       */
      reviewTaskId: null,
      shareCents: null,
      memberId: "m1",
      totalCents: 23000,
    });
  });

  /**
   * #3181 fix round: THE REVIEW FORK LEAVES A DURABLE TRACE WHEN THE ENQUEUE
   * THROWS, because it is the one fork that cannot fall back on the repair pass.
   *
   * A parked edit's `BookingModification` carries only the readable strands'
   * money, so an edit whose only money-affecting strand was the parked one has
   * `priceDiffCents + changeFeeCents == 0` - and the booking-vs-Xero repair pass
   * gates its missing-supplementary finding on `netAmountCents > 0`, so it never
   * looks. Without this record an officer settles at $230, the member pays it,
   * and the club's only account of the charge is a `logger.error`. `INV-PAY`: a
   * log line is not a durable trace.
   */
  it("records the unraised invoice when the enqueue throws", async () => {
    mockCompleteDeferredSupplementaryInvoice.mockRejectedValueOnce(
      new Error("outbox unavailable"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // The intent - this operation's actual job - succeeded, so the row closes.
    expect(result.succeeded).toBe(1);
    expect(mockRecordShortEditReviewChargeInvoice).not.toHaveBeenCalled();
    expect(mockRecordUncollectedEditReviewChargeShare).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      leg: "xero-invoice",
      // Not `ask-closed`: no invoice exists to bill the earlier figure, so the
      // whole settled total is unbilled rather than under-billed.
      cause: "ask-not-raised",
      // #3193: no ask exists here for a second one to follow, so the second-ask
      // question does not arise at all. `null`, not `unavailable`, which is
      // specifically "an ask exists and its difference cannot be worked out".
      secondAsk: null,
      bookingId: "booking-1",
      bookingModificationId: "mod-1",
      memberId: "m1",
      derivedTotalCents: 23000,
      requestedTotalCents: null,
    });
  });

  /**
   * The same trace for the other way of raising nothing, UNDER A DIFFERENT CAUSE,
   * and the difference is the point (#3181 delta review).
   *
   * A row enqueued before the edit's answer was recorded is not guessed at, and
   * silence about a charge the member has been asked for is exactly what this
   * issue removed - but the two silences are not the same fact. `ask-not-raised`
   * tells an officer, in the audit body, that no invoice could be raised and to
   * raise one by hand. That is right when an invoice was owed and the queue
   * refused it. It is WRONG here: a NULL row is the club saying it cannot tell
   * whether an invoice was owed, and on a booking whose primary Xero invoice had
   * not been minted when the edit committed that invoice bills the charge itself
   * - so a hand-raised supplementary is a second ask for the same money.
   * `ask-owed-unknown` says that, and names the booking-vs-Xero repair pass as
   * the instrument that can actually answer it.
   */
  it("records the unraised invoice under an unknown-owing cause when the edit's answer was never recorded", async () => {
    const operation = chargeOperation({ hadIssuedXeroInvoice: null });
    mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
    mockPaymentRecoveryFindMany.mockImplementation(
      (args?: { where?: { attempts?: { gte?: number } } }) => {
        if (isStaleWorkerSweep(args)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{ ...operation, status: "PENDING" }]);
      },
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
    expect(mockRecordUncollectedEditReviewChargeShare).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "ask-owed-unknown",
        derivedTotalCents: 23000,
      }),
    );
  });

  /**
   * CONTROL for that split: the enqueue THROWING still files `ask-not-raised`.
   * An invoice was owed - the row froze `hadIssuedXeroInvoice: true` - and the
   * queue refused it, so raising one by hand is the right instruction and the
   * cause that carries it is the right cause. Without this control, collapsing
   * both outcomes onto `ask-owed-unknown` would pass the test above.
   */
  it("still records a throw under the invoice-was-owed cause", async () => {
    mockCompleteDeferredSupplementaryInvoice.mockRejectedValueOnce(
      new Error("outbox unavailable"),
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockRecordUncollectedEditReviewChargeShare).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "ask-not-raised" }),
    );
  });

  /**
   * #3181 fix round: AN ALREADY-PAID ASK GETS NO WAITING_PAYMENT ROW.
   *
   * `already-paid` is the sync saying this edit's request was captured before the
   * replay reached it - its webhook has fired and cannot fire again. An invoice
   * queued WAITING_PAYMENT against that intent is a row nothing will ever
   * release, cancelled by the 14-day reaper with no invoice raised at all. Worse,
   * while it sits there the repair pass reads the anchor as
   * `BLOCKED_BY_XERO_OPERATION` - warning, not auto-appliable, no action offered,
   * reported as waiting for a payment that has already happened - instead of the
   * critical, one-click `MISSING_SUPPLEMENTARY_INVOICE`. The share that could not
   * join the ask already has its record, written by the sync on the
   * `payment-request` leg, so nothing is lost by staying out of the way.
   */
  it("queues no invoice against an ask that was already paid", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "already-paid",
      paymentIntentId: "pi_additional_1",
      totalCents: 20000,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
    // Not an unraised-invoice record either: the sync has already written the
    // `payment-request` leg for this exact share, and two records for one fact
    // is how an officer learns to distrust both.
    expect(mockRecordUncollectedEditReviewChargeShare).not.toHaveBeenCalled();
  });

  /**
   * CONTROL for the two records above: on an ordinary run the covered verdict is
   * passed through, and the function that owns the mapping is what stays silent.
   * A caller re-deriving "is this short" is how the two legs came to disagree.
   */
  it("passes a covered verdict through to the same record function", async () => {
    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockRecordShortEditReviewChargeInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "covers-total" }),
    );
  });

  it("raises no invoice when the replay raised no request", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
    });

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockCompleteDeferredSupplementaryInvoice).not.toHaveBeenCalled();
  });

  it("mints nothing for a cancelled booking", async () => {
    // #1358, applied to the charge: the cancel flow retired this booking's
    // additional intents, so resurrecting one here would re-arm a collectable
    // that must never be captured.
    mockBookingFindUnique.mockResolvedValue({
      status: "CANCELLED",
      member: {
        id: "m1",
        email: "alice@test.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      payment: { stripeCustomerId: "cus_123" },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(mockSyncEditFinancialReviewChargeRequest).not.toHaveBeenCalled();
    expect(mockAttachIntentToWaitingOps).not.toHaveBeenCalled();
    // #4272: and the shares it leaves uncollected are recorded for an officer
    // and the row closed, by the cancelled path - not by a bare log line.
    expect(mockCloseCancelledEditReviewChargeReplay).toHaveBeenCalledTimes(1);
    expect(mockCloseCancelledEditReviewChargeReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "CANCELLED",
        bookingModificationId: "mod-1",
        memberId: "m1",
        operation: expect.objectContaining({ bookingId: "booking-1", paymentId: "payment-1" }),
      }),
    );
  });

  it("CONTROL: a live booking's replay takes the ordinary path (#4272)", async () => {
    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockSyncEditFinancialReviewChargeRequest).toHaveBeenCalledTimes(1);
    // Asked once, with the live status, and declined.
    expect(mockCloseCancelledEditReviewChargeReplay).toHaveBeenCalledTimes(1);
    expect(mockCloseCancelledEditReviewChargeReplay).toHaveBeenCalledWith(expect.objectContaining({ status: "PAID" }));
  });

  it("a cancellation landing mid-replay takes the cancelled path instead of burning an attempt (#4272)", async () => {
    // The sync found the booking cancelled at its mint and raised nothing; the
    // replay re-reads the status (no `status` passed) and closes via the record.
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
    });
    // Live when the replay began; cancelled by the time it re-reads.
    mockCloseCancelledEditReviewChargeReplay.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(1);
    expect(result.retried).toBe(0);
    expect(mockCloseCancelledEditReviewChargeReplay).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ status: expect.anything() }),
    );
    expect(mockCloseCancelledEditReviewChargeReplay).toHaveBeenCalledTimes(2);
  });

  it("CONTROL: a not-raised replay on a live booking still leaves the row open to retry (#4272)", async () => {
    mockSyncEditFinancialReviewChargeRequest.mockResolvedValue({
      outcome: "not-raised",
      paymentIntentId: null,
      totalCents: 23000,
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.succeeded).toBe(0);
    expect(result.retried).toBe(1);
    expect(mockCloseCancelledEditReviewChargeReplay).toHaveBeenCalledTimes(2);
  });

  /**
   * #3947: a booking paid wholly with account credit. Its payment is a $0
   * SUCCEEDED card row with no customer, which the sync now asks the card for
   * (`canAskCardForReviewCharge`, proved against the real sync in
   * `edit-financial-review-charge.test.ts`). Here the replay around it: given a
   * `raised` answer it must close the row and complete the deferred invoice
   * exactly as for a card-paid booking.
   */
  describe("#3947: a booking paid wholly with credit", () => {
    function creditPaidBooking(status: string) {
      return {
        status,
        member: {
          id: "m1",
          email: "alice@test.com",
          firstName: "Alice",
          lastName: "Smith",
        },
        // Credit paid it, so no card was ever taken and no customer exists.
        payment: { stripeCustomerId: null, status: PaymentStatus.SUCCEEDED },
      };
    }

    it("a PAID booking's replay re-enters the sync, closes on `raised`, and raises the deferred invoice", async () => {
      mockBookingFindUnique.mockResolvedValue(creditPaidBooking("PAID"));

      const result = await processPaymentRecoveryOperations({ limit: 1 });

      expect(mockSyncEditFinancialReviewChargeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking-1",
          bookingModificationId: "mod-1",
          paymentId: "payment-1",
          hasIssuedXeroInvoice: true,
          // The minter makes the customer; the replay passes none.
          member: expect.objectContaining({ id: "m1", stripeCustomerId: null }),
        }),
      );
      expect(result.succeeded).toBe(1);
      expect(wasClosedSuccessfully()).toBe(true);
      expect(wasLeftForRetry()).toBe(false);
      expect(mockAttachIntentToWaitingOps).toHaveBeenCalledWith({
        bookingModificationId: "mod-1",
        paymentIntentId: "pi_additional_1",
      });
      expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledTimes(1);
      expect(mockCompleteDeferredSupplementaryInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingModificationId: "mod-1",
          paymentIntentId: "pi_additional_1",
          priceDiffCents: 23000,
          hasIssuedXeroInvoice: true,
        }),
      );
    });
  });
});

/**
 * #3402: the edit's ONE recovery row is armed through one helper, which reopens
 * a row an earlier replay closed - and touches nothing else. The behaviour
 * against real rows (a SUCCEEDED row reopened by a deferral, then replayed into
 * a raise) is proved in `edit-financial-review-charge-raise-claim.realdb.test.ts`.
 */
describe("enqueueEditFinancialReviewChargeRecovery (#3402)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRecoveryUpsert.mockResolvedValue({});
    mockPaymentRecoveryUpdateMany.mockResolvedValue({ count: 0 });
  });

  it("enqueues under the edit's two keys, then re-arms ONLY a SUCCEEDED row and only marks a PROCESSING one", async () => {
    await enqueueEditFinancialReviewChargeRecovery({
      bookingId: "booking-1",
      paymentId: "payment-1",
      bookingModificationId: "mod-1",
      advisoryAmountCents: 7000,
      hadIssuedXeroInvoice: true,
    });

    const key = buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-1");
    expect(mockPaymentRecoveryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: key },
        create: expect.objectContaining({
          paymentIntentId: buildEditFinancialReviewAdditionalIntentStripeKey("mod-1"),
          amountCents: 7000,
          hadIssuedXeroInvoice: true,
        }),
      }),
    );
    const writes = mockPaymentRecoveryUpdateMany.mock.calls.map(
      (call) => call[0] as { where: Record<string, unknown>; data: Record<string, unknown> },
    );
    expect(writes).toHaveLength(2);
    // The PROCESSING move runs FIRST: in the other order a replay's close can
    // slip between the two and leave the row SUCCEEDED with nothing armed.
    expect(writes[0]).toEqual({
      where: { idempotencyKey: key, status: "PROCESSING" },
      data: { nextRetryAt: expect.any(Date) },
    });
    expect(writes[1]).toEqual({
      where: { idempotencyKey: key, status: "SUCCEEDED" },
      data: {
        status: "PENDING",
        attempts: 0,
        nextRetryAt: expect.any(Date),
        lastError: null,
        processingStartedAt: null,
        succeededAt: null,
      },
    });
    // A running replay (writes[0]) keeps its status - a second worker must not
    // be able to claim it - and only has its retry time moved, which its close
    // is fenced on.
    // A terminal FAILED row is never reopened (`INV-PAY-057`).
    expect(writes.some((write) => write.where.status === "FAILED")).toBe(false);
  });
});

describe("isEditFinancialReviewChargeRecoveryDead (#3402)", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["no row", null, false],
    ["a PENDING row", { status: "PENDING", attempts: 0, nextRetryAt: new Date() }, false],
    ["a running row", { status: "PROCESSING", attempts: 1, nextRetryAt: new Date() }, false],
    ["a closed row (a deferral reopens it)", { status: "SUCCEEDED", attempts: 1, nextRetryAt: null }, false],
    ["a retryable FAILED row", { status: "FAILED", attempts: 2, nextRetryAt: new Date() }, false],
    ["a FAILED row with no retry time", { status: "FAILED", attempts: 2, nextRetryAt: null }, true],
    ["a FAILED row with its attempts spent", { status: "FAILED", attempts: 5, nextRetryAt: new Date() }, true],
  ])("%s", async (_label, row, dead) => {
    mockPaymentRecoveryFindUnique.mockResolvedValueOnce(row);
    await expect(isEditFinancialReviewChargeRecoveryDead("mod-1")).resolves.toBe(dead);
    expect(mockPaymentRecoveryFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey("mod-1") },
      }),
    );
  });
});

/**
 * #3220: A DEAD RECOVERY WITHDRAWS THE ASK IT LEFT STANDING.
 *
 * A `CREATE_ADDITIONAL_PAYMENT_INTENT` recovery is the club still owing itself
 * the job of asking a member for money a booking edit raised. While it is alive
 * the booking-vs-Xero repair tool defers; the moment it dies the repair raises
 * that edit's supplementary invoice UNPAID (`OPEN_PAYMENT_RECOVERY_STATUSES`,
 * the #3202 control). So an ask still standing at the terminal transition is a
 * SECOND live instrument for one debt, and paying it leaves the club holding a
 * payment and an unpaid invoice for the same money.
 *
 * Everything here is about the TERMINAL transition specifically, and about the
 * cancel being unable to make the recovery worse than not trying.
 */
describe("#3220 - the terminal transition withdraws a stranded ask", () => {
  const MOD = "mod-3220";
  const RECOVERY_ID = "recovery-3220";

  function deadOnThisAttempt(overrides: Record<string, unknown> = {}) {
    return makeOperation({
      id: RECOVERY_ID,
      type: PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT,
      // The claim has already burnt the last attempt, so this failure is the
      // one that ends the operation.
      attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
      amountCents: 20000,
      paymentIntentId: buildEditFinancialReviewAdditionalIntentStripeKey(MOD),
      idempotencyKey:
        buildEditFinancialReviewAdditionalIntentRecoveryIdempotencyKey(MOD),
      paymentTransactionId: null,
      hadIssuedXeroInvoice: true,
      ...overrides,
    });
  }

  /** The ask as the ledger holds it, i.e. what a live intent looks like. */
  function liveAsk(overrides: Record<string, unknown> = {}) {
    return {
      paymentTransactionId: "txn-ask",
      stripePaymentIntentId: "pi_stranded_ask",
      amountCents: 23000,
      status: PaymentStatus.PENDING,
      ...overrides,
    };
  }

  function markedTerminallyFailed() {
    return mockPaymentRecoveryUpdateMany.mock.calls.some((call) => {
      const args = call[0] as {
        where?: { id?: string };
        data?: Record<string, unknown>;
      };
      if (args?.where?.id !== RECOVERY_ID) return false;
      return args?.data?.status === "FAILED" && args?.data?.nextRetryAt === null;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    settlementModuleLoadFailure.current = null;
    const operation = deadOnThisAttempt();
    mockPaymentRecoveryFindUnique.mockResolvedValue(operation);
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(
        isStaleWorkerSweep(args) ? [] : [{ ...operation, status: "PENDING" }],
      ),
    );
    mockPaymentRecoveryUpdateMany.mockImplementation(
      ({ where }: { where?: { id?: string } }) =>
        Promise.resolve({ count: where?.id ? 1 : 0 }),
    );
    mockPaymentRecoveryUpdate.mockResolvedValue({});
    mockBookingFindUnique.mockResolvedValue({
      status: "PAID",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      member: {
        id: "m1",
        email: "alice@test.com",
        firstName: "Alice",
        lastName: "Smith",
      },
      payment: { stripeCustomerId: "cus_123", status: PaymentStatus.SUCCEEDED },
    });
    // The replay's own work fails, which is what drives the terminal
    // transition. WHY it failed is not this block's subject.
    mockSyncEditFinancialReviewChargeRequest.mockRejectedValue(
      new Error("Stripe is unavailable"),
    );
    mockFindEditReviewChargeRequest.mockResolvedValue(liveAsk());
    // `clearAllMocks` clears calls, not implementations, so the one test that
    // parks a waiting operation on the ask has to be undone here or every test
    // after it silently exercises the exception instead of the rule.
    mockFindWaitingSupplementaryOpForIntent.mockResolvedValue(null);
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { id: "pi_stranded_ask", status: "canceled" },
    });
  });

  it("cancels the stranded ask, and says abandoned rather than blaming the member", async () => {
    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(markedTerminallyFailed()).toBe(true);
    /**
     * `requested_by_customer` - what the helper hard-coded before #3220 - would
     * be a lie in the club's own Stripe record. The member never declined this
     * ask; the club ran out of attempts to raise it.
     */
    expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith(
      "pi_stranded_ask",
      { cancellationReason: "abandoned" },
    );
  });

  it("leaves an ask the member has ALREADY PAID completely alone", async () => {
    // The acceptance criterion from the decision comment. The Stripe helper
    // would refuse a `succeeded` intent anyway, so this is the second lock on
    // the same door - but getting it wrong here would take money back off a
    // member who paid, so the door has two locks.
    mockFindEditReviewChargeRequest.mockResolvedValue(
      liveAsk({ status: PaymentStatus.SUCCEEDED }),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(markedTerminallyFailed()).toBe(true);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).not.toHaveBeenCalled();
  });

  it("makes no provider call at all when the mint never produced an ask", async () => {
    // The ORDINARY ending: the recovery existed precisely because nothing was
    // minted, so there is no second instrument and nothing to withdraw. A
    // provider call here would be a round trip on every dead recovery.
    mockFindEditReviewChargeRequest.mockResolvedValue(null);

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).not.toHaveBeenCalled();
  });

  it("does not touch the ask while the recovery still has attempts left", async () => {
    // A retry is not a death. Withdrawing the ask here would cancel an intent
    // the very next attempt is going to raise.
    const retryable = deadOnThisAttempt({ attempts: 1 });
    mockPaymentRecoveryFindUnique.mockResolvedValue(retryable);
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(
        isStaleWorkerSweep(args) ? [] : [{ ...retryable, status: "PENDING" }],
      ),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.retried).toBe(1);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).not.toHaveBeenCalled();
  });

  /**
   * THE REFUSAL PATH, which the decision comment singles out: `processing` is in
   * Stripe's cancellable set and Stripe routinely refuses to cancel a processing
   * intent, so this is a live path rather than a theoretical one.
   */
  it("records a refused cancel and still leaves the recovery dead, not blocked", async () => {
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("You cannot cancel this PaymentIntent because it is processing"),
    );

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // The status write happened BEFORE the cancel and cannot be undone by it.
    // If a Stripe refusal could hold the row out of FAILED, the repair tool
    // would defer this edit's invoice for ever - the #3202 control.
    expect(markedTerminallyFailed()).toBe(true);
    expect(result.failed).toBe(1);

    // A logger.error is not a record an officer can find, and this one asks
    // them to do something before the member pays an already-invoiced ask.
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "payment.recovery.strandedIntentCancellationRefused",
        category: "payment",
        outcome: "failure",
        entityId: "booking-1",
      }),
    );
  });

  it("never lets a refused cancel abandon the rest of the batch", async () => {
    /**
     * `failPaymentRecoveryOperation` is called from inside the worker loop's own
     * `catch`. A throw from there escapes the loop and abandons every remaining
     * operation - the exact bug the chokepoint was built to fix - so the cancel
     * is best-effort in the strongest sense: even the AUDIT write failing must
     * not propagate.
     */
    mockCancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
      new Error("Stripe refused"),
    );
    mockCreateAuditLog.mockRejectedValue(new Error("the audit write also died"));

    const first = deadOnThisAttempt({ id: RECOVERY_ID });
    const second = deadOnThisAttempt({ id: "recovery-3220-second" });
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(
        isStaleWorkerSweep(args)
          ? []
          : [
              { ...first, status: "PENDING" },
              { ...second, status: "PENDING" },
            ],
      ),
    );
    mockPaymentRecoveryFindUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === second.id ? second : first),
    );

    const result = await processPaymentRecoveryOperations({ limit: 5 });

    // BOTH were processed. One failing cancel must not cost the other one its
    // terminal transition, its alert, or its own withdrawal.
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(2);
  });

  /**
   * #3220 fix round: THE ONE ASK THE WITHDRAWAL LEAVES STANDING.
   *
   * The replay attaches this change's supplementary invoice operation to the
   * intent it mints, parked `WAITING_PAYMENT`, and can then throw while raising
   * the deferred invoice - so a dead recovery can arrive at the withdrawal with
   * a live ask AND a live outbox row pointing at it. That row is released by a
   * confirmed payment on that very intent and by nothing else, and while it
   * stands the repair pass raises NO invoice. There is therefore no second
   * instrument, and cancelling would remove the only live route to the money
   * while stranding the row until the fourteen-day reaper.
   */
  it("leaves the ask alone when this change's invoice is still waiting on it", async () => {
    mockFindWaitingSupplementaryOpForIntent.mockResolvedValue({
      id: "xero-op-waiting",
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    // The recovery still dies. The exception is about the ASK, never about the
    // status write - holding a row out of FAILED would re-block the repair tool
    // for ever, which is the #3202 control.
    expect(result.failed).toBe(1);
    expect(markedTerminallyFailed()).toBe(true);

    expect(mockFindWaitingSupplementaryOpForIntent).toHaveBeenCalledWith({
      bookingModificationId: MOD,
      paymentIntentId: "pi_stranded_ask",
    });
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).not.toHaveBeenCalled();
    // Nothing went wrong, so no officer is asked to chase a non-problem.
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("still withdraws the ask when the waiting invoice is on a DIFFERENT intent", async () => {
    // The exception is scoped to the ask being withdrawn, not to the booking
    // change: an operation waiting on some other intent is not this ask's
    // blocker, and reading it as one would leave a genuine duplicate standing.
    // The read is what decides that, so this pins the caller passing the intent
    // id at all rather than only the modification.
    mockFindWaitingSupplementaryOpForIntent.mockResolvedValue(null);

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(mockCancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith(
      "pi_stranded_ask",
      { cancellationReason: "abandoned" },
    );
  });

  it("is idempotent on replay: an already-cancelled ask makes no second cancel", async () => {
    /**
     * Idempotency here is STRUCTURAL rather than defensive.
     * `cancelPaymentIntentIfCancellableWithResult` reads the intent first and
     * returns `canceled: false` without calling Stripe at all unless the status
     * is one it can cancel - so a replay of this transition finds `canceled`,
     * makes no provider mutation, and cannot error or double-cancel. This pins
     * that the caller treats that answer as success rather than retrying it.
     */
    mockCancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: { id: "pi_stranded_ask", status: "canceled" },
    });

    const result = await processPaymentRecoveryOperations({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(
      mockCancelPaymentIntentIfCancellableWithResult,
    ).toHaveBeenCalledTimes(1);
    // Not an error, so no officer is asked to chase a non-problem.
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});

/**
 * #3220 fix round: THE STALE-WORKER REAPER FENCES THE ATTEMPT IT READ.
 *
 * Folding the reaper's two arms into the terminal chokepoint turned one bulk
 * `updateMany` into read-then-write. The bulk form's `where` carried
 * `processingStartedAt < staleBefore`; a fence of `status: PROCESSING` alone
 * does not, and matches a row that left `PROCESSING` and came straight back -
 * a concurrent reaper marks it failed with a `nextRetryAt` of NOW and the very
 * next queue read claims it. Taking that path kills a live attempt and acts on
 * terminality one attempt out of date.
 */
describe("#3220 - the stale-worker reaper cannot kill a re-claimed attempt", () => {
  it("pins the exact attempt it read, not merely the status", async () => {
    vi.clearAllMocks();
    const readAt = new Date("2026-06-01T00:00:00.000Z");
    const stale = makeOperation({
      id: "recovery-stale-fence",
      status: PaymentRecoveryOperationStatus.PROCESSING,
      attempts: 1,
      processingStartedAt: readAt,
    });
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(isStaleWorkerSweep(args) ? [stale] : []),
    );
    mockPaymentRecoveryUpdateMany.mockResolvedValue({ count: 1 });

    await processPaymentRecoveryOperations({ limit: 1 });

    expect(mockPaymentRecoveryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "recovery-stale-fence",
          status: { in: [PaymentRecoveryOperationStatus.PROCESSING] },
          // Without this the reaper matches a row that has since been failed,
          // re-armed and re-claimed - and kills the live attempt. #4083: the
          // attempt fence joins it as its own clause, so neither overwrites the
          // other's `processingStartedAt`.
          AND: [{ processingStartedAt: readAt }, { attempts: 1, processingStartedAt: { not: null } }],
        },
      }),
    );
  });

  /**
   * #3220 fix round: THE SWEEP IS BOUNDED, because it now costs provider calls.
   *
   * It runs BEFORE the main queue, and each row it takes can cost an alert plus
   * a Stripe read and cancel where the bulk `updateMany` it replaced made no
   * provider call at all. A backlog drains on its own - every row it touches
   * leaves `PROCESSING` for good - so the cap only ever defers work to the next
   * run, and oldest-first is what stops it deferring the same rows for ever.
   */
  it("reads the stale rows oldest-first and in a bounded batch", async () => {
    vi.clearAllMocks();
    mockPaymentRecoveryFindMany.mockImplementation((args?: unknown) =>
      Promise.resolve(isStaleWorkerSweep(args) ? [] : []),
    );

    await processPaymentRecoveryOperations({ limit: 1 });

    const sweep = mockPaymentRecoveryFindMany.mock.calls
      .map((call) => call[0])
      .find((args) => isStaleWorkerSweep(args)) as {
      take?: number;
      orderBy?: unknown;
    };
    expect(sweep?.take, "the stale sweep is unbounded again").toBeGreaterThan(0);
    expect(sweep?.orderBy).toEqual({ processingStartedAt: "asc" });
  });
});

/**
 * #4300 (`INV-PAY-138`): the superseded-intent check every door asks before it
 * settles a booking with a succeeded intent. With no cancel row to hand off, it
 * answers with the shared reading (`supersededMachineryOwnsCapture`) for the
 * intent's own payment; a hand-off that lost its claim asks that reading too.
 */
describe("#4300 — the check answers with the shared superseded-machinery reading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRecoveryUpsert.mockResolvedValue({});
    mockPaymentTransactionUpdate.mockResolvedValue({});
    mockReconcilePaymentAggregates.mockResolvedValue(undefined);
  });

  it("no cancel row: asks the shared reading for the intent's own payment, and writes nothing", async () => {
    mockPaymentRecoveryFindFirst.mockResolvedValue(null);
    mockFindPaymentTransactionByIntentId.mockResolvedValue({ paymentId: "pay-1" });
    mockSupersededMachineryOwnsCapture.mockResolvedValue(true);

    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: "pi_handed_off", amount: 6000, payment_method: "pm_1" }),
    ).resolves.toBe(true);
    expect(mockSupersededMachineryOwnsCapture).toHaveBeenCalledWith(expect.anything(), { paymentId: "pay-1", paymentIntentId: "pi_handed_off" });
    expect(mockPaymentRecoveryUpdateMany).not.toHaveBeenCalled();
    expect(mockPaymentTransactionUpdate).not.toHaveBeenCalled();
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
  });

  it("no cancel row and nothing owns it: false, so the door settles as before", async () => {
    mockPaymentRecoveryFindFirst.mockResolvedValue(null);
    mockFindPaymentTransactionByIntentId.mockResolvedValue(null);
    mockSupersededMachineryOwnsCapture.mockResolvedValue(false);

    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: "pi_ordinary", amount: 6000, payment_method: "pm_1" }),
    ).resolves.toBe(false);
    expect(mockSupersededMachineryOwnsCapture).toHaveBeenCalledWith(expect.anything(), { paymentId: null, paymentIntentId: "pi_ordinary" });
  });

  it("a hand-off that lost its claim answers what the rows still say: owned by another live row -> true", async () => {
    mockPaymentRecoveryFindFirst.mockResolvedValue(makeOperation({ status: PaymentRecoveryOperationStatus.PENDING }));
    mockPaymentRecoveryUpdateMany.mockResolvedValue({ count: 0 });
    mockFindPaymentTransactionByIntentId.mockResolvedValue({ paymentId: "pay-1" });
    mockSupersededMachineryOwnsCapture.mockResolvedValue(true);

    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: "pi_superseded", amount: 6000, payment_method: "pm_1" }),
    ).resolves.toBe(true);
    expect(mockSupersededMachineryOwnsCapture).toHaveBeenCalledTimes(1);
    expect(mockPaymentRecoveryUpsert).not.toHaveBeenCalled();
  });

  it("a hand-off that claimed its row answers true without asking again", async () => {
    mockPaymentRecoveryFindFirst.mockResolvedValue(makeOperation({ status: PaymentRecoveryOperationStatus.PENDING }));
    mockPaymentRecoveryUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentTransactionFindUnique.mockResolvedValue({ id: "txn_1", status: "PENDING", amountCents: 6000, refundedAmountCents: 0 });

    await expect(
      queueSupersededPaymentIntentRefundRecovery({ id: "pi_superseded", amount: 6000, payment_method: "pm_1" }),
    ).resolves.toBe(true);
    expect(mockSupersededMachineryOwnsCapture).not.toHaveBeenCalled();
  });
});
