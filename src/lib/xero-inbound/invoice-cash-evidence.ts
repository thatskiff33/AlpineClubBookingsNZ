// A paid Xero invoice's cash evidence and its quantification in cents, moved
// verbatim from `invoice-paid-effects.ts` (#4926: that file is past its hard
// ceiling and may only stay or shrink). Pure functions of the invoice payload:
// no database, no lock, no provider call. `invoice-paid-effects.ts` re-exports
// both functions, so every existing import keeps its path.
import { type Invoice } from "xero-node";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { isDeletedXeroPaymentStatus } from "@/lib/xero-inbound/object-links";
import { sumListedXeroPaymentCents } from "@/lib/xero-inbound/amounts";

type XeroInvoiceCashEvidence = "cash" | "none" | "indeterminate";

// A PAID invoice event alone is not cash (#1357/#1435): Xero also reports
// PAID when a credit note is ALLOCATED against the invoice — allocations
// accrue to amountCredited, never amountPaid, and the app's own
// invoice-clearing notes produce exactly that zero-cash PAID event on every
// ordinary unpaid-IB cancellation.
//
// Evidence order:
//  1. Overpayment/prepayment allocations count as cash: they are real member
//     money sitting on the Xero contact that an operator deliberately applied
//     (a standard bank-rec flow for transfers with mangled references). Xero
//     books them under amountCredited, but the app itself only ever produces
//     CREDIT-NOTE allocations, so these can never be the clearing-note echo
//     this gate exists to stop.
//  2. `amountPaid` is authoritative when present as a finite number — an
//     explicit 0 means Xero says no cash arrived, and the payments fallback
//     must NOT override it (stale entries could linger there).
//  3. The invoice's actual payment records are the fallback, ignoring
//     DELETED (reversed) payments.
//  4. A payload carrying none of these fields is "indeterminate". Both callers
//     read a fresh getInvoice (this module's reconcile, and the hold-expiry
//     payment check and cancel-time recognition, #3643), which always carries
//     the cash fields, so this arm only guards degraded payload shapes; the
//     hold-expiry check treats it as unreadable, never as unpaid.
export function classifyXeroInvoiceCashEvidence(
  invoice: Invoice
): XeroInvoiceCashEvidence {
  if (
    (invoice.overpayments?.length ?? 0) > 0 ||
    (invoice.prepayments?.length ?? 0) > 0
  ) {
    return "cash";
  }
  const amountPaidCents = providerAmountToCents(invoice.amountPaid);
  if (amountPaidCents !== null) {
    return amountPaidCents > 0 ? "cash" : "none";
  }
  if (Array.isArray(invoice.payments)) {
    const cashPayments = invoice.payments.filter((payment) => !isDeletedXeroPaymentStatus(payment.status));
    return cashPayments.length > 0 ? "cash" : "none";
  }
  return "indeterminate";
}

// Quantification of the invoice's cash in integer cents — the sizing
// companion to the boolean classifier above, used by both credit-minting
// arms (#1459). `knownCents` is the verified cash floor; `complete` is false
// when any cash component present on the payload had to be estimated or
// skipped, so callers can label the figure as unverified.
export type XeroInvoiceCashQuantification = {
  knownCents: number;
  complete: boolean;
};

// Components mirror the classifier's evidence order and never double-count:
// a finite `amountPaid` is the sum of direct bank payments (falling back to
// the invoice's own non-DELETED payment records only when `amountPaid` is
// unusable), and each overpayment/prepayment allocation is additive on top
// because Xero accrues those to `amountCredited`, never `amountPaid`. An
// allocation without a usable `appliedAmount` contributes its `total`
// instead — an upper bound (the overpayment may be partly applied
// elsewhere), so it also marks the result incomplete. Any present-but-
// unreadable component marks the result incomplete without discarding the
// components that did quantify: the known floor stays usable. Both callers
// (this module and #3643's hold payment check) quantify a fresh getInvoice,
// which always carries the amount fields, so incomplete results only arise
// from degraded payload shapes; #3643 refuses to record an incomplete figure
// as captured money.
export function quantifyXeroInvoiceCashCents(
  invoice: Invoice
): XeroInvoiceCashQuantification {
  let knownCents = 0;
  let complete = true;

  const amountPaidCents = providerAmountToCents(invoice.amountPaid);
  if (amountPaidCents !== null) {
    knownCents += amountPaidCents;
  } else {
    if (invoice.amountPaid !== undefined && invoice.amountPaid !== null) {
      // Present but unreadable (e.g. a stringly-typed degraded payload).
      complete = false;
    }
    if (Array.isArray(invoice.payments)) {
      const listed = sumListedXeroPaymentCents(invoice.payments);
      knownCents += listed.cents;
      complete &&= listed.complete;
    }
  }

  for (const allocation of [
    ...(invoice.overpayments ?? []),
    ...(invoice.prepayments ?? []),
  ]) {
    const appliedCents = providerAmountToCents(allocation.appliedAmount);
    const totalCents = providerAmountToCents(allocation.total);
    if (appliedCents !== null) {
      knownCents += appliedCents;
    } else if (totalCents !== null) {
      knownCents += totalCents;
      complete = false;
    } else {
      complete = false;
    }
  }

  return { knownCents, complete };
}
