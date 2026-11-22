/**
 * Why the confirm-pending cron bumped a pending booking at its hold deadline,
 * in one sentence (#5403). The booking's BUMPED event, the officers'
 * `admin-booking-bumped` alert and that alert's editor preview all read it from
 * here, so they cannot disagree.
 *
 * `flagged` is the member's "only book if my guests can come" choice
 * (`Booking.cancelIfGuestsBumped`): the whole booking was released because the
 * party could not be confirmed together, and the member was sent the
 * guests-cancelled email rather than the plain bumped one.
 */
export function bookingBumpReason(flagged: boolean): string {
  return flagged
    ? "Released because the whole party could not be confirmed (only-if-guests-come)."
    : "These dates filled up before the provisional guests were confirmed.";
}
