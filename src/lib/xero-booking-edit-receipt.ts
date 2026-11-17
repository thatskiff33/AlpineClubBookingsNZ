import { PaymentSource, PaymentTransactionKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import type { ClassifyXeroBookingEditSettlementInput } from "@/lib/xero-booking-edit-settlement";

/**
 * #3979: the bank-receipt read `queueXeroBookingEditSettlement` makes before
 * classifying an edit, moved verbatim from `xero-booking-edit-settlement.ts`
 * (size budget, #5151). The input comes back unchanged unless the aggregate
 * status alone could wrongly refuse an invoice correction.
 */
export async function withInternetBankingReceiptRead<T extends ClassifyXeroBookingEditSettlementInput & { bookingId: string }>(
  input: T,
): Promise<T> {
  return mayCorrectDespiteCapturedAggregate(input)
    ? { ...input, internetBankingReceiptCaptured: await readInternetBankingReceiptCaptured(input.bookingId) }
    : input;
}

/**
 * #3979: the only state in which the aggregate payment status can wrongly
 * refuse an invoice correction - a reduction whose money is not a Stripe
 * refund, on a payment whose aggregate reads captured. Only then is the
 * receipt itself read.
 */
function mayCorrectDespiteCapturedAggregate(input: ClassifyXeroBookingEditSettlementInput): boolean {
  return (
    input.internetBankingReceiptCaptured === undefined &&
    input.hasIssuedXeroInvoice &&
    input.priceDiffCents + (input.changeFeeCents ?? 0) < 0 &&
    input.refundMethod == null &&
    input.refundedThroughStripe === false &&
    // A refunded aggregate is the #1765 shape: a card capture refunded before
    // the switch, with the bank receipt possibly never captured. A SUCCEEDED
    // aggregate whose money is not a Stripe refund is a captured bank receipt
    // (or an officer's cash), so nothing needs reading.
    (input.originalPaymentStatus === "REFUNDED" || input.originalPaymentStatus === "PARTIALLY_REFUNDED")
  );
}

/** Whether any Internet Banking PRIMARY receipt of the booking's payment was captured. */
async function readInternetBankingReceiptCaptured(bookingId: string): Promise<boolean> {
  const captured = await prisma.paymentTransaction.findFirst({
    where: {
      payment: { bookingId },
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.INTERNET_BANKING,
      status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
    },
    select: { id: true },
  });
  return captured !== null;
}
