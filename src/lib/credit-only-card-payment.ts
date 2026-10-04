import { PaymentSource } from "@prisma/client";

/**
 * #3836 (`INV-PAY-024`): a card-path payment that captured NOTHING because
 * account credit covered the booking - the $0 row every credit-covered settle
 * writes. Its invoice is raised at the full price, so the applied credit is all
 * that pays it. `amountCents` is the gross captured, so neither a legacy
 * full-price capture nor a refunded-whole card can match. The status is not
 * read: every credit-covered settle writes this row SUCCEEDED and nothing
 * captures or refunds it, so it adds nothing the amount does not say (a cancel
 * leaves it SUCCEEDED, on the paid path). Whether credit may still be
 * allocated is the engine's question, from the ledger: it never plans new
 * allocation on a cancelled booking (`allocateAppliedCreditForBooking`). The Xero booking repair pass reads the same
 * shape for invoices raised before #3836 with their credit never allocated.
 */
export function isCreditOnlyCardPayment(payment: {
  source: PaymentSource | null;
  amountCents: number;
  creditAppliedCents: number;
}): boolean {
  return (
    payment.source !== PaymentSource.INTERNET_BANKING &&
    payment.amountCents === 0 &&
    payment.creditAppliedCents > 0
  );
}
