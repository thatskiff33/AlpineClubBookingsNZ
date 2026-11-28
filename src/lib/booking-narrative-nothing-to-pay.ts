/**
 * #3955 round 3 (`INV-PAY-119`): the wording for a payable booking that owes
 * nothing — its price plus any change fee recorded on its payment, less any
 * applied account credit, is at or below zero. The payment link's card would
 * charge nothing, so the page offers no payment and no fresh link, and says
 * why: the credit is named only where some is applied (round 4, finding 5).
 *
 * Its own module only because `booking-narrative.ts` is at its size budget;
 * `buildPayableNarrative` there is the one caller, and it decides when this
 * applies (the caller supplied what the booking owes, and it is at or below
 * zero), and whether any credit is applied.
 */
import type { BookingNarrative } from "@/lib/booking-narrative";

export function nothingToPayNarrative(range: string, creditApplied: boolean): BookingNarrative {
  return {
    state: "nothing_to_pay",
    headline: "Nothing to pay",
    message: creditApplied
      ? `Your booking for ${range} has nothing left to pay — the account credit applied to it covers what it owes.`
      : `Your booking for ${range} has nothing left to pay.`,
    nextStep: "If your bookings page still shows it as unpaid, contact the club and we'll sort it out.",
  };
}
