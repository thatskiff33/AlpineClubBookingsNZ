import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";

/**
 * The club's three booking timings, in days (#4932, `INV-CONFIG-001`), as one
 * dependency-free shape the server reader, the Cancellation policy route and the
 * admin form all share. See `getBookingTimingSettings` for what each one does.
 */
export const BOOKING_TIMING_KEYS = [
  "preArrivalReminderDays",
  "additionalPaymentReminderDays",
  "policyExceptionHoldDays",
] as const;

export type BookingTimings = Record<(typeof BOOKING_TIMING_KEYS)[number], number>;

/**
 * Just the three timings from a stored row, a GET or PUT echo, or a larger
 * draft; a value it lacks (or a missing row) is the shipped default.
 */
export function bookingTimingsFrom(
  data: Partial<BookingTimings> | null | undefined,
): BookingTimings {
  return {
    preArrivalReminderDays:
      data?.preArrivalReminderDays ?? DEFAULT_BOOKING_DEFAULTS.preArrivalReminderDays,
    additionalPaymentReminderDays:
      data?.additionalPaymentReminderDays ??
      DEFAULT_BOOKING_DEFAULTS.additionalPaymentReminderDays,
    policyExceptionHoldDays:
      data?.policyExceptionHoldDays ?? DEFAULT_BOOKING_DEFAULTS.policyExceptionHoldDays,
  };
}
