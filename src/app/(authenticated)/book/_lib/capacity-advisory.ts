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
 *
 * WHOSE NIGHT IT IS, THOUGH, IS NOT DECIDED HERE. Which guests occupy a given
 * night is the frozen night model in `booking-guest-stay-ranges.ts`, and this
 * module calls it rather than restating it (`INV-SSOT-001`). The first draft
 * restated it and dropped one of its two branches: it compared the guest's
 * `stayStart`/`stayEnd` envelope alone, so a guest with an EXPLICIT night set —
 * the "Multiple date ranges" mode (#713), where the envelope is only a bounding
 * box and the gaps inside it are absences — was counted as present on nights
 * they had not asked for. That overstated the party on the gap nights, and since
 * #2930 the overstatement decides `waitlistOnly`: it withdrew the payment-method
 * chooser and replaced Confirm Booking with Join Waitlist for a stay the server
 * would have confirmed.
 */
import { isGuestActiveOnNight } from "@/lib/booking-guest-stay-ranges";
import { parseDateOnly } from "@/lib/date-only";

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

/**
 * A proposed guest, in the shapes the wizard's `GuestData` carries: an optional
 * per-guest stay range, and an optional explicit night set which OVERRIDES it
 * (#713). Both are `yyyy-MM-dd`.
 */
export interface AdvisoryGuest {
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: readonly string[] | null;
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
 * Who occupies a night is `isGuestActiveOnNight`, unchanged and uncopied: an
 * explicit night set wins, and otherwise the half-open `[stayStart, stayEnd)`
 * envelope applies, so the departure morning is not counted against a guest
 * (`INV-DATE-003`). It is the same predicate `checkCapacity` counts beds with on
 * the server, which is what makes this advisory agree with the answer it is
 * previewing.
 */
export function getCapacityShortNights(
  nights: readonly AdvisoryNight[],
  guests: readonly AdvisoryGuest[],
  bookingDates: { checkIn: string; checkOut: string } | null,
): string[] {
  if (!bookingDates || nights.length === 0) return [];

  // The booking envelope, decoded once. `parseDateOnly` yields the UTC-midnight
  // encoding of a calendar day, which is what the night model reads.
  const bookingRange = {
    checkIn: parseDateOnly(bookingDates.checkIn),
    checkOut: parseDateOnly(bookingDates.checkOut),
  };
  const stayRanges = guests.map((guest) => ({
    stayStart: guest.stayStart ? parseDateOnly(guest.stayStart) : null,
    stayEnd: guest.stayEnd ? parseDateOnly(guest.stayEnd) : null,
    // Passed by REFERENCE rather than copied: the night model caches the derived
    // key set against this array, so re-deriving it per night would defeat that.
    nights: guest.nights ?? null,
  }));

  return nights
    .filter((night) => {
      const nightDate = parseDateOnly(night.date);
      const activeGuests = stayRanges.filter((guest) =>
        isGuestActiveOnNight(guest, nightDate, bookingRange),
      ).length;
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
