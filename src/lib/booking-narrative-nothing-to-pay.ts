/**
 * #3955 round 3 (`INV-PAY-119`): the wording for a payable booking whose
 * applied account credit covers everything it owes — its price plus any change
 * fee recorded on its payment. The payment link's card would charge nothing,
 * so the page offers no payment and no fresh link, and says why.
 *
 * Its own module only because `booking-narrative.ts` is at its size budget;
 * `buildPayableNarrative` there is the one caller, and it decides when this
 * applies (the caller supplied what the booking owes, and it is at or below
 * zero).
 */
import type { BookingNarrative } from "@/lib/booking-narrative";

export function nothingToPayNarrative(range: string): BookingNarrative {
  return {
    state: "nothing_to_pay",
    headline: "Nothing to pay",
    message: `Your booking for ${range} has nothing left to pay — the account credit applied to it covers what it owes.`,
    nextStep: "If your bookings page still shows it as unpaid, contact the club and we'll sort it out.",
  };
}
