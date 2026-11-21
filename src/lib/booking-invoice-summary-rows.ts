import type { BookingInvoiceSummary } from "@/lib/booking-invoice-summary";

/**
 * The account rows of a booking's invoice summary (#5066), in words and order,
 * read by both the booking page's Invoice and credits card and the app's
 * generated invoice PDF, so the two say the same thing in the same words about
 * the same figures (`INV-SSOT`). Pure and client-safe.
 *
 * `bookingInvoiceSummary`: paid = total + change fees - credit - due + kept.
 */
export type BookingInvoiceSummaryRow = { label: string; cents: number; emphasis: boolean };

const BALANCE_LABEL: Readonly<Record<BookingInvoiceSummary["balanceWhen"], string>> = {
  NOW: "Still to pay",
  AFTER_REVIEW: "Due once reviewed",
  AFTER_CONFIRMATION: "Due once confirmed",
};

/** What the booking costs: its total, and its change fees when it has any. */
export function bookingInvoiceChargeRows(summary: BookingInvoiceSummary): BookingInvoiceSummaryRow[] {
  return [
    { label: "Booking total", cents: summary.totalCents, emphasis: false },
    ...(summary.changeFeeCents > 0 ? [{ label: "Change fees", cents: summary.changeFeeCents, emphasis: false }] : []),
  ];
}

/** What has been settled and what is left: credit, payments, anything kept, then the balance. */
export function bookingInvoiceAccountRows(summary: BookingInvoiceSummary): BookingInvoiceSummaryRow[] {
  return [
    { label: "Account credit applied", cents: summary.creditAppliedCents, emphasis: false },
    { label: "Paid, less refunds and credits returned", cents: summary.paidCents, emphasis: false },
    ...(summary.keptCents > 0
      ? [{ label: "Kept under the booking's change terms", cents: summary.keptCents, emphasis: false }]
      : []),
    { label: BALANCE_LABEL[summary.balanceWhen], cents: summary.balanceCents, emphasis: true },
  ];
}
