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

import { ownNoteExpected } from "@/lib/unpaid-ask-billed-offset-order";

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
  "A later change lowered this booking's price before the member paid the additional payment this edit asked for, so that card request was cancelled or made smaller and its supplementary Xero invoice was retired. Check the booking's later changes and payments before raising any invoice for this edit.";

/** The repair pass's summary for a re-issued ask with no supplementary invoice (amount in the details). */
export const REISSUED_ASK_INVOICE_MISSING_SUMMARY =
  "This change made the member's unpaid additional payment smaller, and the smaller request has no supplementary Xero invoice. Raise one for the amount shown, waiting on that card request, or check whether the member has already paid it.";

/**
 * #3954 "retry nets it off" and review round 4: the increases whose unpaid ask
 * this reduction retired - an ask's parked supplementary invoice it cancelled,
 * an ask still waiting on its failed mint's recovery it closed, or (round 8)
 * an ask's minted row it retired, named by the edit stamped on it. The repair
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

/**
 * #4049: WHETHER THE EDIT EXPECTED AN OWN NOTE BESIDE ITS BILLED-OFFSET NOTE -
 * the edit's own answer (`ownNoteExpected`), written beside `BILLED_OFFSET_KEY`
 * and only with it. The repair pass reads this rather than recomputing the
 * rule from what the history row cannot hold (an organiser's card refund, a
 * reduction the Xero leg returns nothing of): one rule, decided once, by the
 * edit (`INV-SSOT-001`). `true` or `false` when recorded; absent on a row
 * written before #4049.
 */
const BILLED_OFFSET_OWN_NOTE_EXPECTED_KEY = "unpaidAskBilledOffsetOwnNoteExpected" as const;

/**
 * #3954 round 6: the part of the offset the primary invoice may have billed,
 * where what it billed could not be established (`unpaidAskBillingEvidence`).
 * Never credit-noted: the repair pass reports it for a person.
 */
const BILLED_OFFSET_UNSURE_KEY = "unpaidAskBilledOffsetUnsureCents" as const;

/**
 * #3954 round 7: what the re-issued ask's own invoice may owe beyond
 * `REISSUED_ASK_INVOICE_KEY`, where the evidence was not established - the
 * money it could not place may have been supplementary money too. Never
 * invoiced automatically: the repair pass reports it for a person.
 */
const REISSUED_ASK_INVOICE_UNSURE_KEY = "reissuedAskInvoiceUnsureCents" as const;

/**
 * #3954 review round 6: the waiting re-issues a later INCREASE folded into its
 * own ask (`foldWaitingReissuedAsks`), recorded on that increase's history row
 * so nothing that reads the increase later loses them:
 *
 * - its mint's recovery replay asks for them again (`sizeRecoveryReplayAsk`) -
 *   their own recoveries were closed by the fold, so nothing else will;
 * - a later reduction that nets that replay off counts them, and their
 *   invoices (`recordedFoldedReissuedAskInvoiceCents`);
 * - each folded reduction's own supplementary invoice (decision A) is queued
 *   on the increase's minted intent (`queueFoldedReissuedAskInvoices`), and the
 *   repair pass reads it as accounted for (`foldingIncreaseFor`).
 */
const FOLDED_REISSUE_KEY = "foldedReissuedAskCents" as const;
const FOLDED_REISSUE_IDS_KEY = "foldedReissuedAskModificationIds" as const;
const FOLDED_REISSUE_INVOICE_KEY = "foldedReissuedAskInvoiceCents" as const;

/** What an increase folded in: the re-issues' money, their reducing edits, and their invoices' figure. */
export type FoldedReissuedAsks = {
  readonly cents: number;
  readonly modificationIds: readonly string[];
  readonly invoiceCents: number;
};

export const NO_FOLDED_REISSUED_ASKS: FoldedReissuedAsks = { cents: 0, modificationIds: [], invoiceCents: 0 };

