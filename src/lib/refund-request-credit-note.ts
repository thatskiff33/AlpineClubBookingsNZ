/**
 * #3827, owner decision D-3813-8 (#3492, `INV-PAY-115`): A REFUND REQUEST'S
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
