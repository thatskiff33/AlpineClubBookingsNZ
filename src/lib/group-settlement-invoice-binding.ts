/**
 * #3642 (`INV-PAY-105`): an organiser-pays group settlement is BOUND to its
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

/**
 * #3642 (`INV-SSOT-002`): the one definition of a group settlement's total —
 * the sum of its committed children's final prices. The settle paths size the
 * settlement with it, the bound-invoice rule compares against it, the paid
 * apply re-verifies with it, and the create worker refuses to raise an invoice
 * whose lines disagree with it.
 */
/**
 * #3642: where a bound settlement's invoice has got to, as the organiser's page
 * shows it. Decided on the server from the settlement's pointer and its latest
 * CREATE row, so the page never says "emailed" before the invoice was.
 */
export type GroupSettlementInvoiceDisplay =
  | "preparing"
  | "failed"
  | "raised"
  | "emailed";

export function groupSettlementInvoiceDisplay(
  settlement: { xeroInvoiceId: string | null },
  latestCreate: { status: string; responsePayload: unknown } | null
): GroupSettlementInvoiceDisplay {
  if (!settlement.xeroInvoiceId) {
    return latestCreate?.status === "FAILED" ? "failed" : "preparing";
  }
  const payload =
    latestCreate?.responsePayload && typeof latestCreate.responsePayload === "object"
      ? (latestCreate.responsePayload as Record<string, unknown>)
      : null;
  const emailed =
    latestCreate?.status === "SUCCEEDED" &&
    payload?.invoiceEmail != null &&
    payload.invoiceEmailWithheldByNoEmails !== true &&
    payload.invoiceEmailWithheldForEnvironment !== true;
  return emailed ? "emailed" : "raised";
}

/**
 * #3642: the settlement's last invoice request was refused because a joiner's
 * stored prices do not add up (`releaseUninvoiceableGroupSettlement`), so the
 * organiser is told the club will sort it out and that card still works.
 */
export function groupSettlementInvoiceBlocked(
  latestCreate: { status: string; responsePayload: unknown } | null
): boolean {
  const payload =
    latestCreate?.responsePayload && typeof latestCreate.responsePayload === "object"
      ? (latestCreate.responsePayload as Record<string, unknown>)
      : null;
  return latestCreate?.status === "FAILED" && payload?.invoiceLinesDisagreeWithPrices === true;
}

export function groupSettlementTotalCents(
  children: ReadonlyArray<{ finalPriceCents: number }>
): number {
  return children.reduce((sum, child) => sum + child.finalPriceCents, 0);
}
