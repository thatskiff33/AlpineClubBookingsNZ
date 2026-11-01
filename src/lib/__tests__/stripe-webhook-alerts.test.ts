import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockConstructWebhookEvent,
  mockProcessedWebhookCreate,
  mockProcessedWebhookDeleteMany,
  mockProcessedWebhookFindFirst,
  mockProcessedWebhookUpdateMany,
  mockPaymentFindUnique,
  mockPaymentUpdate,
  mockBookingFindUnique,
  mockBookingUpdateMany,
  mockTransaction,
  mockRecordWebhookLog,
  mockIsXeroConnected,
  mockEnqueueXeroBookingInvoiceOperation,
  mockEnqueueXeroRefundCreditNoteOperation,
  mockKickQueuedXeroOutboxOperationsIfConnected,
  mockReleaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
  mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent,
  mockNotifyXeroSyncError,
  mockSendBookingConfirmedEmail,
  mockSendAdminPaymentFailureAlert,
  mockSendSetupIntentFailedEmail,
  mockLogAudit,
  mockFindPaymentTransactionByIntentId,
  mockMarkPaymentIntentTransactionFailed,
  mockMarkPaymentIntentTransactionSucceeded,
  mockRefundPaymentTransactions,
  mockSyncRefundsFromStripeCharge,
  mockUpsertPaymentIntentTransaction,
  mockCompleteCanceledSupersededPaymentIntentRecovery,
  mockQueueSupersededPaymentIntentRefundRecovery,
  mockMarkBookingPaymentSucceeded,
  mockMarkBookingSetupIntentSucceeded,
  mockListRefundsForCharge,
  mockListRefundsForPaymentIntent,
  mockProcessRefund,
  mockGetPaymentMethod,
  mockApplyGroupSettlementSucceeded,
  mockMarkGroupSettlementIntentFailed,
  mockMarkGroupSettlementIntentRefunded,
  mockGroupBookingFindUnique,
  mockRecordAutomaticCancelledBookingRefundTask,
  mockFindCompletedHandBackForLateCapture,
  mockSendAdminLateCaptureAutoRefundAlert,
  mockSendAdminLateCaptureHandBackConflictAlert,
  mockPaymentTransactionFindFirst,
  mockPaymentTransactionFindUnique,
  mockPaymentTransactionUpdateMany,
  mockPaymentTransactionDeleteMany,
  mockReconcilePaymentAggregates,
  mockBookingEventFindMany,
  mockMemberCreditFindMany,
  mockPaymentRecoveryOperationFindUnique,
  mockPaymentRecoveryOperationFindFirst,
  mockManualRefundTaskFindUnique,
  mockManualRefundTaskFindFirst,
  mockManualRefundTaskCreate,
  mockManualRefundTaskUpdate,
  mockSendAdminLateCaptureHeldAlert,
  mockClaimAlertCooldown,
  mockBookingDefaultsFindUnique,
  mockPaymentRefundFindMany,
  mockFindLateCapturePaymentIntents,
  mockFindClosedLateCaptureRecordIntents,
  mockAuditLogFindMany,
} = vi.hoisted(() => ({
  mockPaymentRefundFindMany: vi.fn().mockResolvedValue([]),
  mockFindLateCapturePaymentIntents: vi.fn(),
  // #4149: the lost-record recovery's own reads.
  mockFindClosedLateCaptureRecordIntents: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockPaymentRecoveryOperationFindFirst: vi.fn().mockResolvedValue(null),
  // #3639: the treasurer-approval task and the club's setting. Null is "no task
  // owns this capture" and "the club never saved the setting", which is the
  // automatic refund every test below this block was written against.
  mockManualRefundTaskFindUnique: vi.fn().mockResolvedValue(null),
  mockManualRefundTaskFindFirst: vi.fn().mockResolvedValue(null),
  mockManualRefundTaskCreate: vi.fn().mockResolvedValue({ id: "task-held" }),
  mockManualRefundTaskUpdate: vi.fn().mockResolvedValue({ id: "task-2700" }),
  mockSendAdminLateCaptureHeldAlert: vi.fn().mockResolvedValue(undefined),
  mockClaimAlertCooldown: vi.fn().mockResolvedValue(true),
  mockBookingDefaultsFindUnique: vi.fn().mockResolvedValue(null),
  // #3639: the #1491 decision artefacts the late-capture handler reads before
  // it refunds (`loadCancellationRefundDecisionEvidence`, left REAL).
  mockBookingEventFindMany: vi.fn().mockResolvedValue([]),
  mockMemberCreditFindMany: vi.fn().mockResolvedValue([]),
  mockPaymentRecoveryOperationFindUnique: vi.fn().mockResolvedValue(null),
  mockConstructWebhookEvent: vi.fn(),
  mockProcessedWebhookCreate: vi.fn(),
  mockProcessedWebhookDeleteMany: vi.fn(),
  mockProcessedWebhookFindFirst: vi.fn(),
  mockProcessedWebhookUpdateMany: vi.fn(),
  mockPaymentFindUnique: vi.fn(),
  mockPaymentUpdate: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockBookingUpdateMany: vi.fn(),
  mockTransaction: vi.fn(),
  // #3267: the lost-response adoption reads the attempt row by the event's
  // idempotency key and settles it through the attempt-settle module, which is
  // left REAL here so the guarded write it makes is the one asserted.
  mockPaymentTransactionFindFirst: vi.fn().mockResolvedValue(null),
  mockPaymentTransactionFindUnique: vi.fn().mockResolvedValue(null),
  mockPaymentTransactionUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  mockPaymentTransactionDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  mockReconcilePaymentAggregates: vi.fn().mockResolvedValue(null),
  mockRecordWebhookLog: vi.fn().mockResolvedValue(undefined),
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
  mockEnqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: "op_1",
    message: "queued",
  }),
  mockEnqueueXeroRefundCreditNoteOperation: vi.fn().mockResolvedValue({
    queueOperationId: "op_credit_note_1",
    message: "queued",
  }),
  mockKickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue({
    found: 1,
    processed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
  }),
  mockReleaseXeroSupplementaryInvoiceForCapturedPaymentIntent: vi.fn().mockResolvedValue({
    released: 0,
    queueOperationIds: [],
  }),
  mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent: vi
    .fn()
    .mockResolvedValue(false),
  mockNotifyXeroSyncError: vi.fn().mockResolvedValue(undefined),
  mockSendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockSendSetupIntentFailedEmail: vi.fn().mockResolvedValue(undefined),
  mockLogAudit: vi.fn(),
  mockFindPaymentTransactionByIntentId: vi.fn(),
  mockMarkPaymentIntentTransactionFailed: vi.fn().mockResolvedValue(undefined),
  mockMarkPaymentIntentTransactionSucceeded: vi.fn().mockResolvedValue(undefined),
  mockRefundPaymentTransactions: vi.fn().mockResolvedValue({
    refunds: [],
    totalRefundedAmountCents: 0,
  }),
  mockSyncRefundsFromStripeCharge: vi.fn().mockResolvedValue(null),
  mockUpsertPaymentIntentTransaction: vi.fn().mockResolvedValue(undefined),
  mockCompleteCanceledSupersededPaymentIntentRecovery: vi.fn().mockResolvedValue(false),
  mockQueueSupersededPaymentIntentRefundRecovery: vi.fn().mockResolvedValue(false),
  mockMarkBookingPaymentSucceeded: vi.fn().mockResolvedValue({
    outcome: "paid",
    bookingId: "booking-1",
    bumpedBookingIds: [],
  }),
  mockMarkBookingSetupIntentSucceeded: vi.fn().mockResolvedValue({ stamped: true }),
  mockListRefundsForCharge: vi.fn().mockResolvedValue([]),
  // #4103 review C3: the refusals Stripe holds on a superseded group intent.
  mockListRefundsForPaymentIntent: vi.fn().mockResolvedValue([]),
  mockProcessRefund: vi.fn().mockResolvedValue({ id: "re_1" }),
  // #3266 — read by `setup-intent-card.ts`, which is left REAL so the "is the
  // card still attached" verdict runs for real over this double.
  mockGetPaymentMethod: vi.fn(),
  mockApplyGroupSettlementSucceeded: vi.fn().mockResolvedValue({
    outcome: "settled",
    settledBookingIds: [],
  }),
  mockMarkGroupSettlementIntentFailed: vi.fn().mockResolvedValue(undefined),
  mockMarkGroupSettlementIntentRefunded: vi.fn().mockResolvedValue(undefined),
  mockGroupBookingFindUnique: vi.fn().mockResolvedValue(null),
  // #2700 close, #2760 close-or-write, #2773 both handlers.
  // `existingStatus: null` is the healthy default: nothing was already there, so
  // this call IS the record. #2774 reads this field to detect the hand-COMPLETED
  // row that means the member was paid twice.
  mockRecordAutomaticCancelledBookingRefundTask: vi.fn().mockResolvedValue({
    closed: 0,
    created: true,
    alreadyRecorded: false,
    existingStatus: null,
  }),
  // #2774: the fence. `null` is "no operator has handed this capture back", which
  // is every ordering except the one the fence exists for.
  mockFindCompletedHandBackForLateCapture: vi.fn().mockResolvedValue(null),
  // #2761: this path's own unmuteable alert, in place of the generic
  // payment-failure mail.
  mockSendAdminLateCaptureAutoRefundAlert: vi.fn().mockResolvedValue(undefined),
  // #2774: the reconciliation alert that replaces it when an operator's hand-back
  // and the automatic refund claim the same capture.
  mockSendAdminLateCaptureHandBackConflictAlert: vi
    .fn()
    .mockResolvedValue(undefined),
}));

/*
  Only the two LEAF functions are mocked, not the shared epilogue in
  `cancelled-booking-late-capture.ts` (#2773). That module is deliberately left
  REAL here: it is the thing that decides which alert goes out, whether the record
  failure is audited, and whether #2774's fence returns before the refund — and a
  test that mocked it would assert the handler calls something rather than that the
  right thing happens. Its collaborators (`@/lib/audit`, `@/lib/email`,
  `@/lib/prisma`, `@/lib/logger`) are all already mocked below, so it runs against
  the same doubles the handler does.
*/
vi.mock("@/lib/deleted-booking-modification-payment", () => ({
  recordAutomaticCancelledBookingRefundTask: (...args: unknown[]) =>
    mockRecordAutomaticCancelledBookingRefundTask(...args),
  findCompletedHandBackForLateCapture: (...args: unknown[]) =>
    mockFindCompletedHandBackForLateCapture(...args),
  // #3639: the approval raise looks for the confirm route's open question by it.
  automaticCancelledBookingRefundTaskReasons: (paymentIntentId: string) => [
    `reason-for-${paymentIntentId}`,
  ],
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: (...args: unknown[]) => mockConstructWebhookEvent(...args),
  listRefundsForCharge: (...args: unknown[]) => mockListRefundsForCharge(...args),
  listRefundsForPaymentIntent: (...args: unknown[]) => mockListRefundsForPaymentIntent(...args),
  processRefund: (...args: unknown[]) => mockProcessRefund(...args),
  getPaymentMethod: (...args: unknown[]) => mockGetPaymentMethod(...args),
}));
// DB-only (#2082): the webhook route resolves its signing secret via
// stripe-config and records the webhook-verified marker; mock both so the route
// reaches signature verification without a DB.
vi.mock("@/lib/stripe-config", () => ({
  getOperationalStripeWebhookSecret: vi.fn().mockResolvedValue("whsec_test"),
  recordStripeWebhookVerified: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/group-settlement", () => ({
  applyGroupSettlementSucceeded: (...args: unknown[]) =>
    mockApplyGroupSettlementSucceeded(...args),
  markGroupSettlementIntentFailed: (...args: unknown[]) =>
    mockMarkGroupSettlementIntentFailed(...args),
  markGroupSettlementIntentRefunded: (...args: unknown[]) =>
    mockMarkGroupSettlementIntentRefunded(...args),
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: (...args: unknown[]) =>
    mockMarkBookingPaymentSucceeded(...args),
  markBookingSetupIntentSucceeded: (...args: unknown[]) =>
    mockMarkBookingSetupIntentSucceeded(...args),
}));
vi.mock("@/lib/payment-transactions", () => ({
  // #4217: the attempt-row settle locks the Payment row first.
  lockPaymentForRefundedTotal: async () => undefined,
  findPaymentTransactionByIntentId: (...args: unknown[]) =>
    mockFindPaymentTransactionByIntentId(...args),
  markPaymentIntentTransactionFailed: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionFailed(...args),
  markPaymentIntentTransactionSucceeded: (...args: unknown[]) =>
    mockMarkPaymentIntentTransactionSucceeded(...args),
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  syncRefundsFromStripeCharge: (...args: unknown[]) =>
    mockSyncRefundsFromStripeCharge(...args),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
  reconcilePaymentAggregates: (...args: unknown[]) =>
    mockReconcilePaymentAggregates(...args),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "recovery_additional" }),
  completeCanceledSupersededPaymentIntentRecovery: (...args: unknown[]) =>
    mockCompleteCanceledSupersededPaymentIntentRecovery(...args),
  queueSupersededPaymentIntentRefundRecovery: (...args: unknown[]) =>
    mockQueueSupersededPaymentIntentRefundRecovery(...args),
  getStripePaymentMethodId: (paymentIntent: {
    payment_method?: string | { id?: string | null } | null;
  }) =>
    typeof paymentIntent.payment_method === "string"
      ? paymentIntent.payment_method
      : paymentIntent.payment_method?.id ?? null,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedWebhookEvent: {
      create: (...args: unknown[]) => mockProcessedWebhookCreate(...args),
      deleteMany: (...args: unknown[]) => mockProcessedWebhookDeleteMany(...args),
      findFirst: (...args: unknown[]) => mockProcessedWebhookFindFirst(...args),
      updateMany: (...args: unknown[]) => mockProcessedWebhookUpdateMany(...args),
    },
    payment: {
      findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
    },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
    },
    // #1641 — the capture guard derives applied credit from the ledger only when
    // the captured amount is not the full price; these fixtures apply none.
    memberCredit: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: 0 } }),
      findMany: (...args: unknown[]) => mockMemberCreditFindMany(...args),
    },
    bookingEvent: {
      findMany: (...args: unknown[]) => mockBookingEventFindMany(...args),
    },
    paymentRecoveryOperation: {
      findUnique: (...args: unknown[]) =>
        mockPaymentRecoveryOperationFindUnique(...args),
      findFirst: (...args: unknown[]) =>
        mockPaymentRecoveryOperationFindFirst(...args),
    },
    groupBooking: {
      findUnique: (...args: unknown[]) => mockGroupBookingFindUnique(...args),
    },
    manualRefundTask: {
      findUnique: (...args: unknown[]) => mockManualRefundTaskFindUnique(...args),
    },
    // #3635 round-3 R4: a late capture's refunds are noted per capture, from
    // its refund rows less the notes already raised for it.
    paymentRefund: {
      findMany: (...args: unknown[]) => mockPaymentRefundFindMany(...args),
    },
    auditLog: {
      findMany: (...args: unknown[]) => mockAuditLogFindMany(...args),
    },
    xeroSyncOperation: {
      findMany: async () => [],
    },
    bookingDefaults: {
      findUnique: (...args: unknown[]) => mockBookingDefaultsFindUnique(...args),
    },
    // #3267: the attempt-row adoption for an intent the ledger does not know.
    paymentTransaction: {
      findFirst: (...args: unknown[]) => mockPaymentTransactionFindFirst(...args),
      findUnique: (...args: unknown[]) => mockPaymentTransactionFindUnique(...args),
      updateMany: (...args: unknown[]) => mockPaymentTransactionUpdateMany(...args),
      deleteMany: (...args: unknown[]) => mockPaymentTransactionDeleteMany(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock("@/lib/webhook-log", () => ({
  recordWebhookLog: (...args: unknown[]) => mockRecordWebhookLog(...args),
}));

// #4104: a refund Stripe accepted and failed later.
// #4170: the outside-the-app refund alert's own unmuteable sender.
const mockSendAdminLateCaptureRefundedOutsideAppAlert = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
const mockRecordRefusedCardRefund = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>(async () => "recorded"));
vi.mock("@/lib/card-refund-status-sync", () => ({
  recordRefusedCardRefund: (...args: unknown[]) => mockRecordRefusedCardRefund(...args),
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: (...args: unknown[]) => mockIsXeroConnected(...args),
}));
// #3639: the late-capture Xero correction reads the token store directly.
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: (...args: unknown[]) => mockIsXeroConnected(...args),
}));

// #3635 (review F2): "was this capture ever recorded in Xero?" is asked of the
// capture's own invoice rows. Here the only such row is a released change
// invoice, which the supplementary double below answers.
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  hasXeroReceiptForLateCapture: (paymentIntentId: string) =>
    mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(paymentIntentId),
  // #3635 round-3: no charge.refunded here is of a late capture unless a case says so.
  findLateCapturePaymentIntents: (...args: unknown[]) => mockFindLateCapturePaymentIntents(...args),
  findClosedLateCaptureRecords: (...args: unknown[]) => mockFindClosedLateCaptureRecordIntents(...args),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroBookingInvoiceOperation(...args),
  hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent: (
    ...args: unknown[]
  ) => mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(...args),
  enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) =>
    mockEnqueueXeroRefundCreditNoteOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mockKickQueuedXeroOutboxOperationsIfConnected(...args),
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: (...args: unknown[]) =>
    mockReleaseXeroSupplementaryInvoiceForCapturedPaymentIntent(...args),
}));
// #3953: a change's capture recorded by its own receipt names that receipt's invoice; none here unless a case says so.
const mockFindAdditionalCaptureReceiptInvoiceId = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null));
vi.mock("@/lib/additional-capture-receipt-link", () => ({
  findAdditionalCaptureReceiptInvoiceId: (...args: unknown[]) => mockFindAdditionalCaptureReceiptInvoiceId(...args),
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: (...args: unknown[]) => mockNotifyXeroSyncError(...args),
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: (...args: unknown[]) => mockSendBookingConfirmedEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
  sendAdminLateCaptureRefundedOutsideAppAlert: (...args: unknown[]) => mockSendAdminLateCaptureRefundedOutsideAppAlert(...args),
  // #2761: the late-capture path's own unmuteable alert.
  sendAdminLateCaptureAutoRefundAlert: (...args: unknown[]) =>
    mockSendAdminLateCaptureAutoRefundAlert(...args),
  // #2774: the hand-back conflict alert, which REPLACES the one above whenever an
  // operator's hand-back and the automatic refund claim the same capture.
  sendAdminLateCaptureHandBackConflictAlert: (...args: unknown[]) =>
    mockSendAdminLateCaptureHandBackConflictAlert(...args),
  sendSetupIntentFailedEmail: (...args: unknown[]) => mockSendSetupIntentFailedEmail(...args),
  // #3639 (delta D7): the once-only alert for a capture held for a treasurer.
  sendAdminLateCaptureHeldAlert: (...args: unknown[]) =>
    mockSendAdminLateCaptureHeldAlert(...args),
}));

