/**
 * #5433 (owner decision D1; the card recovery doors): what every card door that
 * owes the member's booking confirmation does once its settle has committed,
 * in one place (`INV-SSOT-002`).
 *
 * The doors: the Stripe webhook, the confirm-payment route, the confirm-pending
 * job's saved-card charge, the create-payment-intent and payment-link
 * recoveries of a capture whose webhook was missed, and the charge-saved-method
 * route. Each asks the settle (`markBookingPaymentSucceeded`) to record the
 * confirmation as owed (`owesPaidConfirmation: true`) and then calls
 * `queueInvoiceAndDeliverPaidConfirmation` where it queues the booking's Xero
 * invoice. The rules for the owed notice, its sweep and its cut-off are
 * `paid-booking-confirmation-notice.ts`.
 *
 * Its own module, beside the deliverer rather than inside it, so a test that
 * replaces the deliverer's exports (a stop between the commit and the send)
 * still reaches every door through this sequence.
 *
 * Locks (`INV-LOCK-001`): nothing here runs inside a transaction or takes an
 * advisory key; every call is after the settle's commit.
 */
import type { ClubFormat } from "@/lib/club-format";
import { deliverPaidBookingConfirmation, sendUnrecordedPaidBookingConfirmation } from "@/lib/paid-booking-confirmation-notice";
import type { MarkBookingPaymentSucceededResult } from "@/lib/payment-reconciliation-sources";

/** What a card door hands over after its settle commits: the settle's result, or null when it settled nothing. */
export type CardSettleConfirmationResult = Pick<MarkBookingPaymentSucceededResult, "outcome" | "paidConfirmation">;

/**
 * After a card settle that owes the confirmation has committed, at the point
 * the door queues the booking's Xero invoice:
 *
 * 1. queue the invoice first (`queueInvoice`, the door's own queue, unchanged):
 *    nothing re-queues a missed invoice, while a missed confirmation is the
 *    sweep's;
 * 2. a fresh PAID carries the owed marker: deliver it
 *    (`deliverPaidBookingConfirmation`), so the email goes once whichever door
 *    or webhook settles first (#772), and a stop leaves it to the sweep;
 * 3. a fresh PAID whose marker could not be keyed (unreachable with today's
 *    ids, #5433 PR 4): sent once, unkeyed, as before #5433;
 * 4. any other outcome (already paid, a duplicate capture, or `null` when this
 *    door settled nothing) sends nothing: the settle that marked the booking
 *    paid owns its confirmation.
 *
 * `job` names the door in the logs. Never throws when `queueInvoice` does not:
 * the delivery and the fallback never throw, and each door's queue catches its
 * own failure.
 */
export async function queueInvoiceAndDeliverPaidConfirmation(
  result: CardSettleConfirmationResult | null,
  { bookingId, format, job, queueInvoice }: { bookingId: string; format: ClubFormat; job: string; queueInvoice: () => Promise<unknown> },
): Promise<void> {
  await queueInvoice();
  if (result?.paidConfirmation) await deliverPaidBookingConfirmation(result.paidConfirmation, format, job);
  else if (result?.outcome === "paid") await sendUnrecordedPaidBookingConfirmation(bookingId, format, job);
}
