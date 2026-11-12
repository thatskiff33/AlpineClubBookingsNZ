import { prisma } from "@/lib/prisma";
import { bookingTimingsFrom, type BookingTimings } from "@/lib/booking-timings";

/**
 * Three timings a club may set (#4932, `INV-CONFIG-001`), all on the
 * `BookingDefaults` singleton and edited beside the club's other booking
 * defaults on the Cancellation policy page.
 *
 * - `preArrivalReminderDays`: how many days before check-in the pre-arrival
 *   reminder goes out (read by the pre-arrival cron).
 * - `additionalPaymentReminderDays`: how many days after an extra amount is
 *   raised the first reminder to pay it goes out (`INV-ADDPAY`).
 * - `policyExceptionHoldDays`: how long a policy-exception request keeps the
 *   beds it holds. Read ONLY when a request is raised, because the deadline is
 *   stamped then and never rewritten (`INV-EXCEPT`); a later change to this
 *   setting moves no existing request.
 */
const BOOKING_TIMING_SELECT = {
  preArrivalReminderDays: true,
  additionalPaymentReminderDays: true,
  policyExceptionHoldDays: true,
} as const;

/** Reads the three timings; a club that never saved the row gets the defaults. */
export async function getBookingTimingSettings(): Promise<BookingTimings> {
  const row = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
    select: BOOKING_TIMING_SELECT,
  });
  return bookingTimingsFrom(row);
}
