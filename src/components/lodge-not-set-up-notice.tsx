import { LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE } from "@/lib/lodge-booking-readiness";

/**
 * The booking calendar's "not set up yet" notice (#3407, owner decision
 * 14 Sep 2026): at a lodge nobody has given a capacity, every night would
 * otherwise compute as zero free beds and read "Waitlist" or "Full", an
 * invitation the server refuses before the waitlist is reached, because a
 * party of one already exceeds a limit of zero. The calendar says the lodge is
 * not set up yet instead, and offers no night.
 *
 * The `role="status"` wrapper is permanently mounted so the live region exists
 * before its content does: a polite region injected already-populated is
 * dropped by some screen-reader/browser pairings.
 */
export function LodgeNotSetUpNotice({ show }: { show: boolean }) {
  return (
    <div role="status" data-testid="lodge-not-set-up">
      {show ? (
        <p className="rounded-md border border-warning-7 bg-warning-muted px-3 py-2 text-sm text-warning">
          {LODGE_NOT_SET_UP_FOR_BOOKINGS_MESSAGE} No dates can be booked here
          until it is.
        </p>
      ) : null}
    </div>
  );
}
