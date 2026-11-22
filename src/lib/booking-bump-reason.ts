/**
 * Why the confirm-pending cron bumped a pending booking at its hold deadline,
 * in one plain sentence (#5403). The booking's BUMPED event, the officers'
 * `admin-booking-bumped` alert and that alert's editor preview all read it from
 * here, so they cannot disagree.
 *
 * `flagged` is the member's "only book if my guests can come" choice
 * (`Booking.cancelIfGuestsBumped`): the whole booking was released, and the
 * member was sent the guests-cancelled email rather than the plain bumped one.
 */
export function bookingBumpReason(flagged: boolean): string {
  return flagged
    ? "These dates filled up before the guests could be confirmed, and the member had asked for the whole booking to be cancelled if their guests could not come."
    : "These dates filled up before the provisional guests were confirmed.";
}
