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

/** The `newData` field an edit writes for the part of its reduction an unpaid ask took, or none. */
export function unpaidAskOffsetHistory(offsetCents: number): { [HISTORY_KEY]?: number } {
  return offsetCents > 0 ? { [HISTORY_KEY]: offsetCents } : {};
}

/** The offset an edit's history row records, or 0. */
export function recordedUnpaidAskOffsetCents(newData: unknown): number {
  const value =
    newData && typeof newData === "object" && !Array.isArray(newData)
      ? (newData as Record<string, unknown>)[HISTORY_KEY]
      : null;
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 0;
}
