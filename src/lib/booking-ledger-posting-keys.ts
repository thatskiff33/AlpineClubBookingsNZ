/**
 * THE ONE HOME FOR A BOOKING-LEDGER POSTING KEY (#3595, `INV-MONEY-033`).
 *
 * A key is derived from the EVENT a line records — never from when it was
 * posted or by whom — so posting the same event twice produces the same key,
 * and the write door's `ON CONFLICT DO NOTHING` makes the second a no-op.
 *
 * Every format lives here and nowhere else. Review of #3597 found the formats
 * restated in five places (schema comment, design doc twice, invariant,
 * migration); a posting child that hand-rolled its own spelling would produce
 * keys that never collide with the ones this module makes, which is the
 * double-post this whole mechanism exists to prevent. The docs now show
 * examples and point here.
 *
 * WHAT A KEY DOES NOT DO, stated so nobody leans on it for more: a key makes
 * one EVENT idempotent. It does not make a booking's confirmation happen once
 * — the nights a booking holds can change between two settles, so their keys
 * change too. That is fenced separately, per booking, in the settle
 * (`bookingHasConfirmationLines`).
 */
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";

/** One guest's one night, as confirmed. */
export function confirmationNightKey(
  bookingId: string,
  bookingGuestId: string,
  stayDate: Date,
): string {
  return `confirmation:${bookingId}:night:${bookingGuestId}:${calendarDateOfDateOnlyInstant(stayDate)}`;
}

/** The booking's promotion adjustment, as confirmed. */
export function confirmationPromotionKey(bookingId: string): string {
  return `confirmation:${bookingId}:promotion`;
}

/**
 * The reversal of a line, keyed by the REVERSED LINE'S ID rather than its key:
 * every line has an id, but a line posted before #3595 has no key. Keyed this
 * way, a second reversal of the same line always carries the same key as the
 * first, so a replay is skipped — and the database's unique `reversesLineId`
 * agrees with the unique key rather than being a second arbiter the write's
 * `ON CONFLICT DO NOTHING` could silently satisfy with a different posting.
 */
export function reversalKey(reversedLineId: string): string {
  return `reversal:${reversedLineId}`;
}