vi.mock("@/lib/alert-cooldown", () => ({
  // #3635: the held late-capture alert claims through `sendAdminAlertOnceEver`.
  ALERT_ONCE_EVER_WINDOW_MS: 36_500 * 86_400_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 86_400_000,
  claimAlertCooldown: (...args: unknown[]) => mockClaimAlertCooldown(...args),
  deferAlertCooldown: async () => undefined,
  releaseAlertCooldown: async () => undefined,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// #4532: the record-and-alert of a payment the app did not create, pinned on its own
// in `unrecognised-stripe-payment.test.ts`; here only the dispatch reaches it.
const mockRecordUnrecognisedStripePayment = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
// #4624: the app's own intent that no PRIMARY row settles, pinned on its own in
// `unrecognised-stripe-payment.test.ts`; here only the dispatch reaches it.
const mockRecordUnmatchedAppStripePayment = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock("@/lib/unrecognised-stripe-payment", () => ({
  recordUnrecognisedStripePayment: (...args: unknown[]) => mockRecordUnrecognisedStripePayment(...args),
  recordUnmatchedAppStripePayment: (...args: unknown[]) => mockRecordUnmatchedAppStripePayment(...args),
}));

import { POST } from "@/app/api/webhooks/stripe/route";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("Stripe webhook Xero alerting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentRefundFindMany.mockResolvedValue([]);
    mockFindLateCapturePaymentIntents.mockImplementation(async () => new Set<string>());
    mockFindClosedLateCaptureRecordIntents.mockImplementation(async () => new Map<string, string>());
    // #4149: the recovery reads what the refunding delivery wrote - answered
    // from the entries this test's deliveries actually wrote.
    mockAuditLogFindMany.mockImplementation(async ({ where }: { where: { action: string; entityId: string } }) =>
      mockLogAudit.mock.calls
        .map(([entry]) => entry as { action: string; entityId?: string; details?: string })
        .filter((row) => row.action === where.action && row.entityId === where.entityId)
        .map((row) => ({ details: row.details ?? null })),
    );
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 0 });
    // F16 (#1887): the claim is a lease. Default findFirst to a COMPLETED row so
    // a P2002 duplicate short-circuits as before; updateMany (the COMPLETED
    // stamp on success, and the lease takeover) defaults to one affected row.
    mockProcessedWebhookFindFirst.mockResolvedValue({
      status: "COMPLETED",
      processingStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentUpdate.mockResolvedValue({});
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockFindPaymentTransactionByIntentId.mockResolvedValue(null);
    mockBookingEventFindMany.mockResolvedValue([]);
    mockMemberCreditFindMany.mockResolvedValue([]);
    mockPaymentRecoveryOperationFindUnique.mockResolvedValue(null);
    mockPaymentRecoveryOperationFindFirst.mockResolvedValue(null);
    mockMarkPaymentIntentTransactionFailed.mockResolvedValue(undefined);
    mockMarkPaymentIntentTransactionSucceeded.mockResolvedValue(undefined);
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockSyncRefundsFromStripeCharge.mockResolvedValue(null);
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
    mockCompleteCanceledSupersededPaymentIntentRecovery.mockResolvedValue(false);
    // #3639 review F1: NOT a flat `false`. The real hook hands the capture off
    // (and the late handler never runs) exactly when a non-terminal
    // CANCEL_PAYMENT_INTENT recovery exists for the intent, so the double reads
    // the same state the classifier does. A test cannot reach the late handler
    // with a live cancel op behind it, which is the state the dispatch never
    // produces.
    mockQueueSupersededPaymentIntentRefundRecovery.mockImplementation(
      async ({ paymentIntentId }: { paymentIntentId: string }) => {
        const operation = (await mockPaymentRecoveryOperationFindFirst({
          where: { type: "CANCEL_PAYMENT_INTENT", paymentIntentId },
        })) as { status?: string } | null;
        return (
          operation !== null &&
          operation !== undefined &&
          ["PENDING", "PROCESSING", "FAILED"].includes(operation.status ?? "")
        );
      },
    );
    mockMarkBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
    mockMarkBookingSetupIntentSucceeded.mockResolvedValue({ stamped: true });
    mockListRefundsForCharge.mockResolvedValue([]);
    mockListRefundsForPaymentIntent.mockResolvedValue([]);
    // #4131: the late capture's own row, per test.
    mockPaymentTransactionFindUnique.mockResolvedValue(null);
    mockProcessRefund.mockResolvedValue({ id: "re_1" });
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "settled",
      settledBookingIds: [],
    });
    mockMarkGroupSettlementIntentFailed.mockResolvedValue(undefined);
    mockGroupBookingFindUnique.mockResolvedValue(null);
    mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(
      false,
    );
    mockManualRefundTaskFindUnique.mockResolvedValue(null);
    mockManualRefundTaskFindFirst.mockResolvedValue(null);
    mockManualRefundTaskCreate.mockResolvedValue({ id: "task-held" });
    mockBookingDefaultsFindUnique.mockResolvedValue(null);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: vi.fn().mockResolvedValue(1),
        payment: {
          update: (...args: unknown[]) => mockPaymentUpdate(...args),
        },
        booking: {
          updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
          findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
        },
        // #3639: the approval raise's own reads and write, under lock(1).
        manualRefundTask: {
          findUnique: (...args: unknown[]) => mockManualRefundTaskFindUnique(...args),
          findFirst: (...args: unknown[]) => mockManualRefundTaskFindFirst(...args),
          create: (...args: unknown[]) => mockManualRefundTaskCreate(...args),
          update: (...args: unknown[]) => mockManualRefundTaskUpdate(...args),
        },
      })
    );
  });

  function makeRequest() {
    return new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "test-sig" },
      body: JSON.stringify({}),
    });
  }

  it("returns 400 when the Stripe signature header is missing", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing stripe-signature header",
    });
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized Stripe webhook payloads before signature verification", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: {
          "stripe-signature": "test-sig",
          "content-length": String(1024 * 1024 + 1),
        },
        body: "{}",
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook payload too large",
    });
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed Stripe webhook content-length before signature verification", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: {
          "stripe-signature": "test-sig",
          "content-length": "42x",
        },
        body: "{}",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid content-length header",
    });
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a present-but-invalid Stripe signature without processing the event", async () => {
    // Wrong-signature row of the webhook Critical matrix (issue #1133): the
    // header is present but verification fails, so nothing may be processed
    // and no idempotency claim may be written.
    mockConstructWebhookEvent.mockImplementation(() => {
      throw new Error(
        "No signatures found matching the expected signature for payload"
      );
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook signature verification failed",
    });
    expect(mockProcessedWebhookCreate).not.toHaveBeenCalled();
  });

  it("uses the deduplicated notifier when invoice creation fails after payment success", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_primary",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_primary",
          amount: 5000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);

    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      bookingId: "booking-1",
      kind: "PRIMARY",
      amountCents: 5000,
      status: "PENDING",
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: "CONFIRMED",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      finalPriceCents: 5000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      promoRedemption: null,
    });
    mockEnqueueXeroBookingInvoiceOperation.mockRejectedValue(new Error("Xero invoice failed"));

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      bookingId: "booking-1",
      paymentIntentId: "pi_primary",
      amountCents: 5000,
      paymentMethodId: "pm_123",
      // #4285 review: found by its intent, not adopted - nothing this delivery wrote.
      recordedByCaller: false,
    });
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "INVOICE_CREATION",
      operation: "Queue invoice for booking booking-1",
      errorMessage: "Xero invoice failed",
    });
    expect(mockRecordWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "stripe",
        eventType: "payment_intent.succeeded",
        status: "success",
      })
    );
  });

  it("alerts and refuses a capture whose amount no longer matches the booking total (#1161)", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_stale_capture",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_stale",
          amount: 10000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);
    // Transaction mirrors the intent (both 10000), so the tx-vs-intent check
    // passes; only the booking's CURRENT price reveals the staleness.
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      bookingId: "booking-1",
      kind: "PRIMARY",
      amountCents: 10000,
      status: "PENDING",
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: "PAYMENT_PENDING",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      finalPriceCents: 15000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      promoRedemption: null,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_stale",
        amountCents: 10000,
        errorMessage: expect.stringContaining("stale intent"),
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("#3955 F7: names what the booking OWES — price plus a recorded fee — as the expected amount", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_stale_fee",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_stale_fee", amount: 15000, metadata: { bookingId: "booking-1" }, payment_method: "pm_123" } },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      bookingId: "booking-1",
      kind: "PRIMARY",
      amountCents: 15000,
      status: "PENDING",
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: "PAYMENT_PENDING",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      finalPriceCents: 15000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      payment: { status: "PENDING", stripePaymentIntentId: "pi_stale_fee", changeFeeCents: 2500 },
      promoRedemption: null,
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("Expected $175.00") }),
      CLUB_FORMAT_TEST,
    );
  });

  it("#4300: a capture the settle refuses as superseded sends no confirmation and queues no invoice", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_superseded_raced",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_raced", amount: 15000, metadata: { bookingId: "booking-1" }, payment_method: "pm_123" } },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue({ id: "txn-1", paymentId: "payment-1", bookingId: "booking-1", kind: "PRIMARY", amountCents: 15000, status: "PENDING" });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: "PAYMENT_PENDING",
      checkIn: new Date("2026-06-01"),
      checkOut: new Date("2026-06-03"),
      finalPriceCents: 15000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      payment: { status: "PENDING", stripePaymentIntentId: "pi_raced", changeFeeCents: null },
      promoRedemption: null,
    });
    mockMarkBookingPaymentSucceeded.mockResolvedValueOnce({ outcome: "superseded_capture", bookingId: "booking-1", bumpedBookingIds: [] });

    const response = await POST(makeRequest());

    // Answered 200: the refusal is final, so Stripe is not sent back to retry for days.
    expect(response.status).toBe(200);
    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_raced" }));
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("#3955 F5: a redelivered capture the booking already settled with is not re-checked against a later fee", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_redelivered",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_settled", amount: 15000, metadata: { bookingId: "booking-1" }, payment_method: "pm_123" } },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-1",
      paymentId: "payment-1",
      bookingId: "booking-1",
      kind: "PRIMARY",
      amountCents: 15000,
      status: "SUCCEEDED",
    });
    // Captured at 15000; a later correction recorded a 2500 fee on the payment.
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: "COMPLETED",
      checkIn: new Date("2026-06-01"),
      checkOut: new Date("2026-06-03"),
      finalPriceCents: 15000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      payment: { id: "payment-1", status: "SUCCEEDED", stripePaymentIntentId: "pi_settled", changeFeeCents: 2500 },
      promoRedemption: null,
    });
    mockMarkBookingPaymentSucceeded.mockResolvedValueOnce({ outcome: "already_paid", bookingId: "booking-1", bumpedBookingIds: [] });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_settled", amountCents: 15000 }),
    );
  });

  // #4211 review: captured at 15000; a later correction recorded a 2500 fee, so
  // the booking now owes 17500. Which captures skip the stale-amount check.
  // `outcome` is mocked here: it is the value the REAL settle returns for that
  // capture (#4285: on a COMPLETED booking as on a PAID one, `INV-PAY-043`), as
  // `issue-1992-duplicate-capture-refund.test.ts` and, on PostgreSQL,
  // `completed-redelivery.realdb.test.ts` prove.
  const SETTLER = "txn-1";
  it.each([
    {
      label: "the recorded settler, the intent pointer since moved to a later row",
      bookingStatus: "COMPLETED", rowStatus: "SUCCEEDED", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_later_row", settledByTransactionId: SETTLER },
      handed: true, outcome: "already_paid",
    },
    {
      label: "the recorded settler, partly refunded since",
      bookingStatus: "COMPLETED", rowStatus: "PARTIALLY_REFUNDED", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_later_row", settledByTransactionId: SETTLER },
      handed: true, outcome: "already_paid",
    },
    {
      label: "F1: a kept or refund-queued duplicate replayed on a PAID booking edited since",
      bookingStatus: "PAID", rowStatus: "SUCCEEDED", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_settled", settledByTransactionId: "txn-other" },
      handed: true, outcome: "duplicate_capture_refunded",
    },
    {
      label: "F2: a duplicate's FIRST delivery at a stale amount on a PAID booking",
      bookingStatus: "PAID", rowStatus: "PENDING", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_other", settledByTransactionId: "txn-other" },
      handed: true, outcome: "duplicate_capture_refunded",
    },
    {
      label: "#4285: a duplicate's FIRST delivery at a stale amount on a COMPLETED booking",
      bookingStatus: "COMPLETED", rowStatus: "PENDING", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_other", settledByTransactionId: "txn-other" },
      handed: true, outcome: "duplicate_capture_refunded",
    },
    {
      label: "#4285: not the settler on a COMPLETED booking, settled before the fee",
      bookingStatus: "COMPLETED", rowStatus: "SUCCEEDED", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_settled", settledByTransactionId: "txn-other" },
      handed: true, outcome: "duplicate_capture_refunded",
    },
    {
      label: "#4285 review F7: off a paid-like booking, not the intent pointer naming this SUCCEEDED row (no settler)",
      bookingStatus: "CONFIRMED", rowStatus: "SUCCEEDED", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_settled", settledByTransactionId: null },
      handed: false, outcome: null,
    },
    {
      label: "#4285 review F7: off a paid-like booking, not this row recorded as the settler",
      bookingStatus: "CONFIRMED", rowStatus: "SUCCEEDED", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_other", settledByTransactionId: SETTLER },
      handed: false, outcome: null,
    },
    {
      label: "not widened to an unpaid booking: a stale intent there is refused (#1161)",
      bookingStatus: "PAYMENT_PENDING", rowStatus: "PENDING", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_settled", settledByTransactionId: null },
      handed: false, outcome: null,
    },
    {
      label: "no settler recorded and the intent pointer names another intent, on an unpaid booking",
      bookingStatus: "PAYMENT_PENDING", rowStatus: "SUCCEEDED", rowPaymentId: "payment-1",
      payment: { stripePaymentIntentId: "pi_other", settledByTransactionId: null },
      handed: false, outcome: null,
    },
    {
      label: "the settler's id, but on a row of another payment",
      bookingStatus: "COMPLETED", rowStatus: "SUCCEEDED", rowPaymentId: "payment-elsewhere",
      payment: { stripePaymentIntentId: "pi_other", settledByTransactionId: SETTLER },
      handed: false, outcome: null,
    },
    {
      label: "a PAID booking, but the capture's row is on another payment",
      bookingStatus: "PAID", rowStatus: "SUCCEEDED", rowPaymentId: "payment-elsewhere",
      payment: { stripePaymentIntentId: "pi_other", settledByTransactionId: "txn-other" },
      handed: false, outcome: null,
    },
  ])("#4211: the stale-amount check skips $label: $handed", async ({ bookingStatus, rowStatus, rowPaymentId, payment, handed, outcome }) => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_redelivered_4211",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_settled", amount: 15000, metadata: { bookingId: "booking-1" }, payment_method: "pm_123" } },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: SETTLER,
      paymentId: rowPaymentId,
      bookingId: "booking-1",
      kind: "PRIMARY",
      amountCents: 15000,
      status: rowStatus,
    });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      status: bookingStatus,
      checkIn: new Date("2026-06-01"),
      checkOut: new Date("2026-06-03"),
      finalPriceCents: 15000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      payment: { id: "payment-1", status: "SUCCEEDED", changeFeeCents: 2500, ...payment },
      promoRedemption: null,
    });
    if (outcome) mockMarkBookingPaymentSucceeded.mockResolvedValueOnce({ outcome, bookingId: "booking-1", bumpedBookingIds: [] });

    const response = await POST(makeRequest());

    if (handed) {
      // Not re-checked against the later fee: handed to the settle, which keeps or refunds it.
      expect(response.status).toBe(200);
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_settled", amountCents: 15000 }),
      );
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    } else {
      // Compared with what the booking owes now, and refused.
      expect(response.status).toBe(500);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: expect.stringContaining("Expected $175.00") }),
        CLUB_FORMAT_TEST,
      );
    }
  });

  it("uses the deduplicated notifier when credit note creation fails after a refund webhook", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund",
          payment_intent: "pi_refund",
          amount_refunded: 5000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_refund",
        amount: 5000,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000000,
        charge: "ch_refund",
        payment_intent: "pi_refund",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-2",
      refundDeltaCents: 5000,
      newlyCountedRefundIds: [], // #4312: what the real sync returns beside the delta
      payment: {
        id: "payment-2",
        amountCents: 5000,
        refundedAmountCents: 5000,
      },
    });
    mockIsXeroConnected.mockResolvedValue(true);
    mockEnqueueXeroRefundCreditNoteOperation.mockRejectedValue(
      new Error("Xero credit note failed")
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockListRefundsForCharge).toHaveBeenCalledWith("ch_refund");
    expect(mockSyncRefundsFromStripeCharge).toHaveBeenCalledWith({
      paymentIntentId: "pi_refund",
      stripeChargeId: "ch_refund",
      refundedAmountCents: 5000,
      refunds,
    });
    expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment-2",
      5000
    );
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "CREDIT_NOTE_CREATION",
      operation: "Queue refund credit note for payment payment-2",
      errorMessage: "Xero credit note failed",
    });
  });

  it("queues only the newly observed refund delta from Stripe's cumulative amount", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund_delta",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_delta",
          payment_intent: "pi_refund_delta",
          amount_refunded: 5000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_refund_delta",
        amount: 3800,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000000,
        charge: "ch_refund_delta",
        payment_intent: "pi_refund_delta",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-3",
      refundDeltaCents: 3800,
      newlyCountedRefundIds: [], // #4312: what the real sync returns beside the delta
      payment: {
        id: "payment-3",
        amountCents: 5000,
        refundedAmountCents: 5000,
      },
    });
    mockIsXeroConnected.mockResolvedValue(false);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockSyncRefundsFromStripeCharge).toHaveBeenCalledWith({
      paymentIntentId: "pi_refund_delta",
      stripeChargeId: "ch_refund_delta",
      refundedAmountCents: 5000,
      refunds,
    });
    expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment-3",
      3800
    );
  });

  // #3953 (`INV-PAY-139`): a change's capture its own receipt recorded against
  // the gap invoice - its refund's note names that invoice, not the primary.
  it("names the invoice a change capture's own receipt paid on that capture's refund note", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund_receipt",
      type: "charge.refunded",
      data: { object: { id: "ch_receipt", payment_intent: "pi_change", amount_refunded: 8000 } },
    } as any);
    mockListRefundsForCharge.mockResolvedValue([]);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-3",
      refundDeltaCents: 8000,
      payment: { id: "payment-3", amountCents: 38000, refundedAmountCents: 8000 },
    });
    mockIsXeroConnected.mockResolvedValue(false);
    mockFindAdditionalCaptureReceiptInvoiceId.mockResolvedValueOnce("inv_gap");

    expect((await POST(makeRequest())).status).toBe(200);
    expect(mockFindAdditionalCaptureReceiptInvoiceId).toHaveBeenCalledWith("pi_change");
    expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("payment-3", 8000, {
      creditsInvoiceId: "inv_gap",
    });
  });

  // #3635 round-3 R1/R4: a refund of a LATE capture is noted per capture, and
  // only once the app recorded that capture's receipt - never by the
  // payment-wide delta, which would note a capture Xero never received.
  describe("charge.refunded of a late capture (round 3)", () => {
    const refundEvent = () => {
      mockConstructWebhookEvent.mockReturnValue({
        id: "evt_refund_late",
        type: "charge.refunded",
        data: { object: { id: "ch_late", payment_intent: "pi_late", amount_refunded: 3800 } },
      } as any);
      mockListRefundsForCharge.mockResolvedValue([]);
      mockSyncRefundsFromStripeCharge.mockResolvedValue({
        paymentId: "payment-3",
        refundDeltaCents: 3800,
        newlyCountedRefundIds: [], // #4312: what the real sync returns beside the delta
        payment: { id: "payment-3", amountCents: 24000, refundedAmountCents: 3800 },
      });
      mockIsXeroConnected.mockResolvedValue(false);
      mockFindLateCapturePaymentIntents.mockImplementation(async () => new Set(["pi_late"]));
      mockPaymentRefundFindMany.mockResolvedValue([
        {
          amountCents: 3800,
          status: "succeeded",
          stripeCreatedAt: new Date("2026-06-11T22:00:00.000Z"),
          createdAt: new Date("2026-06-11T22:00:00.000Z"),
        },
      ]);
    };

    it("queues nothing while the app has recorded no receipt for the capture", async () => {
      refundEvent();
      mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(false);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("queues the capture's own refunds, naming the capture and the refund's day, once it has a receipt", async () => {
      refundEvent();
      mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(true);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("payment-3", 3800, {
        refundMethod: "card",
        paymentIntentId: "pi_late",
        documentDate: "2026-06-12",
      });
    });

    it("#4312 review: a refund this sync recorded first is the capture's to note even when the refunded total did not move", async () => {
      refundEvent();
      mockSyncRefundsFromStripeCharge.mockResolvedValue({
        paymentId: "payment-3",
        refundDeltaCents: 0,
        newlyCountedRefundIds: ["re_late_new"],
        payment: { id: "payment-3", amountCents: 24000, refundedAmountCents: 3800 },
      });
      mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(true);

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("payment-3", 3800, expect.objectContaining({ paymentIntentId: "pi_late" }));
    });
  });

  // #4170: charge.refunded can land before the late capture's record (a
  // crash, or a lost record write) - never the generic whole-payment note then.
  describe("charge.refunded of a late capture with no record yet (#4170)", () => {
    const DOOR_REFUND = {
      id: "re_late_door",
      amount: 3800,
      status: "succeeded",
      metadata: { bookingId: "booking-3", reason: "cancelled_booking_late_capture" },
    };
    const refundEvent = (stripeRefunds: unknown[], captureReason: string | null = null) => {
      mockConstructWebhookEvent.mockReturnValue({
        id: "evt_refund_unrecorded",
        type: "charge.refunded",
        data: { object: { id: "ch_late", payment_intent: "pi_late", amount_refunded: 3800 } },
      } as any);
      mockListRefundsForCharge.mockResolvedValue(stripeRefunds);
      mockSyncRefundsFromStripeCharge.mockResolvedValue({
        paymentId: "payment-3",
        refundDeltaCents: 3800,
        newlyCountedRefundIds: [], // #4312: what the real sync returns beside the delta
        payment: { id: "payment-3", amountCents: 24000, refundedAmountCents: 3800 },
      });
      mockIsXeroConnected.mockResolvedValue(false);
      // No task row names the capture yet.
      mockFindLateCapturePaymentIntents.mockImplementation(async () => new Set<string>());
      mockPaymentFindUnique.mockResolvedValue({ bookingId: "booking-3", booking: { status: "CANCELLED" } });
      mockPaymentTransactionFindUnique.mockResolvedValue({ paymentId: "payment-3", reason: captureReason, refundedAmountCents: 3800 });
      mockEnqueueXeroRefundCreditNoteOperation.mockResolvedValue({ queueOperationId: "op_generic", message: "queued" });
    };

    it("queues no generic note for a late-capture door refund: its record writes the capture's own note", async () => {
      refundEvent([DOOR_REFUND]);

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking.payment.late_capture_refunded_outside_app" }),
      );
    });

    it("queues no generic note, and names it, for a marked late capture refunded outside the app", async () => {
      refundEvent([{ id: "re_dashboard", amount: 3800, status: "succeeded", metadata: {} }], "cancelled_booking_late_capture");

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking.payment.late_capture_refunded_outside_app", severity: "important", entityId: "booking-3" }),
      );
      // Finance is told, once ever for the capture, through its own unmuteable alert - never "Payment Failed".
      expect(mockClaimAlertCooldown).toHaveBeenCalledWith(expect.objectContaining({ key: "late-capture-refunded-outside-app:pi_late" }));
      expect(mockSendAdminLateCaptureRefundedOutsideAppAlert).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_late", refundedCents: 3800, bookingId: "booking-3" }),
        expect.anything(),
      );
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
    });

    it("#4312 review: still names a late capture refunded outside the app when the sync recorded it first but the total did not move", async () => {
      refundEvent([{ id: "re_dashboard", amount: 3800, status: "succeeded", metadata: {} }], "cancelled_booking_late_capture");
      mockSyncRefundsFromStripeCharge.mockResolvedValue({
        paymentId: "payment-3",
        refundDeltaCents: 0,
        newlyCountedRefundIds: ["re_dashboard"],
        payment: { id: "payment-3", amountCents: 24000, refundedAmountCents: 3800 },
      });

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "booking.payment.late_capture_refunded_outside_app" }));
    });

    it("counts a cancel claim on the intent as landed after the cancel: a dashboard refund before the late success notice", async () => {
      refundEvent([{ id: "re_dashboard", amount: 3800, status: "succeeded", metadata: {} }]);
      mockPaymentRecoveryOperationFindFirst.mockResolvedValue({ id: "recovery-cancel-3" });

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking.payment.late_capture_refunded_outside_app", entityId: "booking-3" }),
      );
    });

    it("waits for the record, naming nothing, for the repair tool's own late-capture refund", async () => {
      refundEvent(
        [{ id: "re_repair", amount: 3800, status: "succeeded", metadata: { bookingId: "booking-3", reason: "cancelled_booking_late_capture_repair" } }],
        "cancelled_booking_late_capture",
      );

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking.payment.late_capture_refunded_outside_app" }),
      );
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(mockSendAdminLateCaptureRefundedOutsideAppAlert).not.toHaveBeenCalled();
    });

    it("still queues the generic note for an ordinary refund on the same cancelled booking", async () => {
      refundEvent([{ id: "re_cancel", amount: 3800, status: "succeeded", metadata: { bookingId: "booking-3", reason: "booking_cancellation" } }]);

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith("payment-3", 3800);
    });
  });

  it("marks canceled additional payment intents as failed when Stripe sends payment_intent.canceled", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_canceled_additional",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_additional_canceled",
          amount: 2500,
          cancellation_reason: "requested_by_customer",
          metadata: {
            bookingId: "booking-4",
            type: "modification_additional",
          },
        },
      },
    } as any);

    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "txn-4",
      paymentId: "payment-4",
      kind: "ADDITIONAL",
      amountCents: 2500,
      status: "PENDING",
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_additional_canceled",
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: "booking.modification.payment.canceled",
      category: "payment",
      entityType: "Booking",
      entityId: "booking-4",
      targetId: "booking-4",
      details: JSON.stringify({
        paymentIntentId: "pi_additional_canceled",
        amountCents: 2500,
        cancellationReason: "requested_by_customer",
      }),
    });
  });

  it("completes superseded cancellation recovery when Stripe sends payment_intent.canceled", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_canceled_superseded",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_superseded_canceled",
          amount: 6000,
          cancellation_reason: "requested_by_customer",
          metadata: {
            bookingId: "booking-5",
          },
        },
      },
    } as any);
    mockCompleteCanceledSupersededPaymentIntentRecovery.mockResolvedValue(true);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockCompleteCanceledSupersededPaymentIntentRecovery).toHaveBeenCalledWith({
      paymentIntentId: "pi_superseded_canceled",
    });
    expect(mockFindPaymentTransactionByIntentId).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
  });

  it("queues refund recovery instead of confirming a superseded succeeded PaymentIntent", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_succeeded_superseded",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_superseded_succeeded",
          amount: 6000,
          payment_method: "pm_superseded",
          metadata: {
            bookingId: "booking-5",
          },
        },
      },
    } as any);
    mockQueueSupersededPaymentIntentRefundRecovery.mockResolvedValue(true);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    // #4300: the check takes the intent itself.
    expect(mockQueueSupersededPaymentIntentRefundRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pi_superseded_succeeded", amount: 6000, payment_method: "pm_superseded" }),
    );
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("ignores stale failed intents when no current payment transaction matches the webhook intent", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_failed_stale",
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_stale_failed",
          amount: 2500,
          metadata: {
            bookingId: "booking-5",
          },
          last_payment_error: {
            message: "Card declined",
          },
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  describe("a saved-card charge attempt whose POST answer was lost is adopted by the event's idempotency key (#3267, INV-PAY-055)", () => {
    const ATTEMPT_KEY = "pending_charge_booking-1_txn_attempt_1";
    const paidBooking = {
      id: "booking-1",
      status: "CONFIRMED",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      finalPriceCents: 5000,
      discountCents: 0,
      guests: [{ id: "g1" }],
      member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
      promoRedemption: null,
    };

    it("payment_intent.succeeded for an unknown intent: the PENDING no-intent attempt row carrying the event's key is stamped SUCCEEDED (forward only), reconciled, and the booking is settled with it", async () => {
      mockConstructWebhookEvent.mockReturnValue({
        id: "evt_lost_response",
        type: "payment_intent.succeeded",
        // Stripe stamps the originating request's idempotency key on the event.
        request: { id: "req_1", idempotency_key: ATTEMPT_KEY },
        data: {
          object: {
            id: "pi_lost",
            status: "succeeded",
            amount: 5000,
            metadata: { bookingId: "booking-1" },
            payment_method: "pm_123",
          },
        },
      } as any);
      mockPaymentTransactionFindFirst.mockResolvedValue({ id: "txn_attempt_1", paymentId: "payment-1" });
      // Unknown by intent id before adoption, found by it after.
      mockFindPaymentTransactionByIntentId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "txn_attempt_1",
          paymentId: "payment-1",
          kind: "PRIMARY",
          amountCents: 5000,
          status: "SUCCEEDED",
        });
      mockBookingFindUnique.mockResolvedValue(paidBooking);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockPaymentTransactionFindFirst).toHaveBeenCalledWith({
        where: {
          reference: ATTEMPT_KEY,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: null,
          status: { in: ["PENDING", "PROCESSING"] },
        },
        select: { id: true, paymentId: true },
      });
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { id: "txn_attempt_1", status: { notIn: ["REFUNDED", "PARTIALLY_REFUNDED"] } },
        data: { stripePaymentIntentId: "pi_lost", status: "SUCCEEDED", amountCents: 5000, paymentMethodId: "pm_123" },
      });
      expect(mockReconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: "payment-1", store: expect.anything() });
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith({
        format: CLUB_FORMAT_TEST,
        bookingId: "booking-1",
        paymentIntentId: "pi_lost",
        amountCents: 5000,
        paymentMethodId: "pm_123",
        // #4285 review: the adoption wrote the capture just now - new money, not a replay.
        recordedByCaller: true,
      });
    });

    it("payment_intent.payment_failed for an unknown intent: the attempt row is adopted and ends FAILED now, rather than sitting PENDING until its key expires", async () => {
      mockConstructWebhookEvent.mockReturnValue({
        id: "evt_lost_decline",
        type: "payment_intent.payment_failed",
        request: { id: "req_2", idempotency_key: ATTEMPT_KEY },
        data: {
          object: {
            id: "pi_lost_declined",
            status: "requires_payment_method",
            amount: 5000,
            metadata: { bookingId: "booking-1" },
            payment_method: "pm_123",
            last_payment_error: { message: "Card declined" },
          },
        },
      } as any);
      mockPaymentTransactionFindFirst.mockResolvedValue({ id: "txn_attempt_1", paymentId: "payment-1" });
      mockFindPaymentTransactionByIntentId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "txn_attempt_1", paymentId: "payment-1", kind: "PRIMARY", amountCents: 5000, status: "FAILED" });
      mockBookingFindUnique.mockResolvedValue(paidBooking);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
        where: { id: "txn_attempt_1", status: { in: ["PENDING", "PROCESSING"] } },
        data: { stripePaymentIntentId: "pi_lost_declined", status: "FAILED", amountCents: 5000, paymentMethodId: "pm_123" },
      });
      expect(mockMarkPaymentIntentTransactionFailed).toHaveBeenCalledWith({ paymentIntentId: "pi_lost_declined" });
      expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    });

    it("an unknown intent whose event carries no idempotency key, or a key that is not an attempt's, is still ignored as before", async () => {
      mockConstructWebhookEvent.mockReturnValue({
        id: "evt_unknown_no_key",
        type: "payment_intent.succeeded",
        request: { id: "req_3", idempotency_key: "late_cancel_refund_booking-1_pi_x" },
        data: {
          object: { id: "pi_unknown", status: "succeeded", amount: 5000, metadata: { bookingId: "booking-1" }, payment_method: "pm_123" },
        },
      } as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockPaymentTransactionFindFirst).not.toHaveBeenCalled();
      expect(mockPaymentTransactionUpdateMany).not.toHaveBeenCalled();
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    });

    it("adopts only a row whose key was built from ITS OWN id for THIS booking: a matching reference on a row whose id disagrees is left alone", async () => {
      mockConstructWebhookEvent.mockReturnValue({
        id: "evt_wrong_row",
        type: "payment_intent.succeeded",
        request: { id: "req_4", idempotency_key: ATTEMPT_KEY },
        data: {
          object: { id: "pi_lost", status: "succeeded", amount: 5000, metadata: { bookingId: "booking-1" }, payment_method: "pm_123" },
        },
      } as any);
      mockPaymentTransactionFindFirst.mockResolvedValue({ id: "txn_somebody_else", paymentId: "payment-9" });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockPaymentTransactionUpdateMany).not.toHaveBeenCalled();
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    });
  });

  it("ignores stale canceled intents when no current payment transaction matches the webhook intent", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_canceled_stale",
      type: "payment_intent.canceled",
      data: {
        object: {
          id: "pi_stale_canceled",
          amount: 2500,
          cancellation_reason: "abandoned",
          metadata: {
            bookingId: "booking-6",
          },
        },
      },
    } as any);

    mockPaymentFindUnique.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("does not queue a new Xero refund credit note when Stripe repeats the same cumulative refund total", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_refund_repeat",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_refund_repeat",
          payment_intent: "pi_refund_repeat",
          amount_refunded: 5000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_refund_repeat",
        amount: 5000,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000000,
        charge: "ch_refund_repeat",
        payment_intent: "pi_refund_repeat",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-4",
      refundDeltaCents: 0,
      newlyCountedRefundIds: [], // #4312: what the real sync returns beside the delta
      payment: {
        id: "payment-4",
        amountCents: 5000,
        refundedAmountCents: 5000,
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockSyncRefundsFromStripeCharge).toHaveBeenCalledWith({
      paymentIntentId: "pi_refund_repeat",
      stripeChargeId: "ch_refund_repeat",
      refundedAmountCents: 5000,
      refunds,
    });
    expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("does not enqueue a Xero credit note when a recovery-driven refund's webhook arrives after the ledger is already up to date", async () => {
    // Scenario: the payment recovery worker called refundPaymentTransactions,
    // which recorded the Stripe refund ledger entry and updated the
    // PaymentTransaction.refundedAmountCents. The charge.refunded webhook
    // arrives afterwards; syncRefundsFromStripeCharge sees the cumulative
    // total matches the ledger and returns refundDeltaCents=0. The handler
    // must not enqueue a duplicate Xero credit note.
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_recovery_refund_webhook",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_recovery_refund",
          payment_intent: "pi_recovery_refund",
          amount_refunded: 4000,
        },
      },
    } as any);

    const refunds = [
      {
        id: "re_recovery",
        amount: 4000,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: 1770000001,
        charge: "ch_recovery_refund",
        payment_intent: "pi_recovery_refund",
      },
    ];
    mockListRefundsForCharge.mockResolvedValue(refunds);
    mockSyncRefundsFromStripeCharge.mockResolvedValue({
      paymentId: "payment-recovery",
      refundDeltaCents: 0,
      newlyCountedRefundIds: [], // #4312: what the real sync returns beside the delta
      payment: {
        id: "payment-recovery",
        amountCents: 4000,
        refundedAmountCents: 4000,
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });

  it("logs payment_intent.requires_action as an observability event without mutating state", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_requires_action",
      type: "payment_intent.requires_action",
      data: {
        object: {
          id: "pi_requires_action",
          amount: 6000,
          metadata: { bookingId: "booking-3ds" },
          next_action: { type: "use_stripe_sdk" },
        },
      },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue({
      id: "ptx_3ds",
      kind: "ADDITIONAL",
      paymentId: "pay_3ds",
      status: "PENDING",
      createdAt: new Date(),
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockFindPaymentTransactionByIntentId).toHaveBeenCalledWith({
      paymentIntentId: "pi_requires_action",
    });
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
  });

  it("logs payment_intent.processing as an observability event without mutating state", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_processing",
      type: "payment_intent.processing",
      data: {
        object: {
          id: "pi_processing",
          amount: 6000,
          metadata: { bookingId: "booking-bank-debit" },
        },
      },
    } as any);
    mockFindPaymentTransactionByIntentId.mockResolvedValue(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockFindPaymentTransactionByIntentId).toHaveBeenCalledWith({
      paymentIntentId: "pi_processing",
    });
    expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
    expect(mockMarkPaymentIntentTransactionFailed).not.toHaveBeenCalled();
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
  });

  // Issue #815 / #814(#6): duplicate Stripe delivery must be a no-op. The
  // ProcessedWebhookEvent claim is the idempotency boundary; when the claim
  // already exists (P2002) the handler chain must not run again.
  it("short-circuits a duplicate Stripe event without re-running handlers", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_dup",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_dup",
          amount: 5000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);
    // The event was already processed: claiming it hits the unique constraint.
    mockProcessedWebhookCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    // F16 (#1887): the existing claim is COMPLETED, so the redelivery is a true
    // duplicate and short-circuits with 200.
    mockProcessedWebhookFindFirst.mockResolvedValue({
      status: "COMPLETED",
      processingStartedAt: new Date("2020-01-01T00:00:00.000Z"),
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });

    // Issue #815: the claim is scoped to the stripe source so the composite
    // (source, eventId) idempotency key is always fully populated and a Stripe
    // event ID can never collide with a Xero/SES event that shares the same id.
    // F16 (#1887): the claim now also carries the lease fields.
    expect(mockProcessedWebhookCreate).toHaveBeenCalledWith({
      data: {
        eventId: "evt_dup",
        source: "stripe",
        eventType: "payment_intent.succeeded",
        status: "PROCESSING",
        processingStartedAt: expect.any(Date),
      },
    });

    // No downstream payment, booking, Xero, recovery, or email side effects.
    expect(mockQueueSupersededPaymentIntentRefundRecovery).not.toHaveBeenCalled();
    expect(mockFindPaymentTransactionByIntentId).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
    expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();

    // The existing claim is left intact (it belongs to the first delivery) and
    // the early return happens before the success webhook log is recorded.
    expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
    expect(mockRecordWebhookLog).not.toHaveBeenCalled();
  });

  // Issue #815: when a handler fails after the event was claimed, the claim
  // must be released so Stripe's automatic retry can reprocess the event.
  it("releases the processed-event claim when a handler throws so retries work", async () => {
    mockConstructWebhookEvent.mockReturnValue({
      id: "evt_fail",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_fail",
          amount: 5000,
          metadata: { bookingId: "booking-1" },
          payment_method: "pm_123",
        },
      },
    } as any);
    mockProcessedWebhookCreate.mockResolvedValue({}); // claim succeeds
    // Force the handler to throw after the claim is taken.
    mockFindPaymentTransactionByIntentId.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    // F16 fence (#1887): the release is keyed on status + the claimed lease token.
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "evt_fail",
        source: "stripe",
        status: "PROCESSING",
        processingStartedAt: expect.any(Date),
      },
    });
  });

  // Issue #1016: a captured group-settlement intent that matches no PENDING
  // settlement is a superseded intent confirmed off a retained client_secret.
  function groupSettlementSucceededEvent(eventId: string, intentId: string) {
    return {
      id: eventId,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: intentId,
          amount: 50000,
          payment_method: "pm_group",
          metadata: { type: "group_settlement", groupBookingId: "group-1" },
        },
      },
    } as any;
  }

  it("refunds and alerts exactly once when a succeeded group settlement intent matches no settlement", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_orphan", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    mockGroupBookingFindUnique.mockResolvedValue({
      organiserMember: { firstName: "Olive", lastName: "Organiser" },
      organiserBooking: {
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
      },
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockApplyGroupSettlementSucceeded).toHaveBeenCalledWith({
      id: "pi_group_stale",
      amount: 50000,
    }, CLUB_FORMAT_TEST);
    // Full refund with a deterministic per-intent idempotency key.
    expect(mockProcessRefund).toHaveBeenCalledTimes(1);
    expect(mockProcessRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_group_stale",
      amountCents: 50000,
      reason: "requested_by_customer",
      metadata: {
        groupBookingId: "group-1",
        reason: "group_settlement_superseded",
      },
      idempotencyKey: "group_settlement_superseded_refund_pi_group_stale",
    });
    // One admin alert naming the organiser.
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Olive Organiser",
        amountCents: 50000,
        paymentIntentId: "pi_group_stale",
      }),
      CLUB_FORMAT_TEST,
    );
    // The group path never falls through to the per-booking handlers.
    expect(mockQueueSupersededPaymentIntentRefundRecovery).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("refunds and alerts exactly once when a succeeded group settlement intent mismatches the recorded amount", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_mismatch", "pi_group_mismatch"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "amount_mismatch",
      settledBookingIds: [],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).toHaveBeenCalledTimes(1);
    expect(mockProcessRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_group_mismatch",
        amountCents: 50000,
        idempotencyKey: "group_settlement_superseded_refund_pi_group_mismatch",
      }),
    );
    // The alert still sends when the group cannot be loaded for details.
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("auto-refunds a late capture rejected by the durable group-cancel fence (#1881)", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_cancelled", "pi_group_cancelled"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "cancelled",
      settledBookingIds: [],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_group_cancelled",
        amountCents: 50000,
        idempotencyKey:
          "group_settlement_superseded_refund_pi_group_cancelled",
      }),
    );
    expect(mockMarkGroupSettlementIntentRefunded).toHaveBeenCalledWith(
      "pi_group_cancelled"
    );
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  // #4103 (`INV-PAY-130`): Stripe answers the refund `failed` or `canceled`
  // without throwing. Nothing went back: the settlement is never marked
  // REFUNDED, the alert says the refund failed, and the webhook fails so Stripe
  // redelivers, exactly as for a thrown refund.
  it.each([["failed"], ["canceled"]])("a refund Stripe answers %s is a failure: alerted as failed, never marked refunded (#4103)", async (status) => {
    mockConstructWebhookEvent.mockReturnValue(groupSettlementSucceededEvent(`evt_group_refused_${status}`, "pi_group_mismatch"));
    mockApplyGroupSettlementSucceeded.mockResolvedValue({ outcome: "amount_mismatch", settledBookingIds: [] });
    mockProcessRefund.mockResolvedValueOnce({ id: "re_refused", status });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(mockMarkGroupSettlementIntentRefunded).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("the automatic refund failed") }),
      CLUB_FORMAT_TEST,
    );
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "group.settlement.superseded_intent_refunded" }),
    );
  });

  // #4103 review C3/(d): the redelivery after a refusal asks on a key Stripe
  // has never seen (its 24-hour cache would answer the old one with the same
  // refusal), and a refusal again is not alerted twice.
  it("a redelivery after a refusal asks on a fresh key, and is not alerted again when refused again (#4103)", async () => {
    mockConstructWebhookEvent.mockReturnValue(groupSettlementSucceededEvent("evt_group_refused_again", "pi_group_mismatch"));
    mockApplyGroupSettlementSucceeded.mockResolvedValue({ outcome: "amount_mismatch", settledBookingIds: [] });
    mockListRefundsForPaymentIntent.mockResolvedValueOnce([
      { id: "re_refused", status: "failed", amount: 50000, metadata: { groupBookingId: "group-1", reason: "group_settlement_superseded" } },
    ]);
    mockProcessRefund.mockResolvedValueOnce({ id: "re_refused_again", status: "failed" });

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    expect(mockProcessRefund).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "group_settlement_superseded_refund_pi_group_mismatch_refused1" }),
    );
    expect(mockMarkGroupSettlementIntentRefunded).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("does not refund or alert when the group settlement applies cleanly", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_ok", "pi_group_ok"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "settled",
      settledBookingIds: ["child-1"],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("short-circuits a redelivered group settlement event without refunding or alerting again", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_dup", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    // The first delivery already claimed and processed this event.
    mockProcessedWebhookCreate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockApplyGroupSettlementSucceeded).not.toHaveBeenCalled();
    expect(mockProcessRefund).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  // #1883 (F6) — the auto-refund must also mark the settlement row, or the
  // refunded intent (which stays "succeeded" in Stripe forever) can be
  // re-admitted later and settle the children with money already handed back.
  it("marks the settlement refunded after the auto-refund closes it out (#1883)", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_mark", "pi_group_mismatch"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "amount_mismatch",
      settledBookingIds: [],
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(mockProcessRefund).toHaveBeenCalledTimes(1);
    expect(mockMarkGroupSettlementIntentRefunded).toHaveBeenCalledTimes(1);
    expect(mockMarkGroupSettlementIntentRefunded).toHaveBeenCalledWith(
      "pi_group_mismatch",
    );
    // The mark happens only once the money is actually back with the organiser.
    expect(
      mockMarkGroupSettlementIntentRefunded.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mockProcessRefund.mock.invocationCallOrder[0]);
  });

  it("does not mark the settlement refunded when the refund itself fails (#1883)", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_mark_fail", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    mockProcessRefund.mockRejectedValue(new Error("stripe unavailable"));

    const response = await POST(makeRequest());

    // No refund happened, so the settlement must stay untouched; the released
    // claim lets Stripe redeliver and retry the refund + mark together.
    expect(response.status).toBe(500);
    expect(mockMarkGroupSettlementIntentRefunded).not.toHaveBeenCalled();
  });

  it("alerts, releases the claim, and returns 500 when the group settlement refund fails", async () => {
    mockConstructWebhookEvent.mockReturnValue(
      groupSettlementSucceededEvent("evt_group_refund_fail", "pi_group_stale"),
    );
    mockApplyGroupSettlementSucceeded.mockResolvedValue({
      outcome: "not_found",
      settledBookingIds: [],
    });
    mockProcessRefund.mockRejectedValue(new Error("stripe unavailable"));

    const response = await POST(makeRequest());

    // The failure alert still reaches admins, and the released claim lets
    // Stripe's redelivery retry the refund (idempotency key stops doubles).
    expect(response.status).toBe(500);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.stringContaining("automatic refund failed"),
      }),
      CLUB_FORMAT_TEST,
    );
    // F16 fence (#1887): release keyed on status + the claimed lease token.
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
      where: {
        eventId: "evt_group_refund_fail",
        source: "stripe",
        status: "PROCESSING",
        processingStartedAt: expect.any(Date),
      },
    });
  });

  // ---------------------------------------------------------------------------
  // F1 (#1350): a late Stripe capture of an ADDITIONAL modification payment on
  // a CANCELLED booking must be refunded + alerted, never recorded as paid,
  // and the supplementary Xero invoice must never be released.
  // ---------------------------------------------------------------------------
  describe("late additional capture on a cancelled booking (#1350)", () => {
    function additionalSucceededEvent(id = "evt_add_cancelled") {
      return {
        id,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_additional_late",
            amount: 2500,
            payment_method: "pm_late",
            metadata: {
              bookingId: "booking-9",
              type: "modification_additional",
            },
          },
        },
      } as any;
    }

    /**
     * #2760: `deletedAt` is now part of what this handler reads, because the
     * record and the alert both name which population the capture belonged to.
     * Defaults to the DELETED population — a soft-deleted booking is always
     * CANCELLED (`INV-ADDPAY-030`), which is the case #2700 and #2750 were about —
     * and the merely-cancelled population passes `deletedAt: null` explicitly.
     */
    function armCancelledBooking(
      xeroInvoiceId: string | null = null,
      deletedAt: Date | null = new Date("2026-06-20"),
    ) {
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-9",
        status: "CANCELLED",
        deletedAt,
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        member: { firstName: "Alice", lastName: "Example" },
        payment: { id: "payment-9", xeroInvoiceId },
      });
    }

    it("refunds and alerts instead of recording the capture and releasing the supplementary invoice", async () => {
      mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent());
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        // The cancel claim marked it FAILED — exactly the state the old code
        // flipped straight to SUCCEEDED and released the invoice for.
        status: "FAILED",
      });
      armCancelledBooking();
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [
          { paymentIntentId: "pi_additional_late", refundId: "re_late_9", amountCents: 2500 },
        ],
        totalRefundedAmountCents: 2500,
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The capture is recorded truthfully, then refunded in full under the
      // idempotent late-cancel key pinned to this transaction.
      expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith({
        paymentIntentId: "pi_additional_late",
        amountCents: 2500,
        paymentMethodId: "pm_late",
      });
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith({
        format: CLUB_FORMAT_TEST,
        paymentId: "payment-9",
        amountCents: 2500,
        allocation: [{ paymentTransactionId: "txn-9", amountCents: 2500 }],
        metadata: {
          bookingId: "booking-9",
          reason: "cancelled_booking_late_capture",
        },
        idempotencyKeyPrefix: "late_cancel_refund_booking-9_pi_additional_late",
      });
      // #2761: its own alert, not the generic "Payment Failed" mail. Exactly one
      // notification for the event — the old sender is not called on this path at
      // all.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 2500,
          paymentIntentId: "pi_additional_late",
          bookingId: "booking-9",
          bookingDeleted: true,
        }),
        CLUB_FORMAT_TEST,
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
          targetId: "booking-9",
          category: "payment",
          details: JSON.stringify({
            paymentIntentId: "pi_additional_late",
            refundId: "re_late_9",
            amountCents: 2500,
            kind: "modification_additional",
          }),
        }),
      );
      // The supplementary Xero invoice is NEVER released on this path.
      expect(
        mockReleaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
      ).not.toHaveBeenCalled();
      // No Xero presence -> no corrective credit note.
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    /**
     * #2700 — this pre-existing #1350 path is the reason the deleted-booking
     * ManualRefundTask needs closing rather than leaving OPEN.
     *
     * A soft-deleted booking is ALWAYS CANCELLED (`INV-ADDPAY-030`), so every
     * deleted booking reaches the branch above. If the browser confirm won the
     * race first, it recorded the capture and raised an OPEN task asking a human
     * to decide whether to refund. The refund this handler has just issued
     * answers that question, and an operator who then COMPLETES the task would
     * write a SECOND refund allocation through `resolveManualRefundTask` and
     * double-count one refund in the ledger.
     *
     * MUTATION PROOF: delete the close call from
     * `handleCancelledBookingAdditionalPaymentSucceeded` and this fails by name.
     */
    it("records the automatic refund after refunding, with the amount and the population (#2700 / #2760)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_task_close"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith({
        bookingId: "booking-9",
        paymentId: "payment-9",
        paymentIntentId: "pi_additional_late",
        // #2760: the captured cents, so the row the webhook may have to CREATE
        // states the amount that went back. Integer cents, straight from the
        // intent — nothing recomputes a refund.
        amountCents: 2500,
        bookingDeleted: true,
        // #2773: which sentence the row stores. This handler is the
        // booking-CHANGE one, and the sibling passes "primary" — asserted here
        // exactly rather than loosely, because the reason is operator-facing text
        // on the finance card and a wrong kind prints a false sentence.
        captureKind: "modification",
      });
      // Recorded AFTER the money actually went back, never before.
      expect(
        mockRefundPaymentTransactions.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockRecordAutomaticCancelledBookingRefundTask.mock
          .invocationCallOrder[0],
      );
    });

    it("records and alerts the cancelled-but-not-deleted population too (#2760)", async () => {
      /*
        The population the owner widened this to, deliberately over the narrower
        recommendation. #1350's refund fires on `status === "CANCELLED"`, not on
        `deletedAt`, so this capture was already being auto-refunded — it simply
        left no operator record anywhere, because the confirm route's raise is
        gated on `deletedAt`.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_live_booking"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking(null, null);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: false, amountCents: 2500 }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: false }),
        CLUB_FORMAT_TEST,
      );
      // The refund itself is unchanged by the population.
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: "payment-9",
          amountCents: 2500,
          idempotencyKeyPrefix:
            "late_cancel_refund_booking-9_pi_additional_late",
        }),
      );
    });

    it("answers 500 when recording that task fails, so Stripe redelivers and the redelivery writes it (#4149)", async () => {
      // The money is already back with the member. A 500 no longer replays the
      // refund path: since #3639 a replay after a refund never refunds again,
      // and since #4149 it writes the lost record instead.
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_task_close_fails"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(
        new Error("database is down"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
    });

    it("writes a CRITICAL audit row when the record write fails, and still writes the refund entry and sends the alert before the 500 (#4149)", async () => {
      /*
        THE BLOCKER THIS PINS (review of #2760). A container log is not a record,
        so the loss surfaces on the audit log the finance card names as permanent:
        `critical` severity, `outcome: "failure"`, carrying the booking and the
        payment intent. #4149: the refund entry (marked `recordLost`) and the one
        alert still go out from this delivery - the money DID go back and the
        event must never get neither (`INV-ADDPAY-037`) - and only then does the
        webhook answer 500, so Stripe redelivers and the redelivery writes the
        missing row, with no second alert.

        Mutation proof: delete the `logAudit` call in the catch and this fails while
        every other test in the file still passes.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_record_fails_audited"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [{ paymentIntentId: "pi_additional_late", refundId: "re_late_9", amountCents: 2500 }],
        totalRefundedAmountCents: 2500,
      });
      mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(
        new Error("could not serialize access due to concurrent update"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.auto_refund_record_failed",
          category: "payment",
          severity: "critical",
          outcome: "failure",
          entityType: "Booking",
          entityId: "booking-9",
        }),
      );
      const failureRow = mockLogAudit.mock.calls
        .map(([params]) => params as { action: string; details?: string })
        .find(
          (params) =>
            params.action === "booking.payment.auto_refund_record_failed",
        );
      expect(failureRow?.details).toBeDefined();
      expect(JSON.parse(failureRow?.details ?? "{}")).toMatchObject({
        paymentIntentId: "pi_additional_late",
        amountCents: 2500,
      });
      const refundRow = mockLogAudit.mock.calls
        .map(([params]) => params as { action: string; details?: string })
        .find((params) => params.action === "booking.payment.refunded_after_cancellation");
      expect(JSON.parse(refundRow?.details ?? "{}")).toMatchObject({
        paymentIntentId: "pi_additional_late",
        refundId: "re_late_9",
        recordLost: true,
      });
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
    });

    describe("a delivery that dies between the refund and its record (#4149)", () => {
      const LATE_CAPTURE_REFUND = {
        id: "re_late_9",
        amount: 2500,
        status: "succeeded",
        created: Math.floor(Date.parse("2026-06-25T03:00:00.000Z") / 1000),
        metadata: { bookingId: "booking-9", reason: "cancelled_booking_late_capture" },
      };
      const entriesOf = (action: string) =>
        mockLogAudit.mock.calls
          .map(([entry]) => entry as { action: string; details?: string })
          .filter((entry) => entry.action === action)
          .map((entry) => JSON.parse(entry.details ?? "{}") as Record<string, unknown>);
      const refundEntries = () => entriesOf("booking.payment.refunded_after_cancellation");
      const recoveredEntries = () => entriesOf("booking.payment.auto_refund_record_recovered");

      /** The first delivery: the refund goes out and is recorded, then the record write is killed. */
      async function deliverAndLoseTheRecord() {
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_record_lost"));
        mockFindPaymentTransactionByIntentId.mockResolvedValue({
          id: "txn-9",
          paymentId: "payment-9",
          kind: "ADDITIONAL",
          amountCents: 2500,
          status: "FAILED",
        });
        armCancelledBooking();
        mockRefundPaymentTransactions.mockResolvedValue({
          refunds: [{ paymentIntentId: "pi_additional_late", refundId: "re_late_9", amountCents: 2500 }],
          totalRefundedAmountCents: 2500,
        });
        mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(new Error("killed between the refund and the record"));
        const response = await POST(makeRequest());
        expect(response.status).toBe(500);
      }

      /** What Stripe's redelivery finds: the capture refunded in the ledger, its record row missing. */
      function armRedelivery(stripeRefunds: unknown[] = [LATE_CAPTURE_REFUND]) {
        mockFindPaymentTransactionByIntentId.mockResolvedValue({
          id: "txn-9",
          paymentId: "payment-9",
          kind: "ADDITIONAL",
          amountCents: 2500,
          refundedAmountCents: 2500,
          status: "REFUNDED",
          reason: "date_change",
        });
        // The cancel's claim on the change intent: the capture landed after it.
        mockPaymentRecoveryOperationFindFirst.mockResolvedValue({ id: "recovery-cancel-9" });
        mockListRefundsForPaymentIntent.mockResolvedValue(stripeRefunds);
      }

      it("is redelivered and recorded exactly once: the refunding delivery's entry and alert, then the row, its recovered entry and the alert again", async () => {
        await deliverAndLoseTheRecord();
        armRedelivery();

        const redelivered = await POST(makeRequest());

        expect(redelivered.status).toBe(200);
        // The money moved once; the redelivery only writes the record.
        expect(mockRefundPaymentTransactions).toHaveBeenCalledTimes(1);
        // A bounded read, never retried, on the webhook path.
        expect(mockListRefundsForPaymentIntent).toHaveBeenCalledWith("pi_additional_late", { timeoutMs: 5_000 });
        // The killed write and the one that landed, dated the refund's day.
        expect(mockRecordAutomaticCancelledBookingRefundTask).toHaveBeenCalledTimes(2);
        expect(mockRecordAutomaticCancelledBookingRefundTask).toHaveBeenLastCalledWith(
          expect.objectContaining({
            paymentIntentId: "pi_additional_late",
            amountCents: 2500,
            captureKind: "modification",
            completedAt: new Date("2026-06-25T03:00:00.000Z"),
          }),
        );
        // One refund entry - the refunding delivery's. Its alert read its
        // recipients from the database that had just failed, so the recovery
        // sends it again: a duplicate, never a silence (#2761).
        expect(refundEntries()).toEqual([expect.objectContaining({ refundId: "re_late_9", recordLost: true })]);
        expect(recoveredEntries()).toEqual([
          expect.objectContaining({
            paymentIntentId: "pi_additional_late",
            refundId: "re_late_9",
            refundTimeReport: "record_lost",
            alertSent: true,
          }),
        ]);
        expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(2);
        // It is the record, not an acknowledgement of a settled notice.
        expect(mockLogAudit).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "booking.payment.late_notice_acknowledged" }),
        );
      });

      it("writes the refund entry and sends the alert itself when the delivery that refunded died before either", async () => {
        armCancelledBooking();
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_after_crash"));
        armRedelivery();

        expect((await POST(makeRequest())).status).toBe(200);

        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
        expect(recoveredEntries()).toEqual([expect.objectContaining({ refundTimeReport: "none", alertSent: true })]);
        expect(refundEntries()).toEqual([
          expect.objectContaining({ refundId: "re_late_9", kind: "modification_additional", recoveredLostRecord: true }),
        ]);
        expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
      });

      it("closes a confirm route's OPEN task the refund never closed, rather than leaving it asking a person to repay money Stripe returned", async () => {
        armCancelledBooking();
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_open_task"));
        armRedelivery();
        // The OPEN #2700 row marks a known late capture, but it is not a record.
        mockFindLateCapturePaymentIntents.mockImplementation(async () => new Set(["pi_additional_late"]));
        mockRecordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
          closed: 1,
          created: false,
          alreadyRecorded: false,
          existingStatus: null,
        });

        expect((await POST(makeRequest())).status).toBe(200);

        expect(mockRecordAutomaticCancelledBookingRefundTask).toHaveBeenCalledTimes(1);
        expect(recoveredEntries()).toHaveLength(1);
      });

      it("writes no second entry or alert when another delivery's record landed first (a redelivery racing the original)", async () => {
        armCancelledBooking();
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_record_race"));
        armRedelivery();
        // The original delivery committed the row while this one was asking Stripe.
        mockRecordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
          closed: 0,
          created: false,
          alreadyRecorded: "self",
          existingStatus: "DISMISSED",
        });

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
        expect(refundEntries()).toHaveLength(0);
        expect(recoveredEntries()).toHaveLength(0);
        expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      });

      it("leaves a refund the late-capture door did not send (a Stripe dashboard refund) acknowledged, unrecorded", async () => {
        armCancelledBooking();
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_dashboard_refund"));
        armRedelivery([{ id: "re_dashboard", amount: 2500, status: "succeeded", created: 1, metadata: {} }]);

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
        expect(refundEntries()).toHaveLength(0);
        expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
        expect(mockLogAudit).toHaveBeenCalledWith(
          expect.objectContaining({ action: "booking.payment.late_notice_acknowledged" }),
        );
      });

      it("asks Stripe nothing and writes nothing when the capture already has its closed record", async () => {
        armCancelledBooking();
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_replay_recorded"));
        armRedelivery();
        mockFindClosedLateCaptureRecordIntents.mockImplementation(async () => new Map([["pi_additional_late", "record"]]));

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockListRefundsForPaymentIntent).not.toHaveBeenCalled();
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
        expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      });

      it("answers 500 when Stripe cannot say who refunded it, rather than acknowledging a capture whose record may be lost", async () => {
        armCancelledBooking();
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_stripe_down"));
        armRedelivery();
        mockListRefundsForPaymentIntent.mockRejectedValueOnce(new Error("Stripe is unreachable"));

        const response = await POST(makeRequest());

        expect(response.status).toBe(500);
        expect(mockLogAudit).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "booking.payment.late_notice_acknowledged" }),
        );
      });

      describe("a change payment the cancel left no claim on, so its refunded capture reads as settled by the cancellation", () => {
        function armSettledByCancellation(stripeRefunds: unknown[]) {
          armCancelledBooking();
          armRedelivery(stripeRefunds);
          // No cancel claim on the intent, and the change handler stamps no late
          // marker: nothing local says the capture landed after the cancel.
          mockPaymentRecoveryOperationFindFirst.mockResolvedValue(null);
          // The cancellation recorded a decision about the booking's money.
          mockBookingEventFindMany.mockResolvedValue([
            { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 100, settledAmountCents: 2500, retainedAmountCents: 0 } },
          ]);
        }

        it("still writes the lost record when Stripe's refund metadata says the late-capture door sent the refund", async () => {
          mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_settled_lost_record"));
          armSettledByCancellation([LATE_CAPTURE_REFUND]);

          expect((await POST(makeRequest())).status).toBe(200);

          expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
          expect(mockRecordAutomaticCancelledBookingRefundTask).toHaveBeenCalledWith(
            expect.objectContaining({ paymentIntentId: "pi_additional_late", captureKind: "modification" }),
          );
          expect(recoveredEntries()).toHaveLength(1);
          expect(mockLogAudit).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: "booking.payment.late_notice_acknowledged" }),
          );
        });

        it("never asks Stripe about an UNREFUNDED change capture the cancellation settled", async () => {
          mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_settled_unrefunded"));
          armSettledByCancellation([LATE_CAPTURE_REFUND]);
          mockFindPaymentTransactionByIntentId.mockResolvedValue({
            id: "txn-9",
            paymentId: "payment-9",
            kind: "ADDITIONAL",
            amountCents: 2500,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            reason: "date_change",
          });

          expect((await POST(makeRequest())).status).toBe(200);

          expect(mockListRefundsForPaymentIntent).not.toHaveBeenCalled();
          expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
          expect(mockLogAudit).toHaveBeenCalledWith(
            expect.objectContaining({
              action: "booking.payment.late_notice_acknowledged",
              details: expect.stringContaining('"verdict":"settled_by_cancellation"'),
            }),
          );
        });

        it("acknowledges it as settled, unrecorded, when the cancellation's own refund is all Stripe holds", async () => {
          mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_settled_by_cancel"));
          armSettledByCancellation([{ id: "re_cancel", amount: 2500, status: "succeeded", created: 1, metadata: { bookingId: "booking-9", reason: "booking_cancellation" } }]);

          expect((await POST(makeRequest())).status).toBe(200);

          expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
          expect(mockLogAudit).toHaveBeenCalledWith(
            expect.objectContaining({
              action: "booking.payment.late_notice_acknowledged",
              details: expect.stringContaining('"verdict":"settled_by_cancellation"'),
            }),
          );
        });
      });
    });

    it("re-reads deletedAt after the Stripe round trip, so a deletion mid-refund is not recorded as 'still on file'", async () => {
      /*
        The booking is loaded BEFORE `refundPaymentTransactions` makes a live
        Stripe round trip, and both the stored `reason` sentence and the alert's
        follow-up paragraph name which population the capture belonged to. An admin
        deleting the booking inside that window would otherwise store "cancelled,
        still on file" and mail "normally nothing to do" for precisely the case that
        needs a person — remake the booking and charge the member again. The confirm
        route re-reads the same flag after its own round trip for the same reason.

        Deletion is one-way (`INV-ADDPAY-030`), so the two reads can only disagree
        in one direction: the stale read can only ever UNDER-report a deletion.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_deleted_mid_refund"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      // Opening read: cancelled, not deleted. Re-read: deleted.
      mockBookingFindUnique
        .mockResolvedValueOnce({
          id: "booking-9",
          status: "CANCELLED",
          deletedAt: null,
          checkIn: new Date("2026-08-01"),
          checkOut: new Date("2026-08-03"),
          member: { firstName: "Alice", lastName: "Example" },
          payment: { id: "payment-9", xeroInvoiceId: null },
        })
        .mockResolvedValueOnce({ deletedAt: new Date("2026-07-30") });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The ROW stores the deleted population...
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-9", bookingDeleted: true }),
      );
      // ...and the MAIL says the same thing, so the stored reason, the alert and
      // the card's grouping (which reads current state) cannot disagree.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: true }),
        CLUB_FORMAT_TEST,
      );
    });

    it("does not flip an already-refunded transaction back on webhook replay, and still never releases the invoice", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_replay"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "REFUNDED",
      });
      armCancelledBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
      // #3639: the replay is ACKNOWLEDGED, not refunded again. Replaying the
      // identical keys only worked inside Stripe's 24-hour key window; after it,
      // a new refund of an already-refunded charge fails at Stripe and loops the
      // webhook. The acknowledgement is recorded where an officer can see it.
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_notice_acknowledged",
          entityId: "booking-9",
          details: expect.stringContaining('"verdict":"already_refunded"'),
        }),
      );
      expect(
        mockReleaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
      ).not.toHaveBeenCalled();
    });

    // #3639: the change-payment sibling asks the same question as the primary
    // handler. Its allocation is pinned to this transaction, so on a 0%- or
    // partial-tier cancel a delayed notice for a change payment captured before
    // the cancel WOULD refund money the cancellation kept.
    it("acknowledges a delayed notice for a change payment captured before a cancel that kept it (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_paid_then_cancelled"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "SUCCEEDED",
        reason: "date_change",
      });
      armCancelledBooking("xero-inv-9", null);
      mockBookingEventFindMany.mockResolvedValue([
        { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 0, settledAmountCents: 0 } },
      ]);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).not.toHaveBeenCalled();
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_notice_acknowledged",
          severity: "info",
          outcome: "blocked",
          details: expect.stringContaining('"verdict":"settled_by_cancellation"'),
        }),
      );
      // The intent-cancellation lookup is what tells a crash-retry apart.
      expect(mockPaymentRecoveryOperationFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            type: "CANCEL_PAYMENT_INTENT",
            paymentIntentId: "pi_additional_late",
          },
        }),
      );
    });

    it("still refunds a change payment the cancel recorded as outstanding, on a crash-and-retry of its own write (#3639)", async () => {
      /*
        The cancel's claim found the change payment outstanding and enqueued its
        CANCEL_PAYMENT_INTENT recovery. This handler marked the row SUCCEEDED and
        died before refunding. The booking has a paid-path snapshot too, so only
        that recovery row says the capture came after the cancel.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_late_retry"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "SUCCEEDED",
        reason: "date_change",
      });
      armCancelledBooking(null, null);
      mockBookingEventFindMany.mockResolvedValue([
        { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 50, settledAmountCents: 1250 } },
      ]);
      // The superseded hand-off already ran and completed its cancel op, which
      // is the only way the late handler sees this intent.
      mockPaymentRecoveryOperationFindFirst.mockResolvedValue({
        id: "recovery-cancel-9",
        status: "SUCCEEDED",
      });
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [
          { paymentIntentId: "pi_additional_late", refundId: "re_late_9", amountCents: 2500 },
        ],
        totalRefundedAmountCents: 2500,
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 2500,
          idempotencyKeyPrefix: "late_cancel_refund_booking-9_pi_additional_late",
        }),
      );
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_notice_acknowledged",
        }),
      );
    });


    it("hands a change payment with a live cancel op to the superseded refund, never the late handler (#3639 review F1)", async () => {
      // The cancel's claim enqueued CANCEL_PAYMENT_INTENT and it has not run.
      // Whether that hand-off refunds or holds for a treasurer is the
      // payment-recovery module's (`payment-recovery.test.ts`); here, only that
      // the late handler is not reached and moves nothing itself.
      mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_live_op"));
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking(null, null);
      mockPaymentRecoveryOperationFindFirst.mockResolvedValue({
        id: "recovery-cancel-9",
        status: "PENDING",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockQueueSupersededPaymentIntentRefundRecovery).toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockManualRefundTaskCreate).not.toHaveBeenCalled();
    });

    it("acknowledges a refunded change payment a browser confirm rewrote to SUCCEEDED, instead of looping on a second refund (#3639 review F3)", async () => {
      // The webhook refunded it; the confirm route finished late and wrote
      // SUCCEEDED over REFUNDED, leaving the refunded total alone. A redelivery
      // past Stripe's 24h key window must not try to refund it again.
      mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent("evt_add_rewritten"));
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        refundedAmountCents: 2500,
        status: "SUCCEEDED",
        reason: "date_change",
      });
      armCancelledBooking(null, null);
      mockPaymentRecoveryOperationFindFirst.mockResolvedValue({
        id: "recovery-cancel-9",
        status: "SUCCEEDED",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockMarkPaymentIntentTransactionSucceeded).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_notice_acknowledged",
          details: expect.stringContaining('"verdict":"already_refunded"'),
        }),
      );
    });

    describe("when the club has a treasurer approve these refunds (#3639, owner decision 26 Sep 2026)", () => {
      /*
        The state the late handler really sees for a change payment: NO cancel
        op for the intent (a change payment the cancel's claim had no ledger row
        for), so the superseded hook - whose double reads the same op state -
        does not hand it off. With a cancel op the hand-off holds it instead,
        and that is pinned in `payment-recovery.test.ts`.
      */
      function armLateChangeCapture() {
        mockConstructWebhookEvent.mockReturnValue(
          additionalSucceededEvent("evt_add_late_held"),
        );
        mockFindPaymentTransactionByIntentId.mockResolvedValue({
          id: "txn-9",
          paymentId: "payment-9",
          kind: "ADDITIONAL",
          amountCents: 2500,
          status: "FAILED",
        });
        armCancelledBooking("inv-9", null);
      }

      it("holds a genuine late capture as one OPEN task: the capture is recorded, nothing is refunded, alerted or credited", async () => {
        armLateChangeCapture();
        mockBookingDefaultsFindUnique.mockResolvedValue({
          lateCaptureRefundNeedsApproval: true,
        });

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        // Stripe holds the money, so the row still says so.
        expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalled();
        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
        expect(mockManualRefundTaskCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({
            bookingId: "booking-9",
            paymentId: "payment-9",
            amountCents: 2500,
            raisedAmountCents: 2500,
            // #3639: the #2700 kind the previous app version already reads,
            // marked by the column that names the capture.
            kind: "DELETED_BOOKING_LATE_CAPTURE",
            lateCaptureApprovalIntentId: "pi_additional_late",
            status: "OPEN",
            reason: expect.stringContaining("A payment for a change to the booking"),
          }),
          select: { id: true },
        });
        expect(mockLogAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "booking.payment.late_capture_refund_held",
            details: expect.stringContaining('"refundSent":false'),
          }),
        );
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
        expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
        // Its own alert instead, once (delta D7).
        expect(mockSendAdminLateCaptureHeldAlert).toHaveBeenCalledTimes(1);
        expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
        expect(mockLogAudit).not.toHaveBeenCalledWith(
          expect.objectContaining({
            action: "booking.payment.refunded_after_cancellation",
          }),
        );
      });

      it("raises nothing on a replay: the task already owns the capture, whatever the setting says now", async () => {
        armLateChangeCapture();
        // A club that has since switched back to automatic refunds.
        mockBookingDefaultsFindUnique.mockResolvedValue({
          lateCaptureRefundNeedsApproval: false,
        });
        mockManualRefundTaskFindUnique.mockResolvedValue({
          id: "task-held",
          status: "OPEN",
        });

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
        expect(mockManualRefundTaskCreate).not.toHaveBeenCalled();
        expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      });

      it("keeps a capture a treasurer chose to keep: a DISMISSED task still owns it", async () => {
        armLateChangeCapture();
        mockManualRefundTaskFindUnique.mockResolvedValue({
          id: "task-held",
          status: "DISMISSED",
        });

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      });

      it("asks nothing twice: it marks the confirm route's open #2700 question, which then refunds to the card (review F6)", async () => {
        armLateChangeCapture();
        mockBookingDefaultsFindUnique.mockResolvedValue({
          lateCaptureRefundNeedsApproval: true,
        });
        mockManualRefundTaskFindFirst.mockResolvedValue({ id: "task-2700" });

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
        expect(mockManualRefundTaskCreate).not.toHaveBeenCalled();
        expect(mockManualRefundTaskUpdate).toHaveBeenCalledWith({
          where: { id: "task-2700" },
          data: {
            lateCaptureApprovalIntentId: "pi_additional_late",
            kind: "DELETED_BOOKING_LATE_CAPTURE",
          },
        });
        expect(mockLogAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "booking.payment.late_capture_refund_held",
            details: expect.stringContaining('"manualRefundTaskId":"task-2700"'),
          }),
        );
      });

      it("refunds automatically when the club chose that, and when it never saved the setting (the default)", async () => {
        for (const saved of [null, { lateCaptureRefundNeedsApproval: false }]) {
          mockRefundPaymentTransactions.mockClear();
          mockManualRefundTaskCreate.mockClear();
          armLateChangeCapture();
          mockBookingDefaultsFindUnique.mockResolvedValue(saved);

          const response = await POST(makeRequest());

          expect(response.status).toBe(200);
          expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
            expect.objectContaining({
              idempotencyKeyPrefix: "late_cancel_refund_booking-9_pi_additional_late",
            }),
          );
          expect(mockManualRefundTaskCreate).not.toHaveBeenCalled();
        }
      });
    });

    it("enqueues the corrective refund credit note when the supplementary invoice was already released in a race", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_raced"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(
        true,
      );
      // The inline refund recorded its ledger row before the note is sized.
      mockPaymentRefundFindMany.mockResolvedValue([
        {
          amountCents: 2500,
          status: "succeeded",
          stripeCreatedAt: new Date("2026-06-30T22:00:00.000Z"),
          createdAt: new Date("2026-06-30T22:00:00.000Z"),
        },
      ]);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
        "payment-9",
        2500,
        expect.objectContaining({ refundMethod: "card", documentDate: "2026-07-01" }),
      );
    });

    it("fails the webhook (retryable) when the refund cannot be issued, instead of swallowing the debt", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_refund_down"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRefundPaymentTransactions.mockRejectedValue(new Error("stripe down"));

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      // The processed-event marker is cleared so Stripe's retry re-runs the
      // handler with the same idempotent refund keys.
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalled();
      expect(
        mockReleaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
      ).not.toHaveBeenCalled();
    });

    it("keeps the live-booking additional payment path unchanged (mark + release, no refund)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_live"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "PENDING",
      });
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-9",
        status: "PAID",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        member: { firstName: "Alice", lastName: "Example" },
        payment: { id: "payment-9", xeroInvoiceId: null },
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockMarkPaymentIntentTransactionSucceeded).toHaveBeenCalledWith({
        paymentIntentId: "pi_additional_late",
        amountCents: 2500,
        paymentMethodId: "pm_late",
      });
      expect(
        mockReleaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
      ).toHaveBeenCalledWith("pi_additional_late");
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      expect(mockSendAdminLateCaptureRefundedOutsideAppAlert).not.toHaveBeenCalled();
    });

    /*
      #2774 D2 — THE MONEY BUG, AND THE HIGHEST-VALUE ASSERTION IN THIS FILE.

      An operator can resolve the confirm route's OPEN hand-back task themselves:
      it sits OPEN for as long as the webhook is delayed or disabled. Resolving it
      as COMPLETED writes a local refund allocation through
      `applyLocalRefundAllocation` — the ledger saying the club paid the member back
      out of its own funds. Before this change nothing stopped the webhook refunding
      the same capture at Stripe on top of it, so the member was paid TWICE and only
      a reconciliation would ever have noticed.

      MUTATION PROOF: delete the fence's early return and this fails by name, while
      the refund tests either side of it still pass.
    */
    it("does not refund a capture an operator has already handed back by hand (#2774)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_hand_completed"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockFindCompletedHandBackForLateCapture.mockResolvedValueOnce({
        id: "task-hand-completed",
        amountCents: 2500,
        completedAt: new Date("2026-07-28"),
        completedByMemberId: "member-operator",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The money does NOT move. This is the whole point.
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      // No second ManualRefundTask row: the operator's COMPLETED row IS the record
      // of this capture, and one row per capture is the property every lookup on
      // this path protects.
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).not.toHaveBeenCalled();
      // The audit log must NOT claim a refund that did not happen — that action is
      // named as the club's permanent record of automatic refunds.
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
        }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_refund_withheld",
          category: "payment",
          severity: "critical",
          // A guard refused an action; nothing failed.
          outcome: "blocked",
          entityType: "Booking",
          entityId: "booking-9",
        }),
      );
      // The row says, in words, that the money did not go — nobody reconciling it
      // should have to infer that from an action name.
      const withheld = mockLogAudit.mock.calls
        .map((call) => call[0] as { action: string; details?: string })
        .find(
          (row) =>
            row.action === "booking.payment.late_capture_refund_withheld",
        );
      expect(JSON.parse(String(withheld?.details))).toMatchObject({
        refundSent: false,
        manualRefundTaskId: "task-hand-completed",
        handBackAmountCents: 2500,
        captureKind: "modification",
      });
      // Exactly ONE notification for the event, and it is the one that says the
      // refund was withheld — never the "refunded automatically" mail.
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ refundSent: false, bookingId: "booking-9" }),
        CLUB_FORMAT_TEST,
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      // Nothing downstream of the refund runs, because there was no refund to
      // mirror in Xero.
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("answers 500 rather than guessing when the hand-back fence cannot be read (#2774)", async () => {
      /*
        Refunding twice and never refunding at all are both bad, so a fence that
        cannot answer gives NEITHER answer. The rejection reaches the outer catch,
        the processed-event marker is cleared and Stripe redelivers against the same
        idempotent refund keys — so a redelivery that reaches a working database
        refunds exactly once. Swallowing this and refunding would reopen the double
        payment; swallowing it and returning 200 would leave the capture unrefunded
        for good, because Stripe never redelivers a 200.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_fence_unreadable"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockFindCompletedHandBackForLateCapture.mockRejectedValueOnce(
        new Error("database is down"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalled();
    });

    it("reports a possible DOUBLE payment when the hand-completion lands during the refund (#2774)", async () => {
      /*
        The window the fence cannot close, detected rather than left silent. The
        fence read the task as unresolved; the operator committed COMPLETED while
        Stripe was refunding; the record writer then finds it under
        `pg_advisory_xact_lock(1)` and reports the status. Closing this window would
        mean holding that lock across a provider round trip, which
        `docs/CONCURRENCY_AND_LOCKING.md` forbids — so the exposure is shrunk from
        days to one Stripe call and the residue is reported.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_double_paid"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
        closed: 0,
        created: false,
        alreadyRecorded: "hand-resolved",
        existingStatus: "COMPLETED",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The refund DID go out — this ordering is not preventable, only reportable.
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_double_refund_suspected",
          category: "payment",
          severity: "critical",
          outcome: "failure",
          entityId: "booking-9",
        }),
      );
      // ONE notification, and it is the one that says the money may have gone
      // twice. Sending the cheerful "refunded automatically" mail here would be a
      // lie by omission about money leaving the club twice.
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).toHaveBeenCalledWith(expect.objectContaining({ refundSent: true }), CLUB_FORMAT_TEST);
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
    });

    it("does NOT escalate the ordinary hand-DISMISSED carve-out (#2774 D1)", async () => {
      /*
        #2774 D1 keeps this carve-out - the orchestrator's call on that issue's
        Recommended option, not the owner's. A DISMISSED row means an operator
        settled the matter another way and wrote NO refund allocation, so nothing
        was paid twice; the only consequence is that the automatic refund reaches no
        finance card, which `INV-ADDPAY-037` and the card copy both name. Escalating
        it would cry double-payment over a capture nobody was paid twice for, and
        the pinned expectation is inverted here on purpose so a future author cannot
        widen the escalation to "any hand resolution" without this failing.
      */
      mockConstructWebhookEvent.mockReturnValue(
        additionalSucceededEvent("evt_add_cancelled_hand_dismissed"),
      );
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-9",
        paymentId: "payment-9",
        kind: "ADDITIONAL",
        amountCents: 2500,
        status: "FAILED",
      });
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockResolvedValueOnce({
        closed: 0,
        created: false,
        alreadyRecorded: "hand-resolved",
        existingStatus: "DISMISSED",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_double_refund_suspected",
        }),
      );
    });

    // #4103 (`INV-PAY-130`): Stripe answers the automatic refund `failed` or
    // `canceled` without throwing. Nothing went back, so nothing may say it did:
    // no "refunded" record, audit row, alert or Xero note. The capture is held
    // for a treasurer instead, whatever the setting says; the task is the
    // record, and its once-ever alert the one alert.
    describe("a refund Stripe refuses (#4103)", () => {
      function armRefusal(status: string) {
        mockConstructWebhookEvent.mockReturnValue(additionalSucceededEvent(`evt_add_refused_${status}`));
        mockFindPaymentTransactionByIntentId.mockResolvedValue({
          id: "txn-9",
          paymentId: "payment-9",
          kind: "ADDITIONAL",
          amountCents: 2500,
          status: "FAILED",
        });
        armCancelledBooking("inv-9", null);
        // A club on automatic refunds.
        mockBookingDefaultsFindUnique.mockResolvedValue({ lateCaptureRefundNeedsApproval: false });
        mockRefundPaymentTransactions.mockResolvedValue({
          refunds: [
            {
              paymentIntentId: "pi_additional_late",
              refundId: "re_refused_9",
              amountCents: 2500,
              status,
              slice: { paymentTransactionId: "txn-9", amountCents: 2500 },
            },
          ],
          totalRefundedAmountCents: 2500,
        });
      }

      it.each([["failed"], ["canceled"]])("answered %s: held for a treasurer, nothing says refunded", async (status) => {
        armRefusal(status);

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockRefundPaymentTransactions).toHaveBeenCalledTimes(1);
        expect(mockManualRefundTaskCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({
            amountCents: 2500,
            kind: "DELETED_BOOKING_LATE_CAPTURE",
            lateCaptureApprovalIntentId: "pi_additional_late",
            status: "OPEN",
          }),
          select: { id: true },
        });
        expect(mockLogAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "booking.payment.late_capture_refund_held",
            details: expect.stringContaining('"stripeRefusedAutomaticRefund":true'),
          }),
        );
        expect(mockSendAdminLateCaptureHeldAlert).toHaveBeenCalledTimes(1);
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
        expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
        expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
        expect(mockLogAudit).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "booking.payment.refunded_after_cancellation" }),
        );
      });

      it("a replay finds the task its refusal raised: nothing new is raised, and still nothing says refunded", async () => {
        armRefusal("failed");
        mockManualRefundTaskFindUnique.mockResolvedValue({ id: "task-held", status: "OPEN" });

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockManualRefundTaskCreate).not.toHaveBeenCalled();
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
        expect(mockLogAudit).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "booking.payment.refunded_after_cancellation" }),
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // #2773: a late Stripe capture of the booking's OWN (PRIMARY) payment on a
  // CANCELLED booking. #1350 has always refunded it; until #2773 it left NO
  // operator record and sent the generic muteable "Payment Failed" mail, while its
  // booking-change sibling had both since #2760/#2761.
  // ---------------------------------------------------------------------------
  describe("late primary capture on a cancelled booking (#1350 / #2773)", () => {
    function primarySucceededEvent(id = "evt_primary_cancelled") {
      return {
        id,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_primary_late",
            amount: 12000,
            payment_method: "pm_primary_late",
            // No `type: "modification_additional"` — this is the booking's own
            // payment, which is what routes it to the sibling handler.
            metadata: { bookingId: "booking-7" },
          },
        },
      } as any;
    }

    function armCancelledBooking(
      xeroInvoiceId: string | null = null,
      deletedAt: Date | null = new Date("2026-06-20"),
      capturedRefundedCents = 0,
    ) {
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-7",
        paymentId: "payment-7",
        kind: "PRIMARY",
        amountCents: 12000,
        status: "PENDING",
      });
      // #4131: the capture's own row as the handler's write left it, which its refund is pinned to.
      mockPaymentTransactionFindUnique.mockImplementation(async ({ where }: { where: { stripePaymentIntentId?: string } }) =>
        where.stripePaymentIntentId === "pi_primary_late"
          ? { id: "txn-7", paymentId: "payment-7", status: "SUCCEEDED", amountCents: 12000, refundedAmountCents: capturedRefundedCents, createdAt: new Date("2026-05-01") }
          : null,
      );
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-7",
        status: "CANCELLED",
        deletedAt,
        checkIn: new Date("2026-09-01"),
        checkOut: new Date("2026-09-04"),
        member: { firstName: "Bruce", lastName: "Example" },
        payment: { id: "payment-7", xeroInvoiceId },
      });
      mockRefundPaymentTransactions.mockResolvedValue({
        refunds: [
          {
            paymentIntentId: "pi_primary_late",
            refundId: "re_primary_7",
            amountCents: 12000,
          },
        ],
        totalRefundedAmountCents: 12000,
      });
    }

    /** #4131: the details of the one `refunded_after_cancellation` audit entry. */
    const refundAuditOf = () =>
      JSON.parse(
        (mockLogAudit.mock.calls.find(([entry]) => (entry as { action: string }).action === "booking.payment.refunded_after_cancellation")?.[0] as { details: string }).details,
      ) as Record<string, unknown>;

    it("records the refund and sends the unmuteable alert instead of 'Payment Failed' (#2773)", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent());
      armCancelledBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The refund is unchanged: same amount, same idempotent per-intent key -
      // and (#4131) pinned to the capture's own charge, never a newest-first plan.
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentId: "payment-7",
          amountCents: 12000,
          allocation: [{ paymentTransactionId: "txn-7", amountCents: 12000 }],
          idempotencyKeyPrefix: "late_cancel_refund_booking-7_pi_primary_late",
        }),
      );
      expect(refundAuditOf()).toMatchObject({ refundId: "re_primary_7", amountCents: 12000, refundedNowCents: 12000 });
      // The record this path never had, with its OWN reason sentence — "primary",
      // not the booking-change one, which would print a false sentence on the card.
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith({
        bookingId: "booking-7",
        paymentId: "payment-7",
        paymentIntentId: "pi_primary_late",
        amountCents: 12000,
        bookingDeleted: true,
        captureKind: "primary",
      });
      // Recorded AFTER the money went back, never before.
      expect(
        mockRefundPaymentTransactions.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockRecordAutomaticCancelledBookingRefundTask.mock
          .invocationCallOrder[0],
      );
      // The alert: the unmuteable one, naming which payment it was. The generic
      // muteable "Payment Failed" mail this path used to send is gone.
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: "booking-7",
          amountCents: 12000,
          bookingDeleted: true,
          captureKind: "primary",
        }),
        CLUB_FORMAT_TEST,
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
      expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
      // The audit entry is unchanged except that it now names its kind, so the two
      // handlers' rows are told apart by the row rather than by knowing the code.
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
          targetId: "booking-7",
          details: expect.stringContaining('"kind":"primary"'),
        }),
      );
    });

    // #4131 (`INV-PAY-106`): the booking's own late payment is refunded from
    // its own charge only - never a fee the cancel kept on another charge, which
    // no per-capture Xero note answers.
    describe("refunded from the capture's own charge only (#4131)", () => {
      const asksFor = (amountCents: number) =>
        expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
          expect.objectContaining({
            amountCents,
            allocation: [{ paymentTransactionId: "txn-7", amountCents }],
            idempotencyKeyPrefix: "late_cancel_refund_booking-7_pi_primary_late",
          }),
        );

      it("a capture already part refunded (the dashboard) is refunded only for what it holds, and the audit reconciles", async () => {
        mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_part_refunded"));
        armCancelledBooking(null, new Date("2026-06-20"), 2000);
        mockRefundPaymentTransactions.mockResolvedValue({
          refunds: [{ paymentIntentId: "pi_primary_late", refundId: "re_part", amountCents: 10000, status: "succeeded" }],
          totalRefundedAmountCents: 10000,
        });

        expect((await POST(makeRequest())).status).toBe(200);

        expect(mockRefundPaymentTransactions).toHaveBeenCalledTimes(1);
        asksFor(10000);
        expect(refundAuditOf()).toMatchObject({ refundId: "re_part", amountCents: 12000, refundedNowCents: 10000, alreadyRefundedOnCaptureCents: 2000 });
      });

      it("a capture that holds nothing more sends nothing, and its audit says why", async () => {
        mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_holds_nothing"));
        armCancelledBooking(null, new Date("2026-06-20"), 12000);

        expect((await POST(makeRequest())).status).toBe(200);

        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
        expect(refundAuditOf()).toMatchObject({ refundId: null, amountCents: 12000, refundedNowCents: 0, alreadyRefundedOnCaptureCents: 12000 });
        expect(refundAuditOf().noRefundSentReason).toEqual(expect.stringContaining("already been refunded"));
      });

      it.each([
        ["on another payment", { paymentId: "payment-other", status: "SUCCEEDED" }],
        ["not captured", { paymentId: "payment-7", status: "FAILED" }],
      ])("a capture row read back %s fails the webhook for Stripe to redeliver, refunding nothing", async (_label, row) => {
        mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_row_mismatch"));
        armCancelledBooking();
        mockPaymentTransactionFindUnique.mockResolvedValue({ id: "txn-7", amountCents: 12000, refundedAmountCents: 0, ...row });

        expect((await POST(makeRequest())).status).toBe(500);
        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      });

      it("a capture row the handler cannot read back fails the webhook for Stripe to redeliver, refunding nothing", async () => {
        mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_row_missing"));
        armCancelledBooking();
        mockPaymentTransactionFindUnique.mockResolvedValue(null);

        const response = await POST(makeRequest());

        expect(response.status).toBe(500);
        expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
      });
    });

    // #4103 (`INV-PAY-130`): a refused slice is held; a made one stays made.
    // Since #4131 the plan is one slice on the capture's own charge, so the
    // two-answer shape below is the hold's general handling, not a plan the
    // handler sends.
    describe("a refund Stripe refuses (#4103)", () => {
      const answer = (transactionId: string, amountCents: number, status: string) => ({
        paymentIntentId: "pi_primary_late",
        refundId: `re_${transactionId}`,
        amountCents,
        status,
        slice: { paymentTransactionId: transactionId, amountCents },
      });

      it("one slice made beside one refused: only the refused amount is held, and nothing says refunded", async () => {
        mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_refused_part"));
        armCancelledBooking("inv-7", null);
        mockRefundPaymentTransactions.mockResolvedValue({
          refunds: [answer("txn-7", 9000, "succeeded"), answer("txn-6", 3000, "canceled")],
          totalRefundedAmountCents: 12000,
        });

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockManualRefundTaskCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({ amountCents: 3000, lateCaptureApprovalIntentId: "pi_primary_late", status: "OPEN" }),
          select: { id: true },
        });
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
        expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
        expect(mockLogAudit).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "booking.payment.refunded_after_cancellation" }),
        );
      });

      // #4103 review (a): the slice that WAS made is not lost from the record:
      // the hold's audit names it, and its Xero note is queued, sized by the
      // capture's own made refunds (a refused one is never counted).
      it("one slice made beside one refused: the hold's audit names the made part, and its Xero note is queued", async () => {
        mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_refused_part_noted"));
        armCancelledBooking("inv-7", null);
        mockRefundPaymentTransactions.mockResolvedValue({
          refunds: [answer("txn-7", 9000, "succeeded"), answer("txn-6", 3000, "canceled")],
          totalRefundedAmountCents: 12000,
        });
        mockHasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent.mockResolvedValue(true);
        mockIsXeroConnected.mockResolvedValue(false);
        mockPaymentRefundFindMany.mockResolvedValue([
          { amountCents: 9000, status: "succeeded", stripeCreatedAt: new Date("2026-06-11T22:00:00.000Z"), createdAt: new Date("2026-06-11T22:00:00.000Z") },
          { amountCents: 3000, status: "canceled", stripeCreatedAt: new Date("2026-06-11T22:00:00.000Z"), createdAt: new Date("2026-06-11T22:00:00.000Z") },
        ]);

        const response = await POST(makeRequest());

        expect(response.status).toBe(200);
        expect(mockLogAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "booking.payment.late_capture_refund_held",
            details: expect.stringContaining('"refundedBesideRefusalCents":9000'),
          }),
        );
        expect(mockEnqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
          "payment-7",
          9000,
          expect.objectContaining({ refundMethod: "card", paymentIntentId: "pi_primary_late" }),
        );
      });

      it("refused then thrown: the webhook fails for Stripe to redeliver, and nothing is recorded or held", async () => {
        mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_refused_thrown"));
        armCancelledBooking("inv-7", null);
        mockRefundPaymentTransactions.mockRejectedValue(
          Object.assign(new Error("Refund failed after $0.00 was refunded and recorded: network"), {
            refunds: [answer("txn-7", 9000, "failed")],
          }),
        );

        const response = await POST(makeRequest());

        expect(response.status).toBe(500);
        expect(mockManualRefundTaskCreate).not.toHaveBeenCalled();
        expect(mockRecordAutomaticCancelledBookingRefundTask).not.toHaveBeenCalled();
        expect(mockLogAudit).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: "booking.payment.refunded_after_cancellation" }),
        );
      });
    });

    it("holds the booking's own late payment for a treasurer when the club asks for approval (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_held"),
      );
      armCancelledBooking("inv-7", null);
      mockBookingDefaultsFindUnique.mockResolvedValue({
        lateCaptureRefundNeedsApproval: true,
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The capture is still recorded, with this handler's own marker, so a
      // crash-and-retry is still read as a late capture and finds its task.
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: "pi_primary_late",
          status: "SUCCEEDED",
          reason: "cancelled_booking_late_capture",
        }),
      );
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockManualRefundTaskCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: "DELETED_BOOKING_LATE_CAPTURE",
          lateCaptureApprovalIntentId: "pi_primary_late",
          amountCents: 12000,
          status: "OPEN",
          reason: expect.stringContaining("The booking's own payment pi_primary_late"),
        }),
        select: { id: true },
      });
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("acknowledges a replay of a held primary capture without refunding or raising again (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_held_replay"),
      );
      armCancelledBooking(null, null);
      mockBookingDefaultsFindUnique.mockResolvedValue({
        lateCaptureRefundNeedsApproval: true,
      });
      mockManualRefundTaskFindUnique.mockResolvedValue({
        id: "task-held",
        status: "OPEN",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockManualRefundTaskCreate).not.toHaveBeenCalled();
    });

    it("still refunds a saved-card capture after an UNPAID auto-cancel, whose snapshot is not a decision (#3639 review F2)", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_after_unpaid"));
      armCancelledBooking(null, null);
      // The saved-card settle wrote its own row SUCCEEDED, no late marker.
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-7",
        paymentId: "payment-7",
        kind: "PRIMARY",
        amountCents: 12000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        reason: null,
      });
      // The pending-request cron's unpaid auto-cancel writes this snapshot.
      mockBookingEventFindMany.mockResolvedValue([
        { type: "CANCELLED", snapshot: { autoCancelledPastCheckIn: true } },
      ]);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 12000,
          idempotencyKeyPrefix: "late_cancel_refund_booking-7_pi_primary_late",
        }),
      );
    });

    it("records the cancelled-but-not-deleted population too (#2773)", async () => {
      // #1350's refund fires on `status === "CANCELLED"`, not on `deletedAt`, so
      // this capture was already being auto-refunded — with no record anywhere.
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_cancelled_live"),
      );
      armCancelledBooking(null, null);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingDeleted: false,
          captureKind: "primary",
          amountCents: 12000,
        }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: false }),
        CLUB_FORMAT_TEST,
      );
    });

    it("re-reads deletedAt after the Stripe round trip on this path too (#2773)", async () => {
      /*
        An admin deleting the booking while the refund is in flight would otherwise
        store "cancelled, still on file" and mail "normally nothing to do" for the
        one population that needs a person. The shared recorder owns the re-read, so
        this path gets it by construction rather than by remembering to copy it.
      */
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_deleted_mid_refund"),
      );
      armCancelledBooking(null, null);
      mockBookingFindUnique
        .mockResolvedValueOnce({
          id: "booking-7",
          status: "CANCELLED",
          deletedAt: null,
          checkIn: new Date("2026-09-01"),
          checkOut: new Date("2026-09-04"),
          member: { firstName: "Bruce", lastName: "Example" },
          payment: { id: "payment-7", xeroInvoiceId: null },
        })
        .mockResolvedValueOnce({ deletedAt: new Date("2026-08-30") });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: true, captureKind: "primary" }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ bookingDeleted: true }),
        CLUB_FORMAT_TEST,
      );
    });

    it("answers 500 and audits the loss when the record write fails, after its refund entry and alert, so the redelivery writes the row (#2773 / #4149)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_record_fails"),
      );
      armCancelledBooking();
      mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(
        new Error("could not serialize access due to concurrent update"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.auto_refund_record_failed",
          category: "payment",
          severity: "critical",
          outcome: "failure",
          entityId: "booking-7",
        }),
      );
      // Reported to a person now, once: never neither (`INV-ADDPAY-037`).
      expect(refundAuditOf()).toMatchObject({ paymentIntentId: "pi_primary_late", kind: "primary", recordLost: true });
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
    });

    it("a delivery killed between the refund and its record is redelivered and recorded exactly once (#4149)", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_record_lost"));
      armCancelledBooking("xero-inv-7");
      mockRecordAutomaticCancelledBookingRefundTask.mockRejectedValueOnce(new Error("killed between the refund and the record"));

      expect((await POST(makeRequest())).status).toBe(500);

      // The redelivery: the handler's own marked capture row, refunded in full;
      // Stripe lists the refund the late-capture door sent.
      armCaptureRow("REFUNDED", "cancelled_booking_late_capture");
      mockListRefundsForPaymentIntent.mockResolvedValue([
        { id: "re_primary_7", amount: 12000, status: "succeeded", created: 1, metadata: { bookingId: "booking-7", reason: "cancelled_booking_late_capture" } },
      ]);

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockRefundPaymentTransactions).toHaveBeenCalledTimes(1);
      expect(mockRecordAutomaticCancelledBookingRefundTask).toHaveBeenCalledTimes(2);
      // The refunding delivery's entry and alert; the redelivery adds its own entry and sends the alert again.
      expect(refundAuditOf()).toMatchObject({ paymentIntentId: "pi_primary_late", refundId: "re_primary_7", kind: "primary", recordLost: true });
      expect(
        mockLogAudit.mock.calls.filter(([entry]) => (entry as { action: string }).action === "booking.payment.refunded_after_cancellation"),
      ).toHaveLength(1);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "booking.payment.auto_refund_record_recovered", entityId: "booking-7" }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(2);
      // Never a payment-wide note against the pre-cancel invoice: the capture's own receipt decides.
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("withholds the refund on this path too when a hand-back already exists (#2774)", async () => {
      /*
        Nothing currently raises an OPEN task for a PRIMARY intent, so this state is
        not reachable in the shipped tree — the fence is here because it is keyed on
        the payment intent rather than on the handler, so a reader of one handler
        cannot conclude the other is unfenced and a future raiser is covered by
        construction. Pinned so that "unreachable today" cannot quietly become
        "unfenced".
      */
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_hand_completed"),
      );
      armCancelledBooking();
      mockFindCompletedHandBackForLateCapture.mockResolvedValueOnce({
        id: "task-primary-hand-completed",
        amountCents: 12000,
        completedAt: new Date("2026-08-29"),
        completedByMemberId: "member-operator",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_capture_refund_withheld",
          severity: "critical",
          outcome: "blocked",
          entityId: "booking-7",
        }),
      );
      expect(
        mockSendAdminLateCaptureHandBackConflictAlert,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          refundSent: false,
          captureKind: "primary",
          handBackAmountCents: 12000,
        }),
        CLUB_FORMAT_TEST,
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("raises NO Xero credit note for a payment whose invoice was cleared at cancel (#3635 review F2)", async () => {
      // The booking's own invoice is the pre-cancel one the cancel cleared; Xero
      // never recorded THIS capture, so a refund note would take money out of
      // the Stripe account that never went in.
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_with_invoice"),
      );
      armCancelledBooking("xero-inv-7");

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // #3639: a success notice reaching a cancelled booking is not always a late
    // capture. The in-app confirm settles the booking when Stripe's notice is
    // slow; the member then cancels; Stripe's notice arrives days later (it
    // retries failed deliveries, and an operator can resend one). The handler
    // asks what the cancellation already settled BEFORE it refunds.
    // -------------------------------------------------------------------------
    function armCaptureRow(status: string, reason: string | null = null) {
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-7",
        paymentId: "payment-7",
        kind: "PRIMARY",
        amountCents: 12000,
        // The refunded total follows the status, as the ledger writes it.
        refundedAmountCents:
          status === "REFUNDED" ? 12000 : status === "PARTIALLY_REFUNDED" ? 5000 : 0,
        status,
        reason,
      });
    }

    function expectAcknowledgedWithoutMovingMoney(response: Response) {
      expect(response.status).toBe(200);
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
      expect(
        mockRecordAutomaticCancelledBookingRefundTask,
      ).not.toHaveBeenCalled();
      expect(mockSendAdminLateCaptureAutoRefundAlert).not.toHaveBeenCalled();
      expect(mockLogAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.refunded_after_cancellation",
        }),
      );
    }

    function expectAcknowledgementRecorded(verdict: string, severity = "info") {
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.payment.late_notice_acknowledged",
          category: "payment",
          severity,
          outcome: "blocked",
          entityId: "booking-7",
          details: expect.stringContaining('"verdict":"' + verdict + '"'),
        }),
      );
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining('"refundSent":false'),
        }),
      );
    }

    it("never asks Stripe about a refunded PRIMARY capture the cancellation settled: its handler marks its own write (#4149)", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_settled_refunded"));
      armCancelledBooking("xero-inv-7", null);
      // Captured before the cancel (no marker), refunded by the cancellation's own decision.
      armCaptureRow("REFUNDED");
      mockBookingEventFindMany.mockResolvedValue([
        { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 100, settledAmountCents: 12000, retainedAmountCents: 0 } },
      ]);

      const response = await POST(makeRequest());

      expectAcknowledgedWithoutMovingMoney(response);
      expectAcknowledgementRecorded("settled_by_cancellation");
      expect(mockListRefundsForPaymentIntent).not.toHaveBeenCalled();
    });

    it("acknowledges an already-recorded refunded capture with an unreadable owner: 200, as before #4149, never a 500", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_recorded_no_owner"));
      armCancelledBooking("xero-inv-7", null);
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-7",
        status: "CANCELLED",
        deletedAt: null,
        checkIn: new Date("2026-09-01"),
        checkOut: new Date("2026-09-04"),
        member: null,
        organisation: null,
        payment: { id: "payment-7", xeroInvoiceId: "xero-inv-7" },
      });
      armCaptureRow("REFUNDED", "cancelled_booking_late_capture");
      mockFindClosedLateCaptureRecordIntents.mockImplementation(async () => new Map([["pi_primary_late", "record"]]));

      const response = await POST(makeRequest());

      expectAcknowledgedWithoutMovingMoney(response);
      expectAcknowledgementRecorded("already_refunded");
      expect(mockListRefundsForPaymentIntent).not.toHaveBeenCalled();
    });

    it("writes a lost record for a capture whose owner cannot be read, naming an unknown member (#4149)", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_lost_no_owner"));
      armCancelledBooking("xero-inv-7", null);
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-7",
        status: "CANCELLED",
        deletedAt: null,
        checkIn: new Date("2026-09-01"),
        checkOut: new Date("2026-09-04"),
        member: null,
        organisation: null,
        payment: { id: "payment-7", xeroInvoiceId: "xero-inv-7" },
      });
      armCaptureRow("REFUNDED", "cancelled_booking_late_capture");
      mockListRefundsForPaymentIntent.mockResolvedValue([
        { id: "re_primary_7", amount: 12000, status: "succeeded", created: 1, metadata: { bookingId: "booking-7", reason: "cancelled_booking_late_capture" } },
      ]);

      expect((await POST(makeRequest())).status).toBe(200);

      expect(mockRecordAutomaticCancelledBookingRefundTask).toHaveBeenCalledTimes(1);
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledWith(
        expect.objectContaining({ memberName: "unknown member" }),
        expect.anything(),
      );
    });

    it("acknowledges a notice without reading the booking's owner, so an unreadable owner row cannot fail it (#4149)", async () => {
      mockConstructWebhookEvent.mockReturnValue(primarySucceededEvent("evt_primary_ack_no_owner"));
      armCancelledBooking("xero-inv-7", null);
      // The owner row could not be read: describing the capture would throw.
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-7",
        status: "CANCELLED",
        deletedAt: null,
        checkIn: new Date("2026-09-01"),
        checkOut: new Date("2026-09-04"),
        member: null,
        payment: { id: "payment-7", xeroInvoiceId: "xero-inv-7" },
      });
      armCaptureRow("SUCCEEDED");
      mockBookingEventFindMany.mockResolvedValue([
        { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 0, settledAmountCents: 0, retainedAmountCents: 12000 } },
      ]);

      const response = await POST(makeRequest());

      expectAcknowledgedWithoutMovingMoney(response);
      expectAcknowledgementRecorded("settled_by_cancellation");
    });

    it("acknowledges a delayed notice for money a 0%-tier cancellation kept: no refund, no note, no status write (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_paid_then_cancelled_zero_tier"),
      );
      armCancelledBooking("xero-inv-7", null);
      // The in-app confirm recorded the capture (no late-capture reason), and the
      // 0%-tier cancel froze its decision in the CANCELLED event's snapshot.
      armCaptureRow("SUCCEEDED");
      mockBookingEventFindMany.mockResolvedValue([
        { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 0, settledAmountCents: 0, retainedAmountCents: 12000 } },
      ]);

      const response = await POST(makeRequest());

      expectAcknowledgedWithoutMovingMoney(response);
      expectAcknowledgementRecorded("settled_by_cancellation");
      // The evidence was read for THIS booking, and the recovery lookup used
      // the booking-cancel key, never a modification refund's.
      expect(mockBookingEventFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { bookingId: "booking-7", type: "CANCELLED" },
        }),
      );
      expect(mockPaymentRecoveryOperationFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            idempotencyKey: "booking_cancel_refund_recovery_booking-7",
          },
        }),
      );
    });

    it("leaves a partially refunded payment as it is when a partial-tier card cancel already refunded its share (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_paid_then_cancelled_partial_tier"),
      );
      armCancelledBooking("xero-inv-7", null);
      armCaptureRow("PARTIALLY_REFUNDED");
      // No snapshot yet (it is written after the claim commits): the card
      // path's recovery operation, frozen inside the claim, is the decision.
      mockPaymentRecoveryOperationFindUnique.mockResolvedValue({
        status: "SUCCEEDED",
      });

      const response = await POST(makeRequest());

      // The upsert is what used to rewrite PARTIALLY_REFUNDED back to SUCCEEDED.
      expectAcknowledgedWithoutMovingMoney(response);
    });

    it("acknowledges a notice for a credit-path cancel, whose cancellation credit is the decision (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_paid_then_cancelled_credit"),
      );
      armCancelledBooking(null, null);
      armCaptureRow("SUCCEEDED");
      mockMemberCreditFindMany.mockResolvedValue([
        {
          type: "CANCELLATION_REFUND",
          description: "Cancellation refund for booking booking-",
          amountCents: 6000,
        },
      ]);

      const response = await POST(makeRequest());

      expectAcknowledgedWithoutMovingMoney(response);
      expect(mockMemberCreditFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sourceBookingId: "booking-7" } }),
      );
    });

    it("still refunds a genuine late capture on retry after a crash, even though its own first attempt wrote SUCCEEDED (#3639)", async () => {
      /*
        The first delivery recorded the capture and died before refunding. The
        row is SUCCEEDED, but it carries THIS handler's reason, so it is the
        handler's own write and not money the cancellation settled. The booking
        carries a paid-path snapshot as well — the #1491 residual, a late capture
        of a second intent on a booking already cancelled on the paid path — so
        only the row's provenance can tell the two apart.
      */
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_late_capture_retry"),
      );
      armCancelledBooking("xero-inv-7", null);
      armCaptureRow("SUCCEEDED", "cancelled_booking_late_capture");
      mockBookingEventFindMany.mockResolvedValue([
        { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 0, settledAmountCents: 0 } },
      ]);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 12000,
          idempotencyKeyPrefix: "late_cancel_refund_booking-7_pi_primary_late",
        }),
      );
      // #3635 review F2: no receipt of this capture, so no refund note.
      expect(mockEnqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
    });

    it("still refunds a saved-card charge that captured after an unpaid cancel: a captured row, but no decision (#3639)", async () => {
      /*
        The auto-charge records its own row SUCCEEDED before the booking's
        settlement refuses the cancelled booking, so the row alone looks like a
        capture recorded before the cancel. The cancel took the unpaid branch and
        decided nothing about money, which is what keeps this a late capture.
      */
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_saved_card_after_cancel"),
      );
      armCancelledBooking(null, null);
      armCaptureRow("SUCCEEDED", "confirm_pending_saved_card");
      mockBookingEventFindMany.mockResolvedValue([{ type: "CANCELLED", snapshot: null }]);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "SUCCEEDED",
          reason: "cancelled_booking_late_capture",
        }),
      );
      expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 12000 }),
      );
      expect(mockSendAdminLateCaptureAutoRefundAlert).toHaveBeenCalledTimes(1);
    });

    it("reads no decision evidence for an ordinary late capture, whose row never captured (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_ordinary_late_capture"),
      );
      armCancelledBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRefundPaymentTransactions).toHaveBeenCalled();
      expect(mockBookingEventFindMany).not.toHaveBeenCalled();
      expect(mockMemberCreditFindMany).not.toHaveBeenCalled();
      expect(mockPaymentRecoveryOperationFindUnique).not.toHaveBeenCalled();
    });

    it("acknowledges a replay of a late capture it already refunded, and never rewrites REFUNDED back to SUCCEEDED (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_late_capture_replay"),
      );
      armCancelledBooking("xero-inv-7", null);
      armCaptureRow("REFUNDED", "cancelled_booking_late_capture");

      const response = await POST(makeRequest());

      expectAcknowledgedWithoutMovingMoney(response);
      expectAcknowledgementRecorded("already_refunded");
    });

    it("raises the acknowledgement to important when part of a late capture is still held (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_late_capture_part_refunded"),
      );
      armCancelledBooking(null, null);
      armCaptureRow("PARTIALLY_REFUNDED", "cancelled_booking_late_capture");

      const response = await POST(makeRequest());

      expectAcknowledgedWithoutMovingMoney(response);
      expectAcknowledgementRecorded("already_refunded", "important");
    });

    it("answers 500 rather than guessing when the decision evidence cannot be read (#3639)", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        primarySucceededEvent("evt_primary_evidence_unreadable"),
      );
      armCancelledBooking("xero-inv-7", null);
      armCaptureRow("SUCCEEDED");
      mockBookingEventFindMany.mockRejectedValueOnce(
        new Error("connection terminated"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockUpsertPaymentIntentTransaction).not.toHaveBeenCalled();
      expect(mockRefundPaymentTransactions).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // F16 (#1887): the ProcessedWebhookEvent claim is a processing lease, closing
  // two lost-event windows: (a) a crash between claim-insert and completion no
  // longer ACKs every redelivery as a duplicate; (b) a concurrent redelivery is
  // no longer ACKed while an in-flight attempt later fails.
  // ---------------------------------------------------------------------------
  describe("a succeeded payment the app did not create (#4532, INV-INT-032)", () => {
    function foreignSucceededEvent(eventId: string, metadata: Record<string, string>) {
      return {
        id: eventId,
        type: "payment_intent.succeeded",
        livemode: true,
        data: { object: { id: "pi_foreign", amount: 5000, currency: "nzd", metadata } },
      } as any;
    }

    it.each([
      ["no metadata at all (a dashboard charge)", {}],
      ["a Payment Link's own metadata", { type: "donation", memberId: "m_1" }],
    ])("records and alerts it, never reaches a booking, and completes the event: %s", async (_label, metadata) => {
      const event = foreignSucceededEvent("evt_foreign", metadata);
      mockConstructWebhookEvent.mockReturnValue(event);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRecordUnrecognisedStripePayment).toHaveBeenCalledTimes(1);
      expect(mockRecordUnrecognisedStripePayment).toHaveBeenCalledWith(event.data.object, event, CLUB_FORMAT_TEST);
      expect(mockFindPaymentTransactionByIntentId).not.toHaveBeenCalled();
      expect(mockApplyGroupSettlementSucceeded).not.toHaveBeenCalled();
      expect(mockQueueSupersededPaymentIntentRefundRecovery).not.toHaveBeenCalled();
      expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
      );
    });

    it.each([
      ["a booking's intent", { bookingId: "booking-1" }],
      ["a group settlement", { type: "group_settlement", groupBookingId: "group-1" }],
    ])("leaves the app's own intents to their paths: %s", async (_label, metadata) => {
      mockConstructWebhookEvent.mockReturnValue(foreignSucceededEvent("evt_ours", metadata));

      await POST(makeRequest());

      expect(mockRecordUnrecognisedStripePayment).not.toHaveBeenCalled();
    });

    it("answers 500 and gives the claim back when the record or alert fails, so Stripe redelivers", async () => {
      mockConstructWebhookEvent.mockReturnValue(foreignSucceededEvent("evt_foreign_fail", {}));
      mockRecordUnrecognisedStripePayment.mockRejectedValueOnce(new Error("alert not sent"));

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ eventId: "evt_foreign_fail", status: "PROCESSING" }) }),
      );
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
      );
    });
  });

  describe("a succeeded app intent no PRIMARY payment transaction settles (#4624, INV-INT-033)", () => {
    function appSucceededEvent(eventId: string, metadata: Record<string, string>, request: unknown = null) {
      return {
        id: eventId,
        type: "payment_intent.succeeded",
        livemode: true,
        request,
        data: { object: { id: "pi_app", amount: 12000, currency: "nzd", status: "succeeded", metadata } },
      } as any;
    }

    function expectCompletedWithoutSettling() {
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      expect(mockSendBookingConfirmedEmail).not.toHaveBeenCalled();
      expect(mockEnqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
      );
    }

    it("records and alerts a booking intent no payment transaction names, even after the attempt adoption, and settles nothing", async () => {
      const event = appSucceededEvent("evt_app_unmatched", { bookingId: "booking-1" });
      mockConstructWebhookEvent.mockReturnValue(event);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRecordUnmatchedAppStripePayment).toHaveBeenCalledTimes(1);
      expect(mockRecordUnmatchedAppStripePayment).toHaveBeenCalledWith(event.data.object, event, CLUB_FORMAT_TEST, {
        bookingId: "booking-1",
        matchedKind: null,
      });
      expect(mockRecordUnrecognisedStripePayment).not.toHaveBeenCalled();
      expectCompletedWithoutSettling();
    });

    it("records and alerts a booking intent whose only row is an ADDITIONAL one while the intent is not marked an additional ask", async () => {
      const event = appSucceededEvent("evt_app_not_primary", { bookingId: "booking-1" });
      mockConstructWebhookEvent.mockReturnValue(event);
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-additional",
        paymentId: "payment-1",
        kind: "ADDITIONAL",
        amountCents: 12000,
        status: "PENDING",
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRecordUnmatchedAppStripePayment).toHaveBeenCalledWith(event.data.object, event, CLUB_FORMAT_TEST, {
        bookingId: "booking-1",
        matchedKind: "ADDITIONAL",
      });
      expectCompletedWithoutSettling();
    });

    it("re-reads after a failed adoption: a saved-card charge whose own settle wrote the intent meanwhile is settled, never alerted (#4624 review)", async () => {
      mockConstructWebhookEvent.mockReturnValue(appSucceededEvent("evt_app_settled_meanwhile", { bookingId: "booking-1" }));
      // First read: no row yet. The adoption finds no null-intent attempt row (the
      // request's settle has just written the intent onto it). The re-read finds it.
      mockPaymentTransactionFindFirst.mockResolvedValue(null);
      mockFindPaymentTransactionByIntentId.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "txn_attempt_settled",
        paymentId: "payment-1",
        kind: "PRIMARY",
        amountCents: 12000,
        status: "SUCCEEDED",
      });
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-1",
        status: "PAYMENT_PENDING",
        finalPriceCents: 12000,
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
        payment: null,
      });
      mockMarkBookingPaymentSucceeded.mockResolvedValueOnce({ outcome: "already_paid", bookingId: "booking-1", bumpedBookingIds: [] });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockFindPaymentTransactionByIntentId).toHaveBeenCalledTimes(2);
      expect(mockRecordUnmatchedAppStripePayment).not.toHaveBeenCalled();
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: "booking-1", paymentIntentId: "pi_app", recordedByCaller: false }),
      );
    });

    it("answers 500 and gives the claim back when the record or alert fails, so Stripe redelivers", async () => {
      mockConstructWebhookEvent.mockReturnValue(appSucceededEvent("evt_app_fail", { bookingId: "booking-1" }));
      mockRecordUnmatchedAppStripePayment.mockRejectedValueOnce(new Error("alert not sent"));

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ eventId: "evt_app_fail", status: "PROCESSING" }) }),
      );
    });

    // The expected cases: each is routed before the unmatched return, so none is recorded or alerted.
    it("stays silent for a booking intent its PRIMARY row settles (the ordinary payment)", async () => {
      mockConstructWebhookEvent.mockReturnValue(appSucceededEvent("evt_app_primary", { bookingId: "booking-1" }));
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-1",
        paymentId: "payment-1",
        kind: "PRIMARY",
        amountCents: 12000,
        status: "PROCESSING",
      });
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-1",
        status: "PAYMENT_PENDING",
        finalPriceCents: 12000,
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
        payment: null,
      });

      await POST(makeRequest());

      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalled();
      expect(mockRecordUnmatchedAppStripePayment).not.toHaveBeenCalled();
    });

    it("stays silent for an additional ask's intent, which its own handler takes", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        appSucceededEvent("evt_app_additional", { bookingId: "booking-1", type: "modification_additional" }),
      );

      await POST(makeRequest());

      expect(mockRecordUnmatchedAppStripePayment).not.toHaveBeenCalled();
      expect(mockRecordUnrecognisedStripePayment).not.toHaveBeenCalled();
    });

    it("stays silent for a group organiser's settlement intent, which the settlement takes", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        appSucceededEvent("evt_app_group", { type: "group_settlement", groupBookingId: "group-1" }),
      );

      await POST(makeRequest());

      expect(mockApplyGroupSettlementSucceeded).toHaveBeenCalled();
      expect(mockRecordUnmatchedAppStripePayment).not.toHaveBeenCalled();
    });

    it("stays silent for a superseded intent the refund machinery owns, with or without a ledger row", async () => {
      mockConstructWebhookEvent.mockReturnValue(appSucceededEvent("evt_app_superseded", { bookingId: "booking-1" }));
      mockQueueSupersededPaymentIntentRefundRecovery.mockResolvedValueOnce(true);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockRecordUnmatchedAppStripePayment).not.toHaveBeenCalled();
    });

    it("stays silent for a saved-card attempt whose lost answer the event's idempotency key adopts", async () => {
      const key = "pending_charge_booking-1_txn_attempt_9";
      mockConstructWebhookEvent.mockReturnValue(
        appSucceededEvent("evt_app_adopted", { bookingId: "booking-1" }, { id: "req_9", idempotency_key: key }),
      );
      mockPaymentTransactionFindFirst.mockResolvedValue({ id: "txn_attempt_9", paymentId: "payment-1" });
      mockFindPaymentTransactionByIntentId.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "txn_attempt_9",
        paymentId: "payment-1",
        kind: "PRIMARY",
        amountCents: 12000,
        status: "SUCCEEDED",
      });

      await POST(makeRequest());

      expect(mockRecordUnmatchedAppStripePayment).not.toHaveBeenCalled();
    });
  });

  describe("webhook dedup processing lease (#1887)", () => {
    function succeededEvent(eventId: string) {
      return {
        id: eventId,
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_lease",
            amount: 5000,
            metadata: { bookingId: "booking-1" },
            payment_method: "pm_123",
          },
        },
      } as any;
    }

    function armPaidBooking() {
      mockFindPaymentTransactionByIntentId.mockResolvedValue({
        id: "txn-1",
        paymentId: "payment-1",
        bookingId: "booking-1",
        kind: "PRIMARY",
        amountCents: 5000,
        status: "PENDING",
      });
      mockBookingFindUnique.mockResolvedValue({
        id: "booking-1",
        status: "CONFIRMED",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        finalPriceCents: 5000,
        discountCents: 0,
        guests: [{ id: "g1" }],
        member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
        promoRedemption: null,
      });
    }

    it("claims a fresh event under a PROCESSING lease and marks it COMPLETED on success", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_fresh"));
      armPaidBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The claim is inserted PROCESSING with a lease stamp.
      expect(mockProcessedWebhookCreate).toHaveBeenCalledWith({
        data: {
          eventId: "evt_fresh",
          source: "stripe",
          eventType: "payment_intent.succeeded",
          status: "PROCESSING",
          processingStartedAt: expect.any(Date),
        },
      });
      // On success it flips to COMPLETED so a later redelivery is a true dup.
      // Fenced (F16 fence, #1887) on status + the claimed processingStartedAt.
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_fresh",
          status: "PROCESSING",
          processingStartedAt: expect.any(Date),
        },
        data: { status: "COMPLETED", processedAt: expect.any(Date) },
      });
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalled();
    });

    it("fences the COMPLETED stamp to the exact lease it claimed (interleaving, #1887)", async () => {
      // A slow original that outlived its lease must not flip a takeover
      // successor's fresh claim to COMPLETED. The fence keys the COMPLETED stamp
      // on the SAME processingStartedAt written at claim time, so it can only
      // ever complete the lease this attempt owns.
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_fence"));
      armPaidBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      const claimToken =
        mockProcessedWebhookCreate.mock.calls[0]![0].data.processingStartedAt;
      expect(claimToken).toBeInstanceOf(Date);
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_fence",
          status: "PROCESSING",
          processingStartedAt: claimToken,
        },
        data: { status: "COMPLETED", processedAt: expect.any(Date) },
      });
    });

    it("ACKs a redelivery of a COMPLETED event without re-running handlers", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_done"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "COMPLETED",
        processingStartedAt: new Date("2020-01-01T00:00:00.000Z"),
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ received: true });
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      // A completed dup neither re-marks nor releases the claim.
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
    });

    it("forces a provider retry (500) for a redelivery still inside the lease window (crash-window fix)", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_inflight"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // A sibling attempt claimed it one minute ago and is still in flight.
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 60 * 1000),
      });

      const response = await POST(makeRequest());

      // Not ACKed: the in-flight (possibly-doomed) attempt owns it; Stripe
      // must redeliver rather than drop the event.
      expect(response.status).toBe(500);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      // We never take over a live lease, so no takeover update and no release.
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).not.toHaveBeenCalled();
    });

    it("takes over an expired lease (a crashed prior attempt) and reprocesses", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_expired"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // Claimed 30 minutes ago and never completed: past the 15-minute lease.
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 30 * 60 * 1000),
      });
      // The conditional takeover update wins.
      mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 1 });
      armPaidBooking();

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // First updateMany is the lease takeover on the expired claim.
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_expired",
          status: "PROCESSING",
          processingStartedAt: { lt: expect.any(Date) },
        },
        data: { processingStartedAt: expect.any(Date), eventType: "payment_intent.succeeded" },
      });
      // The handler runs on takeover, then the claim is marked COMPLETED —
      // fenced on the takeover's own processingStartedAt (F16 fence, #1887).
      expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith({
        where: {
          source: "stripe",
          eventId: "evt_expired",
          status: "PROCESSING",
          processingStartedAt: expect.any(Date),
        },
        data: { status: "COMPLETED", processedAt: expect.any(Date) },
      });
    });

    it("forces a retry (500) when it loses the expired-lease takeover race", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_race"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 30 * 60 * 1000),
      });
      // Another racer took the lease first: our conditional update matches 0 rows.
      mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 0 });

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
    });

    it("forces a retry (500) when the claim was raced away between insert and read", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_gone"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // A sibling attempt failed and deleted its claim between our insert and read.
      mockProcessedWebhookFindFirst.mockResolvedValue(null);

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
    });

    it("releases the claim (delete) and does NOT mark COMPLETED when a handler throws", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_throw"));
      mockProcessedWebhookCreate.mockResolvedValue({});
      mockFindPaymentTransactionByIntentId.mockRejectedValue(
        new Error("database unavailable"),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      // Fenced (F16 fence, #1887): the release keys on status + the claimed
      // processingStartedAt, so it only removes the lease this attempt owns.
      const claimToken =
        mockProcessedWebhookCreate.mock.calls[0]![0].data.processingStartedAt;
      expect(claimToken).toBeInstanceOf(Date);
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith({
        where: {
          eventId: "evt_throw",
          source: "stripe",
          status: "PROCESSING",
          processingStartedAt: claimToken,
        },
      });
      // A failed attempt must never leave a COMPLETED marker behind.
      expect(mockProcessedWebhookUpdateMany).not.toHaveBeenCalled();
    });

    it("records the in-progress lease contention 500 for telemetry (F16 LOW, #1887)", async () => {
      mockConstructWebhookEvent.mockReturnValue(succeededEvent("evt_busy"));
      mockProcessedWebhookCreate.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      // A sibling attempt holds a live lease.
      mockProcessedWebhookFindFirst.mockResolvedValue({
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 60 * 1000),
      });

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      // The otherwise-invisible concurrent-redelivery 500 is logged.
      expect(mockRecordWebhookLog).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "stripe",
          eventId: "evt_busy",
          status: "failure",
          error: expect.stringContaining("in progress"),
        }),
      );
    });
  });
  // #3266 / INV-PAY-052 — a redelivered setup_intent.succeeded (Stripe retries
  // for up to three days; the dedupe knows only events already handled) must not
  // put a retired card back, and setup_intent.canceled must keep the intent id
  // so the next mint's idempotency key chains from it.
  describe("SetupIntent webhooks (#3266)", () => {
    const setupIntentEvent = (
      type: "setup_intent.succeeded" | "setup_intent.canceled",
      overrides: Record<string, unknown> = {},
    ) => ({
      id: `evt_${type}_1`,
      type,
      data: {
        object: {
          id: "seti_1",
          payment_method: "pm_1",
          customer: "cus_1",
          metadata: { bookingId: "booking-1" },
          ...overrides,
        },
      },
    });

    const rowNaming = (stripeSetupIntentId: string, stripePaymentMethodId: string | null) => ({
      stripeSetupIntentId,
      stripePaymentMethodId,
      stripeCustomerId: "cus_1",
    });

    it("stamps the card when the row still names the intent, has no card, and Stripe still holds the card for the customer", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_1", null));
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: "cus_1" });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockPaymentFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { bookingId: "booking-1" } }),
      );
      expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_1");
      expect(mockMarkBookingSetupIntentSucceeded).toHaveBeenCalledWith({
        bookingId: "booking-1",
        setupIntentId: "seti_1",
        paymentMethodId: "pm_1",
      });
    });

    it("does NOT stamp when the row has moved on to another intent (stale redelivery)", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_2_replacement", null));

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockGetPaymentMethod).not.toHaveBeenCalled();
      expect(mockMarkBookingSetupIntentSucceeded).not.toHaveBeenCalled();
    });

    it("does NOT stamp when there is no payment row for the booking", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(null);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockMarkBookingSetupIntentSucceeded).not.toHaveBeenCalled();
    });

    it("does NOT re-adopt a card Stripe no longer holds for the customer (retired by a terminal refusal, #3268)", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_1", null));
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: null });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_1");
      expect(mockMarkBookingSetupIntentSucceeded).not.toHaveBeenCalled();
    });

    it("does NOT re-adopt a card Stripe no longer has at all (resource_missing)", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_1", null));
      mockGetPaymentMethod.mockRejectedValue(
        Object.assign(new Error("No such PaymentMethod: 'pm_1'"), {
          type: "StripeInvalidRequestError",
          code: "resource_missing",
          statusCode: 404,
        }),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockMarkBookingSetupIntentSucceeded).not.toHaveBeenCalled();
    });

    it("leaves the claim for a retry when Stripe fails for any other reason — not a verdict either way", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_1", null));
      mockGetPaymentMethod.mockRejectedValue(
        Object.assign(new Error("Stripe is unavailable"), { type: "StripeAPIError", statusCode: 503 }),
      );

      const response = await POST(makeRequest());

      expect(response.status).toBe(500);
      expect(mockMarkBookingSetupIntentSucceeded).not.toHaveBeenCalled();
      expect(mockProcessedWebhookDeleteMany).toHaveBeenCalled();
    });

    it("has nothing to do when the row already carries this intent's own card, and does not ask Stripe", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_1", "pm_1"));

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockGetPaymentMethod).not.toHaveBeenCalled();
      expect(mockMarkBookingSetupIntentSucceeded).not.toHaveBeenCalled();
    });

    it("asks Stripe when the row carries a DIFFERENT card, and stamps this intent's card only if it is still attached", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.succeeded") as any);
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_1", "pm_other"));
      mockGetPaymentMethod.mockResolvedValue({ id: "pm_1", customer: "cus_1" });

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockGetPaymentMethod).toHaveBeenCalledWith("pm_1");
      expect(mockMarkBookingSetupIntentSucceeded).toHaveBeenCalledWith({
        bookingId: "booking-1",
        setupIntentId: "seti_1",
        paymentMethodId: "pm_1",
      });
    });

    it("warns and writes nothing when a succeeded intent names no payment method", async () => {
      mockConstructWebhookEvent.mockReturnValue(
        setupIntentEvent("setup_intent.succeeded", { payment_method: null }) as any,
      );
      mockPaymentFindUnique.mockResolvedValue(rowNaming("seti_1", null));

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      expect(mockGetPaymentMethod).not.toHaveBeenCalled();
      expect(mockMarkBookingSetupIntentSucceeded).not.toHaveBeenCalled();
    });

    it("setup_intent.canceled writes NOTHING: the row keeps the intent id so the next mint chains its idempotency key", async () => {
      mockConstructWebhookEvent.mockReturnValue(setupIntentEvent("setup_intent.canceled") as any);

      const response = await POST(makeRequest());

      expect(response.status).toBe(200);
      // The prisma double here has no `payment.updateMany` at all, so a handler
      // that still nulled `stripeSetupIntentId` would throw and answer 500; the
      // explicit checks below say the same thing for the writers it does have.
      expect(mockPaymentUpdate).not.toHaveBeenCalled();
      expect(mockPaymentFindUnique).not.toHaveBeenCalled();
      expect(mockTransaction).not.toHaveBeenCalled();
      expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
      );
    });
  });
});

