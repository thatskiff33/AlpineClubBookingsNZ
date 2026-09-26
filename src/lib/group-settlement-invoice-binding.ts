/**
 * #3642 (`INV-PAY-106`): an organiser-pays group settlement is BOUND to its
 * combined Internet Banking invoice while it waits for that invoice to be paid.
 *
 * The invoice is emailed with a fixed total the moment it is raised, and the
 * inbound reconciliation settles every joiner on it. So while the settlement is
 * bound, nothing may change what the settlement means underneath the invoice:
 * no re-size to a new total, no switch to card. The only ways out are paying
 * the invoice, the organiser cancelling the group (the cancellation VOID), or
 * the group-settlement reaper releasing the settlement (the abandon VOID
 * below). A settlement that is no longer bound but still points at an invoice
 * has abandoned it; `abandonGroupSettlementInvoiceInTx`
 * (`xero-group-settlement-void-outbox.ts`) retires that invoice in one step so
 * a new one can be raised.
 *
 * Pure: no database or provider import, so a read-only projection (the
 * organiser's booking page) can apply the same rule.
 *
 * Every WRITER that acts on it holds the global `lock(1)` the whole settlement
 * lifecycle already serialises on (`INV-LOCK-001`) and re-reads the row under
 * it; a read-only projection only displays the answer.
 */
import { PaymentSource, PaymentStatus } from "@prisma/client";

/** The Xero object-link role for a combined settlement invoice. */
export const GROUP_SETTLEMENT_INVOICE_ROLE = "GROUP_SETTLEMENT_INVOICE";

/**
 * The one definition of "bound": an Internet Banking settlement still waiting
 * for its invoice. Its invoice may not exist yet (the CREATE is queued) — the
 * binding starts when the settlement commits to that invoice, not when Xero
 * answers, because the invoice is built from the settlement's children.
 */
export function isGroupSettlementBoundToInvoice(
  settlement: { source: PaymentSource; status: PaymentStatus } | null | undefined
): boolean {
  return (
    settlement?.source === PaymentSource.INTERNET_BANKING &&
    settlement.status === PaymentStatus.PENDING
  );
}
