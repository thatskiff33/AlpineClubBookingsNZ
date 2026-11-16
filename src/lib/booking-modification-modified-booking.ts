// A booking as an edit returns it: the row with its guests and payment. Moved
// verbatim from `booking-batch-modification-service.ts` and
// `booking-date-modification-service.ts`, which each carried the same text, so
// the shape has one home (`INV-SSOT`) and both files stay under their length on
// main (#4926: past the hard ceiling a file may only stay or shrink). #5151's
// transaction-result modules re-export it rather than define it again. Type only.
import type { Booking, BookingGuest, Payment } from "@prisma/client";

export type ModifiedBooking = Booking & {
  guests: BookingGuest[];
  payment: Payment | null;
};
