// Shared type contracts for the Xero hardening subsystem (canonical-link
// reconciliation, repeated-failure alerts, reconciliation report, and
// historical backfill). Extracted verbatim from xero-hardening.ts as the
// type-only leaf of the #1208 item-5 split; the entry re-exports the public
// subset while the two shared private record types stay internal to the
// concern modules that consume them.

export interface CanonicalLinkExpectation {
  localModel: string;
  localId: string;
  role: string;
  xeroObjectType: string;
  xeroObjectId: string;
}

export type CanonicalLinkRecord = Pick<
  CanonicalLinkExpectation,
  "localModel" | "localId" | "role" | "xeroObjectType" | "xeroObjectId"
>;

export interface XeroRepeatedFailureSummary {
  correlationKey: string;
  failureCount: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  latestErrorMessage: string | null;
  latestOperationId: string;
  latestOperationStatus: string;
  latestOperationCreatedAt: Date;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
}

export interface XeroUnsupportedPartialSummary {
  operationId: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  reason: string;
  createdAt: Date;
}

export type XeroReconciliationIssueSeverity = "critical" | "warning" | "info";

export interface XeroReconciliationIssueItem {
  label: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  operationId: string | null;
  operationStatus: string | null;
  operationType: string | null;
  correlationKey: string | null;
  detail: string | null;
  latestErrorMessage: string | null;
  createdAt: Date | null;
}

export interface XeroReconciliationIssueSection {
  id: string;
  title: string;
  severity: XeroReconciliationIssueSeverity;
  count: number;
  whatWentWrong: string;
  howToFix: string;
  items: XeroReconciliationIssueItem[];
}

export interface XeroReconciliationReport {
  generatedAt: Date;
  lookbackHours: number;
  stalePendingMinutes: number;
  summary: {
    missingMemberContactLinks: number;
    missingPaymentInvoiceLinks: number;
    missingPaymentRefundCreditNoteLinks: number;
    missingSubscriptionInvoiceLinks: number;
    mismatchedCanonicalLinks: number;
    staleCanonicalLinks: number;
    duplicateActiveCanonicalLinks: number;
    /**
     * Stripe payments whose ACTIVE, non-cancelled refund credit-note coverage
     * exceeds `refundedAmountCents` (#2901 fix round). No other detector sees
     * over-coverage: the health snapshot flags only under-coverage, and the
     * outbox caps an over-covered payment's next note at zero silently.
     */
    overCoveredStripeRefundPayments: number;
    /** #3548: refund notes with no settlement on record, or part-settled in Xero. */
    unsettledRefundCreditNotes: number;
    stalePendingOperations: number;
    recentFailedOperations: number;
    recentPartialOperations: number;
    unsupportedPartialOperations: number;
    repeatedFailureCorrelations: number;
    failedInboundEvents: number;
    /**
     * #3635 (`INV-INT-025`): failed or partial operations in the lookback
     * window that an officer resolved in Xero. Not an issue and not counted in
     * the failure figures above; the repair tool reports each at info level.
     * Report data only: the emailed digest does not show it.
     */
    resolvedInXeroOperations: number;
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  issueSections: XeroReconciliationIssueSection[];
  repeatedFailures: XeroRepeatedFailureSummary[];
  unsupportedPartials: XeroUnsupportedPartialSummary[];
}

export interface XeroLinkBackfillCategoryResult {
  scanned: number;
  existingLinks: number;
  createdLinks: number;
  existingOperations: number;
  createdOperations: number;
}

export interface XeroHistoricalBackfillResult {
  completedAt: Date;
  members: XeroLinkBackfillCategoryResult;
  paymentInvoices: XeroLinkBackfillCategoryResult;
  paymentRefundCreditNotes: XeroLinkBackfillCategoryResult;
  subscriptionInvoices: XeroLinkBackfillCategoryResult;
  totals: {
    scanned: number;
    createdLinks: number;
    createdOperations: number;
  };
}

export interface XeroCanonicalLinkCleanupResult {
  completedAt: Date;
  scannedActiveLinks: number;
  keptActiveLinks: number;
  deactivatedLinks: number;
  /**
   * Active Stripe per-delta REFUND_CREDIT_NOTE links the source-aware cleanup
   * deliberately left alone (#2901, INV-ADDPAY-020). Observability only.
   */
  preservedStripeRefundCreditNoteLinks: number;
  byCategory: {
    memberContacts: number;
    paymentInvoices: number;
    paymentRefundCreditNotes: number;
    subscriptionInvoices: number;
    otherCanonicalLinks: number;
  };
  deactivatedLinkIds: string[];
}
