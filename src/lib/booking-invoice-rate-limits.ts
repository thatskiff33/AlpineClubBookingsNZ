import type { RateLimitConfig } from "@/lib/rate-limit";

/**
 * The booking invoice download's own budgets (#5066), shared by the invoice and
 * its credit notes (one budget per member, one per booking, across both
 * routes). Every download is a live Xero read, so the club's Xero minute and
 * daily limits are what these protect
 * (`HOLD_READ_DAILY_BUDGET` is the same idea for the hold sweep's reads). Kept
 * beside the feature rather than in `rateLimiters`, which is at its size budget.
 */

/** 10 downloads per member per hour, checked first. It binds an officer working through many bookings too. */
export const BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT: RateLimitConfig = {
  id: "booking-invoice-download",
  limit: 10,
  windowSeconds: 60 * 60,
};

/**
 * 20 downloads per booking per hour, across every viewer, so several officers on
 * one booking cannot multiply the reads. Charged only once the caller is
 * authorised and the document is on offer (`prepareBookingInvoiceDownload`), so
 * holding another member's booking id cannot spend this booking's allowance.
 */
export const BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT: RateLimitConfig = {
  id: "booking-invoice-download-booking",
  limit: 20,
  windowSeconds: 60 * 60,
};
