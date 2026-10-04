/**
 * Shared booking-edit → Xero write conditions (#1729).
 *
 * `classifyXeroBookingEditSettlement` (xero-booking-edit-settlement) queues
 * the check-in-dated primary invoice date/narration update under exactly one
 * condition, and the pre-transaction Xero period lock-date guard
 * (xero-period-lock-guard) must fire on ordinary date edits under exactly the
 * same condition. Both import the predicate from this dependency-free module
 * so the two can never drift — the guard blocking an edit whose settlement
 * would write nothing check-in-dated (false alarm), or missing one that does
 * (stranded outbox operation).
 */

import type { PaymentStatus } from "@prisma/client";
import { isCapturedPaymentStatus } from "@/lib/booking-payment-state";

/**
 * Local payment states under which the original (primary) Xero invoice must
 * never be mutated: money has moved against it, so edits settle through
 * supplementary invoices / credit notes instead.
 */
export function isPrimaryInvoiceUnsafe(
  paymentStatus?: PaymentStatus | string | null,
): boolean {
  return paymentStatus ? isCapturedPaymentStatus(paymentStatus) : false;
}

export interface CheckInDatedInvoiceUpdateConditionInput {
  hasIssuedXeroInvoice: boolean;
  originalPaymentStatus?: PaymentStatus | string | null;
  datesChanged?: boolean;
  guestIdentityChanged?: boolean;
}

/**
 * True exactly when a booking edit queues the check-in-dated primary invoice
 * date/narration update: an issued Xero invoice whose payment is still safe
 * to mutate, and a date or guest-identity change to re-narrate. This is the
 * only check-in-dated Xero write an edit performs besides the primary invoice
 * a zero-dollar recalculate creates when none exists (PR #1715 review MED-1).
 *
 * The lock-date guard for ordinary edits passes `guestIdentityChanged: false`:
 * identity-only edits stay unguarded by owner decision (#1729) — the outbox
 * backstop covers that rare strand rather than blocking a typo fix.
 */
export function wouldQueueCheckInDatedInvoiceUpdate(
  input: CheckInDatedInvoiceUpdateConditionInput,
): boolean {
  return (
    input.hasIssuedXeroInvoice &&
    (Boolean(input.datesChanged) || Boolean(input.guestIdentityChanged)) &&
    !isPrimaryInvoiceUnsafe(input.originalPaymentStatus)
  );
}
