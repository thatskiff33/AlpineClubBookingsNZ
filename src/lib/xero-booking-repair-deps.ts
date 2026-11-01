// Injectable dependency table for the booking-vs-Xero repair tool. Extracted
// verbatim from xero-booking-repair.ts (#1208 item 2). Imports each source
// domain module directly, never the @/lib/xero facade (#1208).
import {
  cancelPaymentIntentIfCancellable,
  getPaymentIntent,
} from "@/lib/stripe";
import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  processQueuedXeroOutboxOperations,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
} from "@/lib/xero-operation-outbox";
import {
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries,
} from "@/lib/xero-operation-queue";
import { prisma } from "@/lib/prisma";
import { enqueueXeroKeptLateCaptureInvoiceOperation } from "@/lib/xero-kept-late-capture-invoice";
import { enqueueAdditionalCaptureReceiptOperation } from "@/lib/additional-capture-receipt-enqueue";
import { planKeptLateCaptureXeroRecord } from "@/lib/late-capture-kept-xero";
import {
  queueWaitingPaidAnotherWayNote,
  readPaidAnotherWayReceiptState,
} from "@/lib/paid-another-way-receipt-note";
import { recordAndNoteRepairedLateCaptureRefunds } from "@/lib/late-capture-repair-refund-record";
import { readLateCaptureCardRefundsByHand } from "@/lib/late-capture-card-refund-by-hand";
import { readRefundCreditNoteGap } from "@/lib/xero-admin-health";
import { enqueueXeroRefundRequestCreditNoteOperation } from "@/lib/xero-refund-request-credit-note-outbox";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { finishRefundCreditNoteSettlement } from "@/lib/xero-refund-note-settlement";
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  markPaymentIntentTransactionFailed,
  refundPaymentTransactions,
} from "@/lib/payment-transactions";

export type RepairDependencies = {
  prisma: typeof prisma;
  enqueueXeroBookingInvoiceOperation: typeof enqueueXeroBookingInvoiceOperation;
  enqueueXeroBookingInvoiceUpdateOperation: typeof enqueueXeroBookingInvoiceUpdateOperation;
  // #3635: a kept late capture's own invoice, anchored on its approval task.
  enqueueXeroKeptLateCaptureInvoiceOperation: typeof enqueueXeroKeptLateCaptureInvoiceOperation;
  // #3953: a change's card capture's own receipt, keyed by its intent.
  enqueueAdditionalCaptureReceiptOperation: typeof enqueueAdditionalCaptureReceiptOperation;
  // #4324: the keep's one decision of which document records a kept capture.
  planKeptLateCaptureXeroRecord: typeof planKeptLateCaptureXeroRecord;
  enqueueXeroSupplementaryInvoiceOperation: typeof enqueueXeroSupplementaryInvoiceOperation;
  enqueueXeroModificationCreditNoteOperation: typeof enqueueXeroModificationCreditNoteOperation;
  enqueueXeroAccountCreditNoteOperation: typeof enqueueXeroAccountCreditNoteOperation;
  enqueueXeroRefundCreditNoteOperation: typeof enqueueXeroRefundCreditNoteOperation;
  // #4231 (`INV-PAY-118`): a refund request's own note, keyed by the request.
  enqueueXeroRefundRequestCreditNoteOperation: typeof enqueueXeroRefundRequestCreditNoteOperation;
  enqueueXeroCreditNoteAllocationOperation: typeof enqueueXeroCreditNoteAllocationOperation;
  // #3836: an unallocated credit-only card invoice's allocation.
  enqueueXeroAppliedCreditAllocationOperation: typeof enqueueXeroAppliedCreditAllocationOperation;
  enqueueXeroSyncOperationRetry: typeof enqueueXeroSyncOperationRetry;
  // #3187 fix round: the repair pass releases a supplementary invoice it has
  // just parked on a PaymentIntent that turns out to be captured already - the
  // member paid between the sweep's snapshot and its enqueue. Injected rather
  // than imported directly so the tool's tests can observe the release, and it
  // is the LIVE settlement's own release function so the two legs cannot come
  // to disagree about what releasing means.
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent: typeof releaseXeroSupplementaryInvoiceOperationsForPaymentIntent;
  processQueuedXeroOutboxOperations: typeof processQueuedXeroOutboxOperations;
  processQueuedXeroOperationRetries: typeof processQueuedXeroOperationRetries;
  upsertXeroObjectLink: typeof upsertXeroObjectLink;
  isXeroConnected: typeof isXeroConnected;
  cancelPaymentIntentIfCancellable: typeof cancelPaymentIntentIfCancellable;
  getPaymentIntent: typeof getPaymentIntent;
  markPaymentIntentTransactionFailed: typeof markPaymentIntentTransactionFailed;
  refundPaymentTransactions: typeof refundPaymentTransactions;
  // #3635 C2: a repaired late-capture refund's record and per-capture note.
  recordAndNoteRepairedLateCaptureRefunds: typeof recordAndNoteRepairedLateCaptureRefunds;
  // #3635: the one refund-note gap reader, for the missing-refund-note arm.
  readRefundCreditNoteGap: typeof readRefundCreditNoteGap;
  // #3548: the one read-back-then-settle, for the operator-applied settle.
  finishRefundCreditNoteSettlement: typeof finishRefundCreditNoteSettlement;
  // #3924 round 8: a waiting paid-another-way close's receipt and note, and
  // the one note step that queues it once the receipt is in Xero.
  readPaidAnotherWayReceiptState: typeof readPaidAnotherWayReceiptState;
  queueWaitingPaidAnotherWayNote: typeof queueWaitingPaidAnotherWayNote;
  // #3924 round 12: a late capture's card refunds no note will answer.
  readLateCaptureCardRefundsByHand: typeof readLateCaptureCardRefundsByHand;
};

const defaultDependencies: RepairDependencies = {
  prisma,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroKeptLateCaptureInvoiceOperation,
  enqueueAdditionalCaptureReceiptOperation,
  planKeptLateCaptureXeroRecord,
  enqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroRefundRequestCreditNoteOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroSyncOperationRetry,
  releaseXeroSupplementaryInvoiceOperationsForPaymentIntent,
  processQueuedXeroOutboxOperations,
  processQueuedXeroOperationRetries,
  upsertXeroObjectLink,
  isXeroConnected,
  cancelPaymentIntentIfCancellable,
  getPaymentIntent,
  markPaymentIntentTransactionFailed,
  refundPaymentTransactions,
  recordAndNoteRepairedLateCaptureRefunds,
  readRefundCreditNoteGap,
  finishRefundCreditNoteSettlement,
  readPaidAnotherWayReceiptState,
  queueWaitingPaidAnotherWayNote,
  readLateCaptureCardRefundsByHand,
};

export function getDependencies(overrides?: Partial<RepairDependencies>): RepairDependencies {
  return {
    ...defaultDependencies,
    ...overrides,
  };
}