// #4104 (`INV-PAY-128`): Stripe's refund-failed signal reaches the refund's
// recorder, under the same once-per-event claim as every other event.
describe("a card refund Stripe accepted and failed later (#4104)", () => {
  const refund = { id: "re_late", object: "refund", amount: 4000, status: "failed", payment_intent: "pi_late", charge: "ch_late" };
  const request = () =>
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "test-sig" },
      body: JSON.stringify({}),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessedWebhookCreate.mockResolvedValue({});
    mockProcessedWebhookDeleteMany.mockResolvedValue({ count: 1 });
    mockProcessedWebhookUpdateMany.mockResolvedValue({ count: 1 });
    mockProcessedWebhookFindFirst.mockResolvedValue({ status: "COMPLETED", processingStartedAt: new Date("2020-01-01T00:00:00.000Z") });
    mockRecordRefusedCardRefund.mockResolvedValue("recorded");
  });

  it.each(["refund.failed", "refund.updated", "charge.refund.updated"])("%s hands the refund to its recorder and is acknowledged", async (type) => {
    mockConstructWebhookEvent.mockReturnValue({ id: `evt_${type}`, type, data: { object: refund } } as any);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mockRecordRefusedCardRefund).toHaveBeenCalledTimes(1);
    expect(mockRecordRefusedCardRefund).toHaveBeenCalledWith(refund);
    expect(mockProcessedWebhookUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
    );
  });

  it("a repeat delivery of a finished event records nothing again", async () => {
    mockConstructWebhookEvent.mockReturnValue({ id: "evt_refund_failed", type: "refund.failed", data: { object: refund } } as any);
    mockProcessedWebhookCreate.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mockRecordRefusedCardRefund).not.toHaveBeenCalled();
  });

  it("a recorder that fails releases the claim and answers 500, so Stripe sends it again", async () => {
    mockConstructWebhookEvent.mockReturnValue({ id: "evt_refund_failed_retry", type: "refund.failed", data: { object: refund } } as any);
    mockRecordRefusedCardRefund.mockRejectedValue(new Error("recovery mid-attempt"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mockProcessedWebhookDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ eventId: "evt_refund_failed_retry", status: "PROCESSING" }) }),
    );
  });
});
