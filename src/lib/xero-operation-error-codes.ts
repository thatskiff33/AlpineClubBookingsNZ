/**
 * #4278: the codes the Xero panels read, kept apart from `xero-stale-operations`
 * (which reaches the database) so a client component can import them.
 */

/**
 * THE ERROR CODE a stale-RUNNING reset stamps on the row it fails (#3001).
 *
 * One home, because three places depend on the exact string: the operator reset
 * route writes it, the contact-create recovery reads it back, and the booking
 * page's invoice warning uses it to tell an operation that FAILED from an
 * operation that was never seen through — a worker killed mid-invoice leaves no
 * evidence either way, so the honest reading of such a row is that the invoice
 * state is UNKNOWN rather than that no invoice was raised.
 */
export const XERO_ORPHANED_STALE_RUNNING_ERROR_CODE = "ORPHANED_STALE_RUNNING";

/**
 * #4688 (`INV-INT-035`): the code a payment refund-note create stamps on its
 * own row when Xero made the note but the record could not get its locks in
 * time (`record-wait-lost`), so the note is recorded nowhere. While the row
 * carries it and is not resolved by hand, no refund note is raised on the
 * payment (`findUnrecordedRefundNoteOperation`), Retry refuses the payment's
 * refund-note creates, and the nightly self-heal queues none. A stale reset
 * and Mark failed keep it; only Resolve by hand lifts it.
 */
export const XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE = "REFUND_NOTE_UNRECORDED";

/**
 * #4692 review (`INV-INT-035`): the code a refund-note create carries while it
 * waits in PENDING behind that fence (`XeroRefundCreditNoteUnrecordedError`),
 * so the outbox scan and the retry drain space it out
 * (`scanSpacesRefundNotesAwaitingResolve`) rather than hand it the head of
 * every oldest-first scan for as long as the resolve takes.
 */
export const XERO_REFUND_NOTE_AWAITING_RESOLVE_CODE = "REFUND_NOTE_AWAITING_RESOLVE";

/**
 * An applied-credit allocation is waiting because the grant's own note failed
 * and must be retried. Spacing matches a refund note waiting to be resolved.
 */
export const ADMIN_GRANT_NOTE_AWAITING_RETRY_CODE = "ADMIN_GRANT_NOTE_AWAITING_RETRY";
