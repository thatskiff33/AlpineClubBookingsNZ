/**
 * What the member booking wizard tells somebody whose party will not fit, and
 * nothing more (#2930).
 *
 * ADVISORY IS THE WHOLE POINT, AND IT IS A CHANGE OF KIND. The guests step used
 * to REFUSE to continue when the chosen range was full, and that refusal was
 * purely client-side — so a member whose dates were full never reached the
 * server, never got the 409 that carries `canWaitlist`, and therefore never saw
 * the waitlist prompt the product has had all along. The one door out of a full
 * lodge was locked by the screen standing in front of it. The server remains the
 * authority on capacity; this only says what to expect on the way there.
 *
 * A HELD NIGHT IS INDISTINGUISHABLE HERE, and could not be anything else.
 * `/api/availability/check` pins a whole-lodge-held night to a full lodge at
 * zero available beds and projects no hold flag at all (`INV-CAP-021`,
 * `INV-CAP-038`, ADR-001 decision 6), so this arithmetic has nothing to tell
 * apart and the wording below is one sentence for both cases by construction
 * rather than by discipline.
 *
 * Extracted from `use-booking-wizard.ts` rather than left inline: it is pure,
 * it is the piece worth testing on its own, and the hook it came from is over
 * its file-size budget.
 */

/** One night's figures as `/api/availability/check` reports them. */
export interface AdvisoryNight {
  /** `yyyy-MM-dd` (`INV-DATE-014`). */
  date: string;
  /**
   * Free beds at this lodge on this night. A held night arrives as 0 — pinned,
   * never negative — exactly like a lodge that is genuinely full.
   */
  availableBeds: number;
}

/** A proposed guest, with the optional per-guest stay range the wizard allows. */
export interface AdvisoryGuest {
  stayStart?: string | null;
  stayEnd?: string | null;
}

/**
 * The nights this party will not fit on.
 *
 * Returns `[]` when there are no per-night figures — the check failed, or has
 * not answered. Saying nothing is deliberate: an advisory built on absent data
 * would either invent a shortfall or hide a real one, and the server decides
 * either way. This is the same "absent is not zero" rule the calendar applies to
 * an unloaded month.
 *
 * Counting is per night and half-open, matching the stay itself: a guest occupies
 * `[stayStart, stayEnd)`, so the departure morning is not counted against them
 * (`INV-DATE-003`).
 */
export function getCapacityShortNights(
  nights: readonly AdvisoryNight[],
  guests: readonly AdvisoryGuest[],
  bookingDates: { checkIn: string; checkOut: string } | null,
): string[] {
  if (!bookingDates || nights.length === 0) return [];

  return nights
    .filter((night) => {
      const activeGuests = guests.filter((guest) => {
        const stayStart = guest.stayStart ?? bookingDates.checkIn;
        const stayEnd = guest.stayEnd ?? bookingDates.checkOut;
        return stayStart <= night.date && night.date < stayEnd;
      }).length;
      return activeGuests > night.availableBeds;
    })
    .map((night) => night.date);
}

/**
 * The sentence the member is shown. Deliberately the same one whatever the
 * reason: a lodge full of bookings and a lodge held for one group are both "no
 * beds", and naming the difference is the one thing decision 6 forbids.
 *
 * It ends by saying the waitlist is still open, because the previous wording
 * ("does not have enough beds on …") was attached to a hard stop and read as a
 * verdict rather than as the next step.
 */
export function formatCapacityShortMessage(
  lodgeLabel: string,
  shortNights: readonly string[],
): string {
  if (shortNights.length === 1) {
    return `${lodgeLabel} is full on ${shortNights[0]}. You can still continue and join the waitlist.`;
  }

  return `${lodgeLabel} is full on ${shortNights.length} of your nights. You can still continue and join the waitlist.`;
}
