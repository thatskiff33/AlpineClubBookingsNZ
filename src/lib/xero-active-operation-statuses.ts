import type { Prisma, XeroSyncOperation } from "@prisma/client";

import { isResolvedInXero } from "@/lib/xero-operation-resolution";

/** Active correlation-key population of XeroSyncOperation_active_correlationKey_unique. */
export const XERO_ACTIVE_OPERATION_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_PAYMENT",
] as const satisfies readonly XeroSyncOperation["status"][];

/**
 * #4531 (`INV-SSOT`): the statuses of a row that is live or ended FAILED or
 * PARTIAL. Whether such a FAILED/PARTIAL row can actually run again also
 * depends on it being replayable and unresolved; `rerunnableOperationWhere`
 * says that. Callers that block on any such row whatever its replayability
 * (the applied-credit serialisation, the card-allocation busy check, the
 * receipt's queued-counts read) read this set directly.
 */
export const XERO_RERUNNABLE_OPERATION_STATUSES = [
  ...XERO_ACTIVE_OPERATION_STATUSES,
  "FAILED",
  "PARTIAL",
] as const satisfies readonly XeroSyncOperation["status"][];

/** The two statuses a retry claims from (`runWithClaimedOriginal`). */
const XERO_RETRYABLE_ENDED_STATUSES = ["FAILED", "PARTIAL"] as const satisfies readonly XeroSyncOperation["status"][];

/**
 * #4531 (PR #4596 review D1): the rows that may run again - live, or FAILED or
 * PARTIAL and still `replayable` (a retry claims only a replayable row, and a
 * REQUEUE row or one an officer marked non-replayable is not), and in either
 * case not resolved in Xero (`manuallyResolvedAt: null`, the query-side
 * spelling of `isResolvedInXero`).
 */
export function rerunnableOperationWhere(): Prisma.XeroSyncOperationWhereInput {
  return {
    manuallyResolvedAt: null,
    OR: [
      { status: { in: [...XERO_ACTIVE_OPERATION_STATUSES] } },
      { status: { in: [...XERO_RETRYABLE_ENDED_STATUSES] }, replayable: true },
    ],
  };
}

/**
 * #4494 (`INV-SSOT`): {@link rerunnableOperationWhere}'s rule for a row already
 * read - not resolved in Xero, and live, or FAILED or PARTIAL and still
 * replayable. The one in-memory spelling; a test holds the two in agreement.
 */
export function isRerunnableOperation(row: {
  status: string;
  replayable: boolean;
  manuallyResolvedAt: Date | string | null;
}): boolean {
  if (isResolvedInXero(row)) return false;
  const live = (XERO_ACTIVE_OPERATION_STATUSES as readonly string[]).includes(row.status);
  return live || ((XERO_RETRYABLE_ENDED_STATUSES as readonly string[]).includes(row.status) && row.replayable);
}
