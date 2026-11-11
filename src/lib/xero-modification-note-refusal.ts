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
export const MODIFICATION_NOTE_EXCEEDS_DUE_MARKER = "The original invoice owes ";

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

export type ModificationNoteInvoiceRefusal = "paid-off" | "shortfall";

/**
 * Keep the refund note. Voiding it makes the next nightly run raise another.
 * The modification note is the one to void, and only once it has nothing on it.
 */
export const CARD_REFUND_MODIFICATION_NOTE_REMEDY =
  "Keep the refund note, which carries the Stripe refund payment. Void the modification note only after confirming it has no allocations or refunds. On the Xero operations screen, Resolve the partial operation and its failed requeue and allocate rows. Do not mark the row non-replayable. Do not void the refund note: the next nightly run would raise another.";

export const MODIFICATION_NOTE_SHORTFALL_REVIEW =
  "The original invoice owes less than this modification credit note, so nothing was created. Review it by hand; a retry will not succeed.";

export function modificationNoteRefusalSummary(refusal: ModificationNoteInvoiceRefusal): string {
  return refusal === "shortfall" ? MODIFICATION_NOTE_SHORTFALL_REVIEW : CARD_REFUND_MODIFICATION_NOTE_REMEDY;
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
}): string | null {
  const refusal = modificationNoteInvoiceRefusal(operation);
  return refusal ? modificationNoteRefusalSummary(refusal) : null;
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
