/**
 * B5 (#2262): a domain refusal from the manual booking-payment paths, carrying
 * the HTTP status the route should answer with.
 *
 * A leaf module (#4930): the settlement core in `payment-reconciliation.ts`
 * throws it, and so do modules that payment-reconciliation itself imports, so
 * it lives below all of them. Keep it free of `@/lib` imports, or it can close
 * an import cycle again (INV-SSOT-007).
 */
export class ManualBookingPaymentError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ManualBookingPaymentError";
    this.status = status;
  }
}
