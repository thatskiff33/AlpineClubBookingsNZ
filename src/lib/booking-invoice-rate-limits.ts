import type { RateLimitConfig } from "@/lib/rate-limit";

/**
 * The booking invoice download's own budgets (#5066). Every download is a live
 * Xero read, so the club's Xero minute and daily limits are what these protect
 * (`HOLD_READ_DAILY_BUDGET` is the same idea for the hold sweep's reads). Kept
 * beside the feature rather than in `rateLimiters`, which is at its size budget.
 */

/** 10 downloads per member per hour. */
export const BOOKING_INVOICE_DOWNLOAD_MEMBER_LIMIT: RateLimitConfig = {
  id: "booking-invoice-download",
  limit: 10,
  windowSeconds: 60 * 60,
};

/** 20 downloads per booking per hour, across every viewer, so several officers on one booking cannot multiply the reads. */
export const BOOKING_INVOICE_DOWNLOAD_BOOKING_LIMIT: RateLimitConfig = {
  id: "booking-invoice-download-booking",
  limit: 20,
  windowSeconds: 60 * 60,
};
