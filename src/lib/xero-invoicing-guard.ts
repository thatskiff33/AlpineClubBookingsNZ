import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { SUBSCRIPTION_INVOICING_XERO_OFF_MESSAGE } from "@/lib/xero-invoicing-off";

/**
 * #4986 (`INV-INT-038`): the one module guard for every writer that hands
 * subscription or joining-fee invoice work to the Xero outbox. Invoices reach
 * members only through Xero, and the outbox worker skips every task while the
 * module is off, so work written then would wait and go out unchecked the day
 * Xero is switched back on. A writer asks here BEFORE it freezes anything: a
 * missing account mapping is not a stand-in, because a club can hold explicit
 * mappings (imported, or from before it paused Xero) with the module off.
 *
 * The effective state comes from the same reader the Xero cron uses, which
 * treats an unreadable settings row as "off": a failed read refuses.
 */
export function isXeroInvoicingEnabled(): Promise<boolean> {
  return isEffectiveModuleEnabled("xeroIntegration");
}

export class XeroInvoicingOffError extends Error {
  readonly status = 409;

  constructor(message: string = SUBSCRIPTION_INVOICING_XERO_OFF_MESSAGE) {
    super(message);
    this.name = "XeroInvoicingOffError";
  }
}

/** Throws `XeroInvoicingOffError` while Xero is off; the subscription writers' entry check. */
export async function assertSubscriptionInvoicingEnabled(): Promise<void> {
  if (!(await isXeroInvoicingEnabled())) throw new XeroInvoicingOffError();
}
