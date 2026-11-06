import type { DeletedPaymentRecheckOutcome } from "./deleted-payment-links";


export interface StoredXeroInboundEvent {
  id: string;
  source: string;
  eventCategory: string | null;
  eventType: string;
  resourceId: string | null;
  correlationKey: string;
  payload: unknown;
  status: string;
  updatedAt?: Date | null;
}

export interface ResolvedXeroObjectLink {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  role: string;
}

export interface XeroAuditLocalLink {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  role: string;
}

export interface CreditNoteAmounts {
  total?: number | null;
  appliedAmount?: number | null;
  remainingCredit?: number | null;
}

export interface AccountCreditAllocationTarget {
  invoiceId: string;
  amountCents: number;
}

export interface AccountCreditAllocationRepairResult {
  matchedPayments: number;
  createdAppliedCredits: number;
  updatedAppliedCredits: number;
  updatedAppliedPayments: number;
  skippedAllocations: number;
}

export interface RefundedPaymentBusinessStateRepairResult {
  matchedPayments: number;
  updatedPayments: number;
  /** #4095: the payments whose claim was lost twice, so nothing was written; absent when none. */
  unsettledPaymentIds?: string[];
}

export interface ProcessStoredXeroInboundEventsResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface IncrementalMembershipReconciliationResult {
  seasonYear: number;
  cursorFrom: string | null;
  cursorTo: string | null;
  changedInvoices: number;
  changedInvoiceIds: string[];
  affectedMembers: number;
  checked: number;
  updated: number;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
  skipped?: boolean;
  reason?: string;
}

export interface IncrementalContactReconciliationResult {
  cursorFrom: string | null;
  cursorTo: string | null;
  total: number;
  created: number;
  updated: number;
  skippedNoChanges: number;
  skippedNoEmail: number;
  skippedOther: number;
  errors: number;
  skipped?: boolean;
  reason?: string;
}

export interface IncrementalInvoiceReconciliationResult {
  processed: number;
  succeeded: number;
  failed: number;
  errorDetails: Array<{ invoiceId: string; error: string }>;
  skipped?: boolean;
  reason?: string;
}

export interface RunXeroInboundReconciliationCycleResult {
  inbound: ProcessStoredXeroInboundEventsResult & {
    batches: number;
  };
  contactReconciliation: IncrementalContactReconciliationResult | null;
  membershipReconciliation: IncrementalMembershipReconciliationResult | null;
  invoiceReconciliation: IncrementalInvoiceReconciliationResult | null;
  /** #4531: the scheduled re-check of links pending a deleted-payment check; an error message when it failed. */
  deletedPaymentRecheck?: DeletedPaymentRecheckOutcome | { error: string } | null;
}

export class XeroInboundReplayError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "XeroInboundReplayError";
    this.status = status;
  }
}
