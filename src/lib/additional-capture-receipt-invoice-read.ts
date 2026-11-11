/**
 * #3953 (`INV-PAY-139`): what a change capture's receipt reads off the Xero
 * invoice it records against, and off a create's row - pure, split from the
 * worker (`additional-capture-xero-receipt.ts`, which makes the metered read)
 * when #4324 grew it past its size budget.
 */
import type { Invoice } from "xero-node";
import { readXeroInvoiceOperationOutcome } from "@/lib/xero-booking-invoice-outcome";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { isLiveXeroPaymentStatus } from "@/lib/xero-payment-status";

/** The invoice as the worker read it from Xero. */
export type InvoiceRead = { status: string; amountDueCents: number; invoice: Invoice };

/** An earlier run's live payment: matching reference, equal receipt cents, no active sweep link. */
export function findRecordedPayment(
  read: InvoiceRead | null,
  reference: string,
  receiptAmountCents: number,
  sweepPaymentIds: ReadonlySet<string>,
) {
  return (
    (read?.invoice.payments ?? []).find(
      (payment) =>
        payment.paymentID &&
        payment.reference === reference &&
        // A missing or non-finite provider amount is not this receipt's cents.
        providerAmountToCents(payment.amount) === receiptAmountCents &&
        !sweepPaymentIds.has(payment.paymentID) &&
        isLiveXeroPaymentStatus(payment.status),
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
