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

/**
 * The booking-vs-Xero repair pass's summary for an increase whose parked
 * supplementary invoice carries the retired code but which no reduction's
 * history names (#3954 review round 4). Only the retired-invoice path can reach
 * it - an ask netted off before it minted is always named by its reduction and
 * is accounted for there - so the sentence is true where it is said (Xero lens F4).
 */
export const ASK_RETIRED_BY_REDUCTION_SUMMARY =
  "A later change lowered this booking's price before the member paid the extra this edit asked for, so that card request was cancelled or made smaller and its supplementary Xero invoice was retired. Check the booking's later changes and payments before raising any invoice for this edit.";

/** The repair pass's summary for a re-issued ask with no supplementary invoice (amount in the details). */
export const REISSUED_ASK_INVOICE_MISSING_SUMMARY =
  "This change made the member's unpaid extra payment smaller, and the smaller request has no supplementary Xero invoice. Raise one for the amount shown, waiting on that card request, or check whether the member has already paid it.";

/**
 * #3954 "retry nets it off" and review round 4: the increases whose unpaid ask
 * this reduction retired - an ask's parked supplementary invoice it cancelled,
 * or an ask still waiting on its failed mint's recovery it closed. The repair
 * pass reads the reduction, not the increase, for what Xero is owed for them.
 */
const RETIRED_PENDING_ASKS_KEY = "unpaidAskRetiredModificationIds" as const;

/**
 * #3954 decision A (owner, 9 Oct 2026, "Raise a $30 invoice"): what the
 * supplementary invoice for this reduction's smaller re-issued ask bills -
 * raised once that ask is minted, waiting on it (`queueReissuedAskSupplementaryInvoice`).
 * It is the retired asks' invoiced money less the offset, never more than the
 * re-issued ask: money the booking's primary invoice already billed is not
 * billed twice.
 */
const REISSUED_ASK_INVOICE_KEY = "reissuedAskInvoiceCents" as const;

/**
 * #3954 review round 4: the part of the offset Xero had ALREADY billed - the
 * primary invoice was raised after the increase, so it carries the ask. Owner
 * decision 10 Oct 2026 ("Auto credit note"): the edit queues a scoped
 * invoice-correction note for exactly this figure against the primary invoice
 * (`queueUnpaidAskBilledOffsetNote`), and the repair pass verifies or queues it.
 */
const BILLED_OFFSET_KEY = "unpaidAskBilledOffsetCents" as const;

/** The `newData` fields an edit writes for what of its reduction an unpaid ask took, or none. */
export function unpaidAskOffsetHistory(settled: {
  unpaidAskOffsetCents: number;
  retiredAskModificationIds: readonly string[];
  reissuedAskInvoiceCents: number;
  unpaidAskBilledOffsetCents: number;
}): {
  [HISTORY_KEY]?: number;
  [RETIRED_PENDING_ASKS_KEY]?: string[];
  [REISSUED_ASK_INVOICE_KEY]?: number;
  [BILLED_OFFSET_KEY]?: number;
} {
  if (settled.unpaidAskOffsetCents <= 0) return {};
  return {
    [HISTORY_KEY]: settled.unpaidAskOffsetCents,
    ...(settled.retiredAskModificationIds.length > 0
      ? { [RETIRED_PENDING_ASKS_KEY]: [...settled.retiredAskModificationIds] }
      : {}),
    ...(settled.reissuedAskInvoiceCents > 0 ? { [REISSUED_ASK_INVOICE_KEY]: settled.reissuedAskInvoiceCents } : {}),
    ...(settled.unpaidAskBilledOffsetCents > 0 ? { [BILLED_OFFSET_KEY]: settled.unpaidAskBilledOffsetCents } : {}),
  };
}

function historyRecord(newData: unknown): Record<string, unknown> | null {
  return newData && typeof newData === "object" && !Array.isArray(newData)
    ? (newData as Record<string, unknown>)
    : null;
}

function recordedPositiveCents(newData: unknown, key: string): number {
  const value = historyRecord(newData)?.[key];
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

/** The offset an edit's history row records, or 0. */
export function recordedUnpaidAskOffsetCents(newData: unknown): number {
  return recordedPositiveCents(newData, HISTORY_KEY);
}

/** What a reduction's re-issued ask's supplementary invoice bills, or 0 (decision A). */
export function recordedReissuedAskInvoiceCents(newData: unknown): number {
  return recordedPositiveCents(newData, REISSUED_ASK_INVOICE_KEY);
}

/** The part of a reduction's offset Xero had already billed, or 0. */
export function recordedUnpaidAskBilledOffsetCents(newData: unknown): number {
  return recordedPositiveCents(newData, BILLED_OFFSET_KEY);
}

/**
 * The reduction whose history names this modification as one whose unpaid ask
 * it retired, or null - the repair pass's reading for an increase whose
 * invoice a reduction retired, or whose ask it netted off before it minted.
 */
export function retiringReductionFor<M extends { id: string; newData: unknown }>(
  modificationId: string,
  modifications: readonly M[],
): M | null {
  return (
    modifications.find((modification) => {
      const ids = historyRecord(modification.newData)?.[RETIRED_PENDING_ASKS_KEY];
      return Array.isArray(ids) && ids.includes(modificationId);
    }) ?? null
  );
}
