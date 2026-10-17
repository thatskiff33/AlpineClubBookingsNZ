/**
 * #4218 — a credit note the app needs was spent in Xero by something the app did
 * not do (a hand-entered offset, a payment made against the note, a manual
 * allocation).
 *
 * The allocation worker plans from the LOCAL credit ledger and never asked Xero
 * what the note had left, so Xero rejected the allocation with a 400 and every
 * retry sent the same request. This module is the pure half of the fix: the
 * terminal error, the test for Xero's rejection message, and the one decision
 * "is the note short?". The Xero read lives with `allocateCreditNoteToInvoice`.
 *
 * Nothing here writes. The error makes the failure terminal and diagnosable; the
 * ledger convergence is #4219.
 */

/** `XeroSyncOperation.lastErrorCode` for this failure (not an HTTP status). */
export const CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE = "CREDIT_NOTE_SPENT_OUTSIDE_APP";

/**
 * Credit-note statuses whose `remainingCredit` is a trustworthy "what is left":
 * a note still open, or one Xero has closed because it was fully used. Any other
 * status (DRAFT, SUBMITTED, VOIDED, DELETED) is not judged here, so the
 * allocation falls through to today's handling.
 */
const READABLE_CREDIT_NOTE_STATUSES: ReadonlySet<string> = new Set([
  "AUTHORISED",
  "PAID",
]);

export class CreditNoteSpentOutsideAppError extends Error {
  readonly code = CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE;

  constructor(
    message: string,
    readonly creditNoteId: string,
    readonly remainingCents: number,
    readonly requestedCents: number,
  ) {
    super(message);
    this.name = "CreditNoteSpentOutsideAppError";
  }
}

export function isCreditNoteSpentOutsideAppError(
  error: unknown,
): error is CreditNoteSpentOutsideAppError {
  return error instanceof CreditNoteSpentOutsideAppError;
}

/**
 * The `lastErrorCode` an error carries when it is terminal by construction: a
 * retry would send the same request and get the same answer, so the operation is
 * also recorded non-replayable. Null for every other error.
 */
export function terminalXeroErrorCode(error: unknown): string | null {
  return isCreditNoteSpentOutsideAppError(error) ? error.code : null;
}

/**
 * Xero's rejection of an over-allocation: "Credit Note cannot be allocated as the
 * allocation amount is greater than the amount remaining on the Credit Note".
 * The pre-flight read can lag a just-made Xero edit, so this message is the
 * fallback that re-reads the note after the fact.
 */
export function isCreditNoteOverAllocationRejection(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? "";
            } catch {
              return "";
            }
          })();
  return /allocation amount is greater than the amount remaining on the credit note/i.test(
    text,
  );
}

export interface CreditNoteSpendObservation {
  status: string | null | undefined;
  /** Xero's `remainingCredit` in cents; null when absent or not an exact cent figure. */
  remainingCents: number | null;
  /** This note's allocations to the target invoice, in cents (null entries skipped). */
  allocatedToInvoiceCents: readonly number[];
}

/**
 * True only when the note is provably short for this slice. Fails open on every
 * doubt, so an outage or an odd payload never turns into a terminal failure:
 *
 * - an unreadable remaining figure, or a status other than open/fully used;
 * - the note already carries an allocation to this invoice of at least the slice
 *   — that is this allocation's own earlier success (a lost response), whose
 *   effect on `remainingCredit` must not be mistaken for an outside spend. The
 *   request stays idempotent, so it is simply sent again.
 */
export function creditNoteIsShortForAllocation(
  observation: CreditNoteSpendObservation,
  requestedCents: number,
): boolean {
  if (observation.remainingCents === null) return false;
  if (!observation.status || !READABLE_CREDIT_NOTE_STATUSES.has(observation.status)) {
    return false;
  }
  if (observation.allocatedToInvoiceCents.some((cents) => cents >= requestedCents)) {
    return false;
  }
  return observation.remainingCents < requestedCents;
}
