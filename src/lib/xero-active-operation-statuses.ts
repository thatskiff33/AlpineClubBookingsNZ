import type { XeroSyncOperation } from "@prisma/client";

/** Active correlation-key population of XeroSyncOperation_active_correlationKey_unique. */
export const XERO_ACTIVE_OPERATION_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_PAYMENT",
] as const satisfies readonly XeroSyncOperation["status"][];

/**
 * #4531 (`INV-SSOT`): a row that may still run - live, or FAILED/PARTIAL and so
 * retryable unless an officer resolved it in Xero (`manuallyResolvedAt`, the
 * query-side spelling of `isResolvedInXero`). Read with
 * `manuallyResolvedAt: null`.
 */
export const XERO_RERUNNABLE_OPERATION_STATUSES = [
  ...XERO_ACTIVE_OPERATION_STATUSES,
  "FAILED",
  "PARTIAL",
] as const satisfies readonly XeroSyncOperation["status"][];
