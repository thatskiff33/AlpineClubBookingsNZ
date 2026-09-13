import { getCancellationSettlementBreakdown } from "@/lib/payment-status-display";

export const paymentSourceFilters = ["all", "STRIPE", "INTERNET_BANKING", "NONE"] as const;
export type PaymentSourceFilter = (typeof paymentSourceFilters)[number];

export const paymentApiSourceFilters = ["all", "STRIPE", "INTERNET_BANKING"] as const;

export const xeroStateFilters = [
  "all",
  "invoiceLinked",
  "invoiceMissing",
  "operationFailed",
  "operationPartial",
  "operationPending",
] as const;
export type XeroStateFilter = (typeof xeroStateFilters)[number];
export type XeroState = Exclude<XeroStateFilter, "all"> | "none";

export const settlementFilters = [
  "all",
  "none",
  "cardRefund",
  "accountCredit",
  "mixed",
  "restoredCredit",
] as const;
export type SettlementFilter = (typeof settlementFilters)[number];
export type SettlementKind = Exclude<SettlementFilter, "all">;

export interface XeroActivityOperationLike {
  id: string;
  status: string;
  createdAt: Date;
  localModel?: string | null;
  localId?: string | null;
}

export interface XeroActivitySummary {
  failed: number;
  partial: number;
  pending: number;
  latestOperationId: string | null;
  latestOperationStatus: string | null;
  latestOperationAt: string | null;
}

export function emptyXeroActivitySummary(): XeroActivitySummary {
  return {
    failed: 0,
    partial: 0,
    pending: 0,
    latestOperationId: null,
    latestOperationStatus: null,
    latestOperationAt: null,
  };
}

function summarizeXeroActivity(
  operations: XeroActivityOperationLike[]
): XeroActivitySummary {
  const summary = emptyXeroActivitySummary();

  for (const operation of operations) {
    if (operation.status === "FAILED") {
      summary.failed += 1;
    } else if (operation.status === "PARTIAL") {
      summary.partial += 1;
    } else if (
      operation.status === "PENDING" ||
      operation.status === "RUNNING" ||
      operation.status === "WAITING_PAYMENT"
    ) {
      summary.pending += 1;
    }

    const currentLatest = summary.latestOperationAt
      ? new Date(summary.latestOperationAt)
      : null;
    if (!currentLatest || operation.createdAt > currentLatest) {
      summary.latestOperationId = operation.id;
      summary.latestOperationStatus = operation.status;
      summary.latestOperationAt = operation.createdAt.toISOString();
    }
  }

  return summary;
}

export function buildXeroActivityByRecord(
  operations: XeroActivityOperationLike[]
): Map<string, XeroActivitySummary> {
  const operationsByRecord = new Map<string, XeroActivityOperationLike[]>();

  for (const operation of operations) {
    if (!operation.localModel || !operation.localId) continue;

    const key = `${operation.localModel}:${operation.localId}`;
    const current = operationsByRecord.get(key) ?? [];
    current.push(operation);
    operationsByRecord.set(key, current);
  }

  return new Map(
    [...operationsByRecord.entries()].map(([key, recordOperations]) => [
      key,
      summarizeXeroActivity(recordOperations),
    ])
  );
}

export function mergeXeroActivitySummaries(
  summaries: XeroActivitySummary[]
): XeroActivitySummary {
  const operations: XeroActivityOperationLike[] = [];

  for (const summary of summaries) {
    if (!summary.latestOperationId || !summary.latestOperationStatus || !summary.latestOperationAt) {
      continue;
    }
    operations.push({
      id: summary.latestOperationId,
      status: summary.latestOperationStatus,
      createdAt: new Date(summary.latestOperationAt),
    });
  }

  const merged = summarizeXeroActivity(operations);
  merged.failed = summaries.reduce((total, summary) => total + summary.failed, 0);
  merged.partial = summaries.reduce((total, summary) => total + summary.partial, 0);
  merged.pending = summaries.reduce((total, summary) => total + summary.pending, 0);
  return merged;
}

/**
 * The PAYMENT statuses for which Admin > Payments expects a Xero invoice to
 * exist, and therefore the statuses at which it reports `invoiceMissing`.
 *
 * Extracted from the inline array `listAdminPayments` used (#2377) so there is
 * ONE definition rather than two. The screen owns the meaning of `xeroState`,
 * and AI Diagnostics reports the same field name for the same payment — a second
 * copy of this list is how the diagnostic answer and the screen the operator then
 * opens come to disagree about whether an invoice is missing.
 *
 * It is deliberately a PAYMENT-status test and not a booking-lifecycle one: an
 * invoice is minted against money that moved. A booking-lifecycle expectation is
 * a different and wider question, and the diagnostics pack asks it separately
 * with `isSettledBookingStatus` rather than by widening this.
 */
const XERO_INVOICE_EXPECTED_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

export function isXeroInvoiceExpectedPaymentStatus(
  status: string | null | undefined
): boolean {
  return (
    status != null &&
    (XERO_INVOICE_EXPECTED_PAYMENT_STATUSES as readonly string[]).includes(status)
  );
}

export function deriveXeroState(input: {
  invoiceExpected: boolean;
  invoiceLinked: boolean;
  activity: XeroActivitySummary;
}): XeroState {
  if (input.activity.failed > 0) return "operationFailed";
  if (input.activity.partial > 0) return "operationPartial";
  if (input.activity.pending > 0) return "operationPending";
  if (input.invoiceLinked) return "invoiceLinked";
  if (input.invoiceExpected) return "invoiceMissing";
  return "none";
}

export function matchesXeroStateFilter(
  state: XeroState,
  filter: XeroStateFilter
): boolean {
  return filter === "all" || state === filter;
}

export function deriveSettlementKind(input: {
  refundedAmountCents: number;
  credits: Array<{ amountCents: number; description?: string | null }>;
}): SettlementKind {
  const settlement = getCancellationSettlementBreakdown(
    input.refundedAmountCents,
    input.credits
  );
  const buckets = [
    settlement.refundToOriginalMethodCents > 0 ? "cardRefund" : null,
    settlement.accountCreditCents > 0 ? "accountCredit" : null,
    settlement.restoredAppliedCreditCents > 0 ? "restoredCredit" : null,
  ].filter((value): value is Exclude<SettlementKind, "none" | "mixed"> =>
    Boolean(value)
  );

  if (buckets.length === 0) return "none";
  if (buckets.length > 1) return "mixed";
  const [onlyBucket] = buckets;
  if (!onlyBucket) {
    // Unreachable: `buckets.length` is checked to be exactly 1 above.
    throw new Error("Settlement bucket list had length 1 but no element");
  }
  return onlyBucket;
}

export function matchesSettlementFilter(
  kind: SettlementKind,
  filter: SettlementFilter
): boolean {
  return filter === "all" || kind === filter;
}
