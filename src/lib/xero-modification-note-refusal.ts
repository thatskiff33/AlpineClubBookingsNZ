/**
 * When an edit-anchored modification note must not be created or retried (#3993).
 *
 * A Stripe card refund of a price cut is a refund note on the payment, not a
 * modification note against an invoice the card already paid. The guard below
 * is the backstop for every edit note that remains (bank, cash, invoice
 * correction, applied-credit give-back): the original invoice is read before
 * any credit note is created, and a shortfall fails the operation with nothing
 * in Xero. A note Xero already refused as paid off is the same refusal, recorded
 * on the row, and is not offered for retry.
 */
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";
import { asRecord } from "@/lib/xero-json";

/** Opening the repair tool and the retry screen both recognise. Not the clearing note's. */
const MODIFICATION_NOTE_EXCEEDS_DUE_MARKER = "The original invoice owes ";

const PAID_OFF = /already been paid off/i;
const GREATER_THAN_OUTSTANDING = /amount is greater than amount outstanding/i;

export class ModificationNoteExceedsInvoiceDueError extends Error {
  constructor(noteCents: number, owedCents: number, format: ClubFormat) {
    super(
      `${MODIFICATION_NOTE_EXCEEDS_DUE_MARKER}${formatCents(owedCents, format)}, less than this ${formatCents(noteCents, format)} modification credit note; nothing was created.`,
    );
    this.name = "ModificationNoteExceedsInvoiceDueError";
  }
}

/**
 * The amount-due read refused a note whose create an EARLIER attempt of the
 * same row already sent to Xero (a worker that died after the create, then a
 * stale reset). That note may exist, allocated but not linked, so this is not
 * "nothing was created": it is kept out of the refusal class above (no shared
 * opening, no paid-off wording) and the row stays retryable.
 */
export class ModificationNoteMayAlreadyExistError extends Error {
  constructor(noteCents: number, owedCents: number, format: ClubFormat) {
    super(
      `An earlier attempt already sent this ${formatCents(noteCents, format)} modification credit note to Xero, and the original invoice now owes ${formatCents(owedCents, format)}. Check Xero for an existing note for this booking edit before treating it as not created: if it is there, link it to this edit and Resolve this row; if it is not, review the invoice by hand.`,
    );
    this.name = "ModificationNoteMayAlreadyExistError";
  }
}

/**
 * True once the note handler has reached its create on this row: it writes the
 * built `creditNotes` into `requestPayload` immediately before calling Xero,
 * and the enqueued payload never carries them.
 */
export function modificationNoteCreateWasSent(requestPayload: unknown): boolean {
  const creditNotes = asRecord(requestPayload)?.creditNotes;
  return Array.isArray(creditNotes) && creditNotes.length > 0;
}

export type ModificationNoteInvoiceRefusal = "paid-off" | "shortfall";

/**
 * Keep the refund note. Voiding it makes the next nightly run raise another.
 * The modification note is the one to void, and only once it has nothing on it.
 * Only for a note whose stored method says the money went back by card.
 */
const CARD_REFUND_MODIFICATION_NOTE_REMEDY =
  "Keep the refund note, which carries the Stripe refund payment. Void the modification note only after confirming it has no allocations or refunds. On the Xero operations screen, Resolve the partial operation and its failed requeue and allocate rows. Do not mark the row non-replayable. Do not void the refund note: the next nightly run would raise another.";

/** Any other method, or none recorded: no refund note is assumed to exist. */
const PAID_OFF_MODIFICATION_NOTE_REVIEW =
  "Xero refused to allocate this modification credit note because the original invoice is already paid off, so the note exists unallocated. Review it by hand in Xero: check how the money went back, then allocate, refund or void the note only after confirming it has no allocations or refunds. On the Xero operations screen, Resolve the partial operation and its failed requeue and allocate rows. Do not mark the row non-replayable.";

