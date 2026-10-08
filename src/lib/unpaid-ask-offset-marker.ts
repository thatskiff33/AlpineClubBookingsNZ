/**
 * #3954: WHAT A PRICE REDUCTION SET AGAINST AN UNPAID ASK, as the edit's own
 * history row records it, and the code the increase's retired Xero invoice
 * carries. Pure - no client, no `server-only` - because the booking-vs-Xero
 * repair pass, an operator CLI, reads both (`xero-booking-repair-classify.ts`).
 *
 * The record is `BookingModification.newData` (JSON, no migration), under one
 * key written only here, exactly as #3809's give-back is recorded
 * (`booking-credit-give-back-marker.ts`): the repair pass sizes a reduction's
 * credit note off the modification row, and without this it would ask for a
 * note covering money that cancelled an ask and was never paid.
 */

const HISTORY_KEY = "unpaidAskOffsetCents" as const;

/**
 * The Xero supplementary invoice an increase parked on its card ask, retired
 * because a later reduction cancelled or re-issued that ask before it was paid.
 * A late capture never revives it: only the reaper's codes are revived, and a
 * capture of a retired ask is refunded.
 */
export const ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE =
  "ADDITIONAL_ASK_RETIRED_BY_REDUCTION";

/**
 * The booking-vs-Xero repair pass's reading of an increase whose supplementary
 * invoice a later reduction retired: the money it was for is no longer owed -
 * wholly, or all but a smaller re-issued ask - so it is reported for a person,
 * never queued as a one-click invoice for the edit's whole figure.
 */
export function isAskRetiredByReductionOperation(operation: {
  entityType: string;
  operationType: string;
  status: string;
  lastErrorCode: string | null;
}): boolean {
  return (
    operation.entityType === "INVOICE" &&
    operation.operationType === "CREATE" &&
    operation.status === "CANCELLED" &&
    operation.lastErrorCode === ADDITIONAL_ASK_RETIRED_BY_REDUCTION_XERO_ERROR_CODE
  );
}

export const ASK_RETIRED_BY_REDUCTION_SUMMARY =
  "A later change lowered this booking's price before the member paid the extra this edit asked for, so that card request was cancelled or made smaller and its supplementary Xero invoice was retired. Check the booking's later changes and payments before raising any invoice for this edit.";

/**
 * #3954 "retry nets it off": the increases whose card ask had not been minted
 * yet - its mint failed and waited on a recovery - when this reduction netted
 * it off. Those increases have no parked invoice to carry the retired code, so
 * the reduction names them.
 */
const RETIRED_PENDING_ASKS_KEY = "unpaidAskRetiredModificationIds" as const;

/** The `newData` fields an edit writes for what of its reduction an unpaid ask took, or none. */
export function unpaidAskOffsetHistory(settled: {
  unpaidAskOffsetCents: number;
  retiredPendingAskModificationIds: readonly string[];
}): { [HISTORY_KEY]?: number; [RETIRED_PENDING_ASKS_KEY]?: string[] } {
  if (settled.unpaidAskOffsetCents <= 0) return {};
  return {
    [HISTORY_KEY]: settled.unpaidAskOffsetCents,
    ...(settled.retiredPendingAskModificationIds.length > 0
      ? { [RETIRED_PENDING_ASKS_KEY]: [...settled.retiredPendingAskModificationIds] }
      : {}),
  };
}

function historyRecord(newData: unknown): Record<string, unknown> | null {
  return newData && typeof newData === "object" && !Array.isArray(newData)
    ? (newData as Record<string, unknown>)
    : null;
}

/** The offset an edit's history row records, or 0. */
export function recordedUnpaidAskOffsetCents(newData: unknown): number {
  const value = historyRecord(newData)?.[HISTORY_KEY];
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

/**
 * Whether a later reduction netted off this increase's unminted ask - the
 * repair pass's reading for an increase with no parked invoice to look at.
 */
export function isPendingAskRetiredByReduction(
  modificationId: string,
  modifications: readonly { newData: unknown }[],
): boolean {
  return modifications.some((modification) => {
    const ids = historyRecord(modification.newData)?.[RETIRED_PENDING_ASKS_KEY];
    return Array.isArray(ids) && ids.includes(modificationId);
  });
}
