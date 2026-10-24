/**
 * #4218 — a credit note the app needs was spent in Xero by something the app did
 * not do (a hand-entered offset, a payment made against the note, a manual
 * allocation).
 *
 * The allocation worker plans from the LOCAL credit ledger and never asks Xero
 * what the note has left, so Xero refuses the allocation with a 400 and every
 * retry sends the same request. This module is the pure half of the fix: the
 * named error, the test for Xero's refusal wording, and the rule that decides
 * whether a read confirms the refusal. The Xero read is in
 * `xero-credit-note-spent-detail.ts`.
 *
 * Xero's refusal is the trigger, not a read made beforehand: a read can lag an
 * edit made seconds ago, and a stale "low" figure would fail an allocation Xero
 * would accept. But the refusal alone is not proof either - the app's own earlier
 * allocation, whose completion was never recorded, is refused the same way - so
 * the error is named only when a read after the refusal confirms it.
 *
 * Nothing here writes. The error makes the failure diagnosable; the ledger
 * convergence is #4219.
 */

/** `XeroSyncOperation.lastErrorCode` for this failure (not an HTTP status). */
export const CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE = "CREDIT_NOTE_SPENT_OUTSIDE_APP";

/** One of a credit note's allocations in Xero: the invoice it went to, in exact cents. */
export interface XeroNoteAllocation {
  invoiceId: string;
  cents: number;
}

/** One payment made against a credit note in Xero (a refund of its credit), in exact cents. */
export interface XeroNotePayment {
  paymentId: string;
  cents: number;
}

export class CreditNoteSpentOutsideAppError extends Error {
  readonly code = CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE;

  constructor(
    message: string,
    readonly creditNoteId: string,
    /** What Xero says is left, in cents. */
    readonly remainingCents: number,
    readonly requestedCents: number,
    options?: {
      cause?: unknown;
      /** The note's allocations in Xero, from the confirming read. */
      xeroAllocations?: readonly XeroNoteAllocation[];
      /** The payments made against the note in Xero (refunds), from the same read. */
      xeroPayments?: readonly XeroNotePayment[];
      /** The note's total in Xero, from the same read; null when it was not an exact cent figure. */
      totalCents?: number | null;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CreditNoteSpentOutsideAppError";
    this.xeroAllocations = options?.xeroAllocations ?? [];
    this.xeroPayments = options?.xeroPayments ?? [];
    this.totalCents = options?.totalCents ?? null;
  }

  readonly xeroAllocations: readonly XeroNoteAllocation[];
  readonly xeroPayments: readonly XeroNotePayment[];
  readonly totalCents: number | null;
}

export function isCreditNoteSpentOutsideAppError(
  error: unknown,
): error is CreditNoteSpentOutsideAppError {
  return error instanceof CreditNoteSpentOutsideAppError;
}

/**
 * Xero's refusal of an over-allocation: "Credit Note cannot be allocated as the
 * allocation amount is greater than the amount remaining on the Credit Note".
 * Takes the error's search text (`getXeroErrorSearchText`, the one reader of a
 * Xero error's wording).
 */
export function isCreditNoteOverAllocationText(searchText: string): boolean {
  return /allocation amount is greater than the amount remaining on the credit note/i.test(
    searchText,
  );
}

/**
 * This note's allocations to one invoice, as exact cents. An allocation whose
 * amount is not an exact cent figure is skipped.
 */
export function noteAllocationCentsForInvoice(
  allocations:
    | ReadonlyArray<{ invoice?: { invoiceID?: string } | null; amount?: unknown }>
    | null
    | undefined,
  invoiceId: string,
  toCents: (amount: unknown) => number | null,
): number[] {
  return (allocations ?? []).flatMap((allocation) => {
    if (allocation.invoice?.invoiceID !== invoiceId) return [];
    const cents = toCents(allocation.amount);
    return cents === null ? [] : [cents];
  });
}

/**
 * Xero refused the allocation as too large, and the follow-up read succeeded. Is
 * that really "spent outside the app"? Not when the read disproves it, which keeps
 * this signal free of false positives (the ledger convergence in #4219 will act
 * on it):
 *
 * - the note already holds an allocation to this invoice of at least the slice:
 *   that is the app's own earlier success (its completion was never recorded, or
 *   Xero's duplicate-request window had passed), not an outside spend;
 * - the note now shows at least the slice remaining: the credit was restored
 *   between the refusal and the read, so there is nothing to name.
 *
 * A read that failed never reaches this rule: the caller keeps the original error.
 */
export function refusalMeansSpentOutsideApp(
  observation: { remainingCents: number; allocatedToInvoiceCents: readonly number[] },
  requestedCents: number,
): boolean {
  if (observation.allocatedToInvoiceCents.some((cents) => cents >= requestedCents)) {
    return false;
  }
  if (observation.remainingCents >= requestedCents) {
    return false;
  }
  return true;
}
