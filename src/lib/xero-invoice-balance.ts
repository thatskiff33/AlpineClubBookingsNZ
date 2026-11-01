import "server-only";

import { getAuthenticatedXeroClient, callXeroApi } from "@/lib/xero-api-client";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";

/**
 * WHAT XERO SAYS A BOOKING'S INVOICE STILL OWES (#4253, `INV-ADDPAY-045`).
 *
 * One live read of one invoice, for the credit-release request's three decisions:
 * whether to ask at all (an invoice Xero already shows settled is not asked for
 * again), how much (never more than is due), and whether a card payment can be
 * recorded against it. It is a provider read, so it runs outside every lock and
 * every caller treats an unreadable answer as "do not act".
 *
 * `amountDueCents` is Xero's own AmountDue (what is still owing after payments,
 * credit notes and allocations), `null` only when Xero omitted it or sent a figure
 * that is not a finite number - which no caller may read as zero.
 */
export type XeroInvoiceBalance = {
  invoiceId: string;
  /** Xero's status, upper-cased: DRAFT, SUBMITTED, AUTHORISED, PAID, VOIDED, DELETED. */
  status: string;
  amountDueCents: number | null;
  invoiceNumber: string | null;
};

/** The seam tests and the cron hand in; production reads Xero. */
export type XeroInvoiceBalanceReader = (invoiceId: string) => Promise<XeroInvoiceBalance>;

export const readXeroInvoiceBalance: XeroInvoiceBalanceReader = async (invoiceId) => {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(() => xero.accountingApi.getInvoice(tenantId, invoiceId), {
    operation: "getInvoice",
    resourceType: "INVOICE",
    workflow: "readXeroInvoiceBalance",
    context: `readXeroInvoiceBalance(${invoiceId})`,
  });
  const invoice = response.body.invoices?.[0];
  if (!invoice?.invoiceID) throw new XeroInvoiceNotFoundError(`Xero invoice ${invoiceId} was not found`);
  return {
    invoiceId: invoice.invoiceID,
    status: String(invoice.status ?? "").toUpperCase(),
    amountDueCents: providerAmountToCents(invoice.amountDue),
    invoiceNumber: invoice.invoiceNumber ?? null,
  };
};

/** Xero answered, and the answer had no such invoice. */
export class XeroInvoiceNotFoundError extends Error {
  override name = "XeroInvoiceNotFoundError";
}

/**
 * A DEFINITE "no such invoice" from a read above: Xero answered 404 (the classification
 * `xero-group-settlement-invoice-voids.ts` uses on the same call), or answered without the invoice.
 * Anything else - Xero disconnected, rate-limited, timing out, a 5xx - is not an answer, and a
 * caller treats it as transient.
 */
export function isXeroInvoiceNotFound(error: unknown): boolean {
  return error instanceof XeroInvoiceNotFoundError || getXeroErrorStatusCode(error) === 404;
}

/** An invoice that is open for payment: authorised, with a known positive balance. */
export function openBalanceCents(balance: XeroInvoiceBalance): number | null {
  if (balance.status !== "AUTHORISED" || balance.amountDueCents === null || balance.amountDueCents <= 0) return null;
  return balance.amountDueCents;
}

/** An invoice Xero shows as fully paid: nothing is owing on it. */
export function isSettledInXero(balance: XeroInvoiceBalance): boolean {
  return balance.status === "PAID" && balance.amountDueCents === 0;
}
