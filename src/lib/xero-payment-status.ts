/**
 * #4576 (`INV-SSOT`): the one rule for a Xero payment's status. Pure, so the
 * provider readers that decide which payments on an invoice or credit note
 * still count can use it without the inbound reconcile's database imports.
 *
 * Xero reports a payment as AUTHORISED, or DELETED once reversed; VOIDED is
 * treated as dead too, as the #3535 audit always did. Comparison ignores case.
 */

/** #4531: the status Xero gives a payment it has deleted (reversed). Terminal: never live again. */
export const DELETED_XERO_PAYMENT_STATUS = "DELETED";

const DEAD_XERO_PAYMENT_STATUSES: ReadonlySet<string> = new Set([DELETED_XERO_PAYMENT_STATUS, "VOIDED"]);

function normalisedStatus(status: unknown): string {
  return String(status ?? "").toUpperCase();
}

/**
 * #4531 (`INV-INT-031`): whether a Xero payment status is DELETED. Used where a
 * deletion specifically matters (an inbound write of a deleted payment lands its
 * link inactive, so it is never re-adopted). To ask whether a payment still
 * counts, use `isLiveXeroPaymentStatus`.
 */
export function isDeletedXeroPaymentStatus(status: unknown): boolean {
  return normalisedStatus(status) === DELETED_XERO_PAYMENT_STATUS;
}

/** #4576: whether a Xero payment still counts as money paid: neither DELETED nor VOIDED, in any case. */
export function isLiveXeroPaymentStatus(status: unknown): boolean {
  return !DEAD_XERO_PAYMENT_STATUSES.has(normalisedStatus(status));
}
