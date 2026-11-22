/**
 * When a booking's non-member hold ends: its check-in less the club's hold
 * days, counted as whole 24-hour spans of elapsed time (#5407). Until then the
 * non-member guests hold a provisional place that members may still claim.
 *
 * The one definition. Booking create (the single booking and a split's
 * guest child), a guest edit, a modification's settlement, a date change, an
 * approved request's hold, an accepted waitlist offer and the confirm-pending
 * cron's first-expiry anchor all read it, so a hold minted by one and read
 * back by another cannot drift. (The waitlist stepped UTC calendar days, which
 * on a whole-day count is the same instant.)
 * The arithmetic is unchanged from the copies it replaced: an instant minus a
 * fixed number of milliseconds, with no club-zone or calendar-day step, so a
 * daylight-saving change between the two moves the result by that hour exactly
 * as before.
 *
 * A leaf module with no imports (INV-SSOT-008): `booking-request-hold.ts`, a
 * leaf itself, reads it without closing a cycle.
 */
export function nonMemberHoldEnd(checkIn: Date, holdDays: number): Date {
  return new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000);
}
