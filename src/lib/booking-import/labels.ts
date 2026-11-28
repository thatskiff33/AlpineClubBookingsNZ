/**
 * Plain names for the import's refusal codes, as the preview and batch
 * screens group refused bookings by them (#5005, child C). Type-only import,
 * so the screen can use it in the browser; the `Record` makes a new code
 * without a name a type error.
 */
import type { BookingImportRefusalCode } from "@/lib/booking-import/plan";

export const BOOKING_IMPORT_REFUSAL_LABELS: Record<BookingImportRefusalCode, string> = {
  UNREADABLE: "Could not be read",
  PART_PAID: "Part-paid",
  LODGE: "Wrong or inactive lodge",
  MEMBER: "Member not matched",
  PAST_CHECK_IN: "Check In before today",
  ALREADY_IMPORTED: "Booking Ref already imported",
  PERSON_NIGHT: "Member already booked that night",
  HOSTING: "Breaks the club's hosting rule",
  SUPERVISION: "Children with no adult",
  WHOLE_LODGE_HOLD: "Lodge held exclusively",
  OVER_CAPACITY: "Over capacity",
  NOT_SETTLED: "Payment could not be recorded",
};