/** An edit that set nothing against an unpaid ask - a guest add, which only folds. */
export const NO_UNPAID_ASK_SETTLEMENT = {
  hasIssuedXeroInvoice: false,
  xeroRefundAmountCents: 0,
  organiserChildRefund: null,
  unpaidAskOffsetCents: 0,
  retiredAskModificationIds: [] as readonly string[],
  reissuedAskInvoiceCents: 0,
  reissuedAskInvoiceUnsureCents: 0,
  unpaidAskBilledOffsetCents: 0,
  unpaidAskBilledOffsetUnsureCents: 0,
} as const;

/** The `newData` fields an edit writes for what of its reduction an unpaid ask took, or what its increase folded in, or none. */
export function unpaidAskOffsetHistory(settled: {
  /** #4049: the edit's own-note inputs (`ownNoteExpected`), recorded beside a billed offset. */
  hasIssuedXeroInvoice: boolean;
  xeroRefundAmountCents: number;
  organiserChildRefund: unknown;
  unpaidAskOffsetCents: number;
  retiredAskModificationIds: readonly string[];
  reissuedAskInvoiceCents: number;
  reissuedAskInvoiceUnsureCents: number;
  unpaidAskBilledOffsetCents: number;
  unpaidAskBilledOffsetUnsureCents: number;
  foldedReissuedAsks: FoldedReissuedAsks;
}): {
  [HISTORY_KEY]?: number;
  [RETIRED_PENDING_ASKS_KEY]?: string[];
  [REISSUED_ASK_INVOICE_KEY]?: number;
  [REISSUED_ASK_INVOICE_UNSURE_KEY]?: number;
  [BILLED_OFFSET_KEY]?: number;
  [BILLED_OFFSET_OWN_NOTE_EXPECTED_KEY]?: boolean;
  [BILLED_OFFSET_UNSURE_KEY]?: number;
  [FOLDED_REISSUE_KEY]?: number;
  [FOLDED_REISSUE_IDS_KEY]?: string[];
  [FOLDED_REISSUE_INVOICE_KEY]?: number;
} {
  const folded = settled.foldedReissuedAsks;
  const foldedHistory =
    folded.cents > 0
      ? {
          [FOLDED_REISSUE_KEY]: folded.cents,
          [FOLDED_REISSUE_IDS_KEY]: [...folded.modificationIds],
          ...(folded.invoiceCents > 0 ? { [FOLDED_REISSUE_INVOICE_KEY]: folded.invoiceCents } : {}),
        }
      : {};
  if (settled.unpaidAskOffsetCents <= 0) return foldedHistory;
  return {
    ...foldedHistory,
    [HISTORY_KEY]: settled.unpaidAskOffsetCents,
    ...(settled.retiredAskModificationIds.length > 0
      ? { [RETIRED_PENDING_ASKS_KEY]: [...settled.retiredAskModificationIds] }
      : {}),
    ...(settled.reissuedAskInvoiceCents > 0 ? { [REISSUED_ASK_INVOICE_KEY]: settled.reissuedAskInvoiceCents } : {}),
    ...(settled.reissuedAskInvoiceUnsureCents > 0
      ? { [REISSUED_ASK_INVOICE_UNSURE_KEY]: settled.reissuedAskInvoiceUnsureCents }
      : {}),
    ...(settled.unpaidAskBilledOffsetCents > 0
      ? {
          [BILLED_OFFSET_KEY]: settled.unpaidAskBilledOffsetCents,
          [BILLED_OFFSET_OWN_NOTE_EXPECTED_KEY]: ownNoteExpected(settled),
        }
      : {}),
    ...(settled.unpaidAskBilledOffsetUnsureCents > 0
      ? { [BILLED_OFFSET_UNSURE_KEY]: settled.unpaidAskBilledOffsetUnsureCents }
      : {}),
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
 * #4049: whether the edit expected an own note beside its billed-offset note,
 * as its history row records it; null on a row written before #4049.
 */
export function recordedBilledOffsetOwnNoteExpected(newData: unknown): boolean | null {
  const value = historyRecord(newData)?.[BILLED_OFFSET_OWN_NOTE_EXPECTED_KEY];
  return typeof value === "boolean" ? value : null;
}

/** The part of a reduction's offset whose billing could not be established, or 0 (round 6). */
export function recordedUnpaidAskBilledOffsetUnsureCents(newData: unknown): number {
  return recordedPositiveCents(newData, BILLED_OFFSET_UNSURE_KEY);
}

/** What a re-issued ask's invoice may owe beyond what was queued, where unestablished, or 0 (round 7). */
export function recordedReissuedAskInvoiceUnsureCents(newData: unknown): number {
  return recordedPositiveCents(newData, REISSUED_ASK_INVOICE_UNSURE_KEY);
}

/** The repair pass's summary for a re-issued ask's invoice that could not be sized (amount in the details). */
export const REISSUED_ASK_INVOICE_UNSURE_SUMMARY =
  "This change made the member's unpaid additional payment smaller, and it could not be established how much of the smaller request a supplementary Xero invoice should bill beyond any already queued. Check what the booking's invoices bill: if they do not cover the amount shown, raise a supplementary invoice for it, waiting on that card request.";

/** The repair pass's summary for an offset whose billing could not be established (amount in the details). */
export const UNPAID_ASK_BILLED_OFFSET_UNSURE_SUMMARY =
  "This change cancelled or reduced an unpaid additional payment, and it could not be established whether the booking's Xero invoice had already billed that money. Check the invoice: if it bills that additional payment, raise a credit note for the amount shown against it.";

/** What an increase folded in of waiting re-issues, or 0 (round 6). */
export function recordedFoldedReissuedAskCents(newData: unknown): number {
  return recordedPositiveCents(newData, FOLDED_REISSUE_KEY);
}

/** What the folded re-issues' own supplementary invoices bill, or 0 (round 6). */
export function recordedFoldedReissuedAskInvoiceCents(newData: unknown): number {
  return recordedPositiveCents(newData, FOLDED_REISSUE_INVOICE_KEY);
}

/** The reducing edits whose waiting re-issues an increase folded in (round 6). */
export function recordedFoldedReissuedAskModificationIds(newData: unknown): string[] {
  const ids = historyRecord(newData)?.[FOLDED_REISSUE_IDS_KEY];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** The increase whose history says it folded this reduction's waiting re-issue in, or null. */
export function foldingIncreaseFor<M extends { id: string; newData: unknown }>(
  modificationId: string,
  modifications: readonly M[],
): M | null {
  return (
    modifications.find((modification) =>
      recordedFoldedReissuedAskModificationIds(modification.newData).includes(modificationId),
    ) ?? null
  );
}

/**
 * The reduction whose history names this modification as one whose unpaid ask
 * it retired, or null - the repair pass's reading for an increase whose
 * invoice a reduction retired, whose ask it netted off before it minted, or
 * whose minted row it retired before the increase queued its invoice (round 8);
 * and for a reduction whose smaller re-issue a later reduction retired in turn.
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

/**
 * #3954 round 8: a later reduction retired this reduction's re-issue - by name,
 * or by retiring the increase that folded it in - and so carried it, and any
 * uncertainty about its invoice, into its own history.
 */
export function isReissueRetiredByLaterReduction<M extends { id: string; newData: unknown }>(
  reductionId: string,
  modifications: readonly M[],
): boolean {
  if (retiringReductionFor(reductionId, modifications)) return true;
  const increase = foldingIncreaseFor(reductionId, modifications);
  return Boolean(increase && retiringReductionFor(increase.id, modifications));
}

/**
 * #3954 round 6: a reduction's re-issue a later increase folded in has its
 * invoice accounted for while that increase's own ask is still to mint (its
 * recovery open) - the invoice is queued on that mint - or once a later
 * reduction retired that increase's ask in turn and names it.
 */
export function isFoldedReissueAccountedFor<M extends { id: string; newData: unknown }>(
  reductionId: string,
  modifications: readonly M[],
  openRecoveryModificationIds: ReadonlySet<string>,
): boolean {
  const increase = foldingIncreaseFor(reductionId, modifications);
  return Boolean(
    increase && (openRecoveryModificationIds.has(increase.id) || retiringReductionFor(increase.id, modifications)),
  );
}
