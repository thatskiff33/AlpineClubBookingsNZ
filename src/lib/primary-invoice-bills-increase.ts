import type { PaymentSource } from "@prisma/client";

import { isCapturedPaymentStatus, isSettledBookingStatus } from "@/lib/booking-payment-state";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";

/** The `Payment.source` whose increases Xero bills, checked by the compiler. */
const INTERNET_BANKING_PAYMENT_SOURCE = "INTERNET_BANKING" satisfies PaymentSource;

/**
 * #5288 (`INV-PAY-163`, owner decision 20 Nov 2026): is this edit's increase
 * billed by raising the booking's primary Xero invoice now? The Internet
 * Banking counterpart of `canAskCardForIncrease`: a settled booking on a
 * settled Internet Banking payment - typically one account credit paid in full
 * - with no primary invoice linked yet. It has no card to ask and no invoice
 * for a supplementary one to sit beside, so the primary invoice, which bills
 * the price plus every recorded fee, carries the increase.
 *
 * Not a booking marked paid by hand: the invoice enqueue refuses it (#2262),
 * so the member would be told of an invoice that never comes. Not an
 * organiser's place: the organiser's combined invoice bills it (#4299).
 */
function billsIncreaseOnNewPrimaryInvoice(
  booking: {
    status: string;
    organiserSettled: boolean;
    parentBookingId: string | null;
    payment:
      | { status: string; source: PaymentSource; xeroInvoiceId: string | null; manuallyMarkedPaidAt: Date | null }
      | null;
  },
  edit: { netAmountCents: number; hasSucceededPayment: boolean; hasIssuedXeroInvoice: boolean },
): boolean {
  return (
    edit.netAmountCents > 0 &&
    !edit.hasSucceededPayment &&
    !edit.hasIssuedXeroInvoice &&
    !paidByOrganiserInternetBanking(booking) &&
    isSettledBookingStatus(booking.status) &&
    isCapturedPaymentStatus(booking.payment?.status ?? "") &&
    booking.payment?.source === INTERNET_BANKING_PAYMENT_SOURCE &&
    !booking.payment.xeroInvoiceId &&
    !booking.payment.manuallyMarkedPaidAt
  );
}

type IncreaseBooking = Parameters<typeof billsIncreaseOnNewPrimaryInvoice>[0];
type IncreaseEdit = Parameters<typeof billsIncreaseOnNewPrimaryInvoice>[1];

/**
 * How much of an edit's net is billed in Xero, and on which invoice: the whole
 * increase, on the edit's supplementary invoice once the primary is issued, or
 * (#5288) on the primary invoice the door raises when none is linked. Zero
 * otherwise - a reduction, a card ask, or a booking nothing bills.
 */
export function xeroBilledIncrease(
  booking: IncreaseBooking,
  edit: IncreaseEdit,
): { xeroAdditionalAmountCents: number; primaryInvoiceBillsIncrease: boolean } {
  const primaryInvoiceBillsIncrease = billsIncreaseOnNewPrimaryInvoice(booking, edit);
  const billed = (edit.hasIssuedXeroInvoice || primaryInvoiceBillsIncrease) && edit.netAmountCents > 0;
  return { xeroAdditionalAmountCents: billed ? edit.netAmountCents : 0, primaryInvoiceBillsIncrease };
}
