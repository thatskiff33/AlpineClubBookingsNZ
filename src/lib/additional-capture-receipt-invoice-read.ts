/**
 * #3953 (`INV-PAY-139`): what a change capture's receipt reads off the Xero
 * invoice it records against, and off a create's row - pure, split from the
 * worker (`additional-capture-xero-receipt.ts`, which makes the metered read)
 * when #4324 grew it past its size budget.
 */
import type { Invoice, Payment } from "xero-node";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { readXeroInvoiceOperationOutcome } from "@/lib/xero-booking-invoice-outcome";
import { isLiveXeroPaymentStatus } from "@/lib/xero-payment-status";

/** The invoice as the worker read it from Xero. */
export type InvoiceRead = { status: string; amountDueCents: number; invoice: Invoice };

/**
 * #4434: a payment already on the invoice is THIS leg's own only when its
 * reference matches, its amount is this leg's amount, and its id is not linked
 * under another role (the credit-release sweep uses the same reference on the
 * primary). Anything else is someone else's payment.
 */
export function legOwnsPayment(
  read: InvoiceRead | null,
  reference: string,
  amountCents: number,
  paymentIdsUnderAnotherRole: ReadonlySet<string>,
): Payment | null {
  return (
    (read?.invoice.payments ?? []).find(
      (payment) =>
        Boolean(payment.paymentID) &&
        payment.reference === reference &&
        isLiveXeroPaymentStatus(payment.status) &&
        providerAmountToCents(payment.amount) === amountCents &&
        !paymentIdsUnderAnotherRole.has(payment.paymentID ?? ""),
    ) ?? null
  );
}

export function amountDueOn(read: InvoiceRead | null): number {
  return read && read.status === "AUTHORISED" ? Math.max(0, read.amountDueCents) : 0;
}

/**
 * Whether a create's row says its own Stripe payment failed and is still owed
 * (PARTIAL, payment fault) - never one an officer resolved in Xero
 * (`INV-INT-025`), whose payment was recorded by hand.
 */
export function ownPaymentPending(
  operation: { status: string; responsePayload: unknown; manuallyResolvedAt: Date | null } | null,
): boolean {
  return (
    operation?.status === "PARTIAL" &&
    operation.manuallyResolvedAt === null &&
    readXeroInvoiceOperationOutcome(operation.responsePayload)?.paymentFailed === true
  );
}
