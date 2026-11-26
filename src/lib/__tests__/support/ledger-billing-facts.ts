import type { BookingXeroBillingFacts } from "@/lib/booking-ledger-verdict";

/**
 * A card-paid booking's Xero billing facts (#5288): no Internet Banking
 * invoice asks for anything, so the census verdict is read from the residual
 * alone, as it was before `billedInXero`.
 */
export const CARD_PAID_BILLING: BookingXeroBillingFacts = {
  paymentSource: "STRIPE",
  xeroInvoiceId: null,
  activeInvoiceLink: false,
  queuedInvoiceCreate: false,
};
