// Injectable dependency table for the booking-vs-Xero repair tool. Extracted
// verbatim from xero-booking-repair.ts (#1208 item 2). Imports each source
// domain module directly, never the @/lib/xero facade (#1208).
import {
  cancelPaymentIntentIfCancellable,
  getPaymentIntent,
} from "@/lib/stripe";
import {
  enqueueXeroAccountCreditNoteOperation,
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
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  markPaymentIntentTransactionFailed,
  refundPaymentTransactions,
} from "@/lib/payment-transactions";

export type RepairDependencies = {
  prisma: typeof prisma;
  enqueueXeroBookingInvoiceOperation: typeof enqueueXeroBookingInvoiceOperation;
  enqueueXeroBookingInvoiceUpdateOperation: typeof enqueueXeroBookingInvoiceUpdateOperation;
  enqueueXeroSupplementaryInvoiceOperation: typeof enqueueXeroSupplementaryInvoiceOperation;
  enqueueXeroModificationCreditNoteOperation: typeof enqueueXeroModificationCreditNoteOperation;
  enqueueXeroAccountCreditNoteOperation: typeof enqueueXeroAccountCreditNoteOperation;
  enqueueXeroRefundCreditNoteOperation: typeof enqueueXeroRefundCreditNoteOperation;
  enqueueXeroCreditNoteAllocationOperation: typeof enqueueXeroCreditNoteAllocationOperation;
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
};

const defaultDependencies: RepairDependencies = {
  prisma,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroCreditNoteAllocationOperation,
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
};

export function getDependencies(overrides?: Partial<RepairDependencies>): RepairDependencies {
  return {
    ...defaultDependencies,
    ...overrides,
  };
}
