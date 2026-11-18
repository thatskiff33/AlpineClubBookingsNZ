import "server-only";

import type { BookingInvoiceAccount } from "@/lib/booking-invoice-access";
import { bookingInvoiceSummary } from "@/lib/booking-invoice-summary";
import type { BookingAmountOwed } from "@/lib/booking-payment-state";
import { primaryInvoiceUpdateNotice, readPrimaryInvoiceUpdateState } from "@/lib/booking-primary-invoice-update-state";
import type { BookingDetailRecord } from "./load-booking-detail";

const accountDependencies = { invoiceUpdateState: readPrimaryInvoiceUpdateState };

/**
 * The account lines beside a booking's offered Xero invoice (#5066; owner
 * decision on PR #5201, 17 Nov 2026): the summary from the app's own records
 * (`bookingInvoiceSummary`) and, when the app knows the invoice in Xero does not
 * show the latest change (an invoice update skipped, failed or still queued, or
 * a credit note for a change not yet created), the plain-words line that says so. Called only once the offer is `XERO_INVOICE`,
 * so the booking has a payment and a primary invoice id.
 */
export async function resolveBookingInvoiceAccount(
  booking: BookingDetailRecord,
  amountOwed: BookingAmountOwed,
  dependencies = accountDependencies,
): Promise<BookingInvoiceAccount> {
  const summary = bookingInvoiceSummary(booking, amountOwed);
  const payment = booking.payment;
  if (!payment?.xeroInvoiceId) return { summary, invoiceUpdateNotice: null };
  const state = await dependencies.invoiceUpdateState({
    bookingId: booking.id,
    paymentId: payment.id,
    xeroInvoiceId: payment.xeroInvoiceId,
    modificationIds: booking.modifications.map((modification) => modification.id),
  });
  return { summary, invoiceUpdateNotice: primaryInvoiceUpdateNotice(state) };
}
