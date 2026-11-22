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

/**
 * #4988 (`INV-CONFIG-008`): an operation waiting in PENDING because a line it
 * sends is in a tax category the club's Xero organisation cannot carry yet
 * (`XeroTaxCategoryUnavailableError`): unmapped, mapped in another
 * organisation, or mapped to a rate Xero no longer has active and fit. Nothing
 * was sent. The scan spaces the row out
 * (`scanSpacesTaxCategoriesAwaitingMapping`) until a Full Admin maps the
 * category on the Xero setup screen.
 */
export const XERO_TAX_CATEGORY_AWAITING_MAPPING_CODE = "TAX_CATEGORY_AWAITING_MAPPING";

/**
 * #4919 (`INV-INT-003`): a group-settlement invoice CREATE whose invoice is
 * raised and bound but whose email was not sent inside lock(1) — the deadline
 * passed, Xero rate-limited it or answered with a transient error. The row
 * waits in PENDING and the outbox scan spaces it out
 * (`scanSpacesGroupInvoiceEmailsDeferred`) before asking again.
 */
export const GROUP_SETTLEMENT_INVOICE_EMAIL_DEFERRED_CODE = "GROUP_SETTLEMENT_INVOICE_EMAIL_DEFERRED";

/**
 * #5228: the code the owner's release (`pnpm run xero:stuck-queued-report
 * --release`) stamps on a PENDING outbox row it fails because the stored
 * request was no queued request the outbox could claim. FAILED, so an officer
 * sees it and Retry replays it from what the row holds; the code says why it
 * left PENDING without ever being sent from there.
 */
export const XERO_STUCK_QUEUED_REQUEST_RELEASED_CODE = "QUEUED_REQUEST_RELEASED";