const MODIFICATION_NOTE_SHORTFALL_REVIEW =
  "The original invoice owes less than this modification credit note, so nothing was created. Review it by hand; a retry will not succeed.";

/** `notePayload` is the note's own stored request; its method picks the wording. */
export function modificationNoteRefusalSummary(
  refusal: ModificationNoteInvoiceRefusal,
  notePayload?: unknown,
): string {
  if (refusal === "shortfall") return MODIFICATION_NOTE_SHORTFALL_REVIEW;
  return asRecord(notePayload)?.refundMethod === "card"
    ? CARD_REFUND_MODIFICATION_NOTE_REMEDY
    : PAID_OFF_MODIFICATION_NOTE_REVIEW;
}

function recordedRefusalText(operation: {
  lastErrorMessage?: string | null;
  responsePayload?: unknown;
}): string {
  const parts: string[] = [];
  if (operation.lastErrorMessage) parts.push(operation.lastErrorMessage);
  const payload = asRecord(operation.responsePayload);
  const allocationError = payload?.allocationError;
  if (typeof allocationError === "string") {
    parts.push(allocationError);
  } else if (allocationError != null) {
    const record = asRecord(allocationError);
    if (typeof record?.message === "string") parts.push(record.message);
    parts.push(JSON.stringify(allocationError));
  }
  return parts.join("\n");
}

/**
 * A modification note the invoice cannot take. Shortfall is the named error
 * raised before create; paid-off is Xero's refusal of an allocation that was
 * already attempted. Either is read from the row's message or its stored
 * `allocationError`, which is where a partial note keeps the refusal.
 */
export function modificationNoteInvoiceRefusal(operation: {
  lastErrorMessage?: string | null;
  responsePayload?: unknown;
}): ModificationNoteInvoiceRefusal | null {
  const text = recordedRefusalText(operation);
  if (text.includes(MODIFICATION_NOTE_EXCEEDS_DUE_MARKER)) return "shortfall";
  if (PAID_OFF.test(text) || GREATER_THAN_OUTSTANDING.test(text)) return "paid-off";
  return null;
}

/** The operations screen's reason, or null when the row may still be retried. */
export function modificationNoteInvoiceRefusalRetryReason(operation: {
  lastErrorMessage?: string | null;
  responsePayload?: unknown;
  requestPayload?: unknown;
}): string | null {
  const refusal = modificationNoteInvoiceRefusal(operation);
  return refusal ? modificationNoteRefusalSummary(refusal, operation.requestPayload) : null;
}

function keepsAllocatedModificationNote(requestPayload: unknown): boolean {
  const payload = asRecord(requestPayload);
  if (!payload) return false;
  return (
    payload.refundMethod === "internet-banking" ||
    payload.noteWording === "invoice-correction" ||
    payload.noteWording === "cash"
  );
}

/**
 * A captured Stripe payment's reduction that was not kept as account credit
 * and has no stored bank, cash, or invoice-correction wording. Its cash is a
 * refund note. The repair tool must not mint a modification note for it.
 */
export function isStripeCardRefundEdit(input: {
  paymentSource: string | null;
  paymentHasCapturedMoney: boolean;
  settlementMethod: unknown;
  operationPayloads: readonly unknown[];
}): boolean {
  if (input.paymentSource !== "STRIPE" || !input.paymentHasCapturedMoney) return false;
  if (input.settlementMethod === "credit") return false;
  return !input.operationPayloads.some(keepsAllocatedModificationNote);
}

/** The stored request of the create that made `creditNoteId`, for its method. */
export function ownModificationNotePayload(
  operations: readonly {
    entityType: string;
    operationType: string;
    xeroObjectId: string | null;
    requestPayload: unknown;
  }[],
  creditNoteId: string,
): unknown {
  return operations.find(
    (operation) =>
      operation.entityType === "CREDIT_NOTE" &&
      operation.operationType === "CREATE" &&
      operation.xeroObjectId === creditNoteId,
  )?.requestPayload;
}
