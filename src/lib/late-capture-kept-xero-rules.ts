import { PaymentSource } from "@prisma/client";
import { XERO_OUTBOX_BOOKING_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

/**
 * #3635: the pure rules for recording a KEPT late capture's booking payment in
 * Xero, shared by the dismissal (`late-capture-kept-xero.ts`) and the
 * booking-vs-Xero repair tool (`xero-booking-repair-classify.ts`), so the two
 * cannot disagree about when the ordinary booking invoice is the right document
 * or whether one is already on its way (`INV-SSOT`). No I/O here.
 */

/** Why the ordinary booking invoice cannot record a kept primary capture exactly. */
export type KeptPrimaryCaptureInvoiceRefusal =
  | "not-captured"
  | "not-card"
  | "invoice-exists"
  | "manually-settled"
  | "credit-applied"
  | "amount-differs";

export const KEPT_PRIMARY_CAPTURE_REFUSAL_TEXT: Record<
  KeptPrimaryCaptureInvoiceRefusal,
  string
> = {
  "not-captured": "no captured card payment could be found for it",
  "not-card": "the booking's payment is not a card payment",
  "invoice-exists":
    "the booking already has a Xero invoice (it may have been cleared when the booking was cancelled), so a second booking invoice would bill the stay twice",
  "manually-settled":
    "the booking was marked paid by hand, so no Xero invoice is expected for it",
  "credit-applied":
    "account credit was applied to the booking, so its invoice would bill more than the card paid",
  "amount-differs":
    "the booking's price no longer equals what the card paid, so its invoice would not match the money",
};

/**
 * CAN THE ORDINARY BOOKING INVOICE RECORD THIS KEPT PRIMARY CAPTURE EXACTLY?
 * `null` means yes. The one rule, asked by the dismissal and by the repair tool
 * (`INV-SSOT`). The worker bills `finalPriceCents` (guest nights plus the promo
 * line) and records the payment's NET capture, so all three must equal the kept
 * cents.
 */
export function keptPrimaryCaptureInvoiceRefusal(input: {
  keptCents: number;
  finalPriceCents: number;
  payment: {
    source: PaymentSource;
    xeroInvoiceId: string | null;
    manuallyMarkedPaidAt: Date | null;
    creditAppliedCents: number;
    amountCents: number;
    refundedAmountCents: number;
  };
  /** An active PRIMARY_INVOICE link for the payment exists. */
  hasPrimaryInvoiceLink: boolean;
}): KeptPrimaryCaptureInvoiceRefusal | null {
  const { payment } = input;
  if (input.keptCents <= 0) return "not-captured";
  if (payment.source !== PaymentSource.STRIPE) return "not-card";
  if (payment.xeroInvoiceId || input.hasPrimaryInvoiceLink) return "invoice-exists";
  if (payment.manuallyMarkedPaidAt) return "manually-settled";
  if (payment.creditAppliedCents > 0) return "credit-applied";
  const netCapturedCents = payment.amountCents - payment.refundedAmountCents;
  if (
    input.finalPriceCents !== input.keptCents ||
    netCapturedCents !== input.keptCents
  ) {
    return "amount-differs";
  }
  return null;
}

/**
 * HAS THIS KEPT CAPTURE'S BOOKING INVOICE ALREADY BEEN ASKED FOR? A booking
 * invoice CREATE for the payment queued at or after the approval task was raised
 * (the task is raised by the capture, and a card booking is otherwise invoiced
 * only at capture), in any state but CANCELLED. A reopened-and-dismissed-again
 * task, or the repair tool after the dismissal queued one, finds it and queues
 * nothing more. A FAILED or PARTIAL one counts: it is retried, never replaced.
 */
export function keptPrimaryCaptureInvoiceQueued(input: {
  raisedAt: Date;
  paymentOperations: ReadonlyArray<{
    entityType: string;
    operationType: string;
    direction: string;
    queueType: string | null;
    status: string;
    createdAt: Date;
  }>;
}): boolean {
  return input.paymentOperations.some(
    (operation) =>
      operation.direction === "OUTBOUND" &&
      operation.entityType === "INVOICE" &&
      operation.operationType === "CREATE" &&
      operation.queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE &&
      operation.status !== "CANCELLED" &&
      operation.createdAt.getTime() >= input.raisedAt.getTime(),
  );
}
