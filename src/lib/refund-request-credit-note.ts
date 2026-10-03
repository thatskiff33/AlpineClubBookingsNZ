/**
 * #3827, owner decision D-3813-8 (#3492, `INV-PAY-116`): A REFUND REQUEST'S
 * OWN XERO REFUND CREDIT NOTE.
 *
 * An approved refund request on an internet-banking payment is paid back by
 * the treasurer, by hand. When they mark its task paid back, the app queues
 * that request's own refund credit note for exactly the amount paid back -
 * after the money has moved. One note per request, keyed by the request, so a
 * second request on the same payment gets a note of its own.
 *
 * A non-card payment otherwise carries ONE refund note (`REFUND_CREDIT_NOTE`,
 * kept single by the link normaliser in `xero-sync.ts`, the canonical-link
 * cleanup and the drift report). A request's note is therefore linked under a
 * role of its OWN, which none of that machinery selects, so it is an allowed
 * extra rather than a duplicate; `findCanonicalPaymentRefundCreditNote` also
 * leaves it out of its fallbacks, so a cancellation's note is never absorbed
 * into a request's. Plain module, no imports: the sync layer reads the role.
 */
export const REFUND_REQUEST_CREDIT_NOTE_ROLE = "REFUND_REQUEST_CREDIT_NOTE";

/**
 * The refund request a stored credit-note payload names, from either shape
 * its operation row holds (the queued one, or the executed Xero request the
 * executor writes over it). Both carry it at the top level.
 */
export function readRefundRequestIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).refundRequestId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * #3827 (`INV-PAY-116`): is this outbox row a refund request's OWN note? Read
 * from the payload (`refundRequestId`, on the queued and the executed shape)
 * or, for a row whose payload was lost, the key's `refund-request-credit-note`
 * segment (`refundRequestCreditNoteKey`; no executor rewrites a key). Every
 * reader that resolves THE payment's refund note - the booking repair tool,
 * the failed-operations heuristic - leaves these rows out, so a request's note
 * is never taken for the cancellation's and its failure is never hidden.
 */
export function isRefundRequestNoteOperation(operation: RefundRequestNoteRow): boolean {
  return readRefundRequestIdFromOperation(operation) !== null;
}

type RefundRequestNoteRow = {
  requestPayload: unknown;
  correlationKey?: string | null;
  idempotencyKey?: string | null;
};

/**
 * The refund request a request-note row answers for: its payload's id, else
 * the segment after `refund-request-credit-note` in its key, else the whole key
 * (one request's row either way). Null when the row is no request's note.
 */
export function readRefundRequestIdFromOperation(operation: RefundRequestNoteRow): string | null {
  const fromPayload = readRefundRequestIdFromPayload(operation.requestPayload);
  if (fromPayload !== null) return fromPayload;
  for (const key of [operation.correlationKey, operation.idempotencyKey]) {
    if (typeof key !== "string") continue;
    const parts = key.split(":");
    const at = parts.indexOf("refund-request-credit-note");
    if (at >= 0) return parts[at + 1] || key;
  }
  return null;
}
