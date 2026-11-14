/**
 * When an approved booking request's non-member hold expires.
 *
 * A leaf module (#4930): both `booking-request.ts` and `group-booking.ts` read
 * it, and `group-booking` importing `booking-request` for this one function
 * closed an import cycle through booking-cancel and group settlement. Keep it
 * free of `@/lib` imports (INV-SSOT-008). `booking-request.ts` imports `DAY_MS`
 * from here rather than keeping its own copy.
 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve when the booking's non-member hold expires. Member-priority
 * bumping applies until the requester pays. Late approvals still get at
 * least 48 hours to pay, but never beyond check-in.
 */
export function resolveRequestBookingHoldUntil(
  checkIn: Date,
  holdDays: number,
  now: Date = new Date()
): Date {
  const standardHold = new Date(checkIn.getTime() - holdDays * DAY_MS);
  const minimumHold = new Date(now.getTime() + 2 * DAY_MS);
  const hold = standardHold > minimumHold ? standardHold : minimumHold;
  return hold > checkIn ? checkIn : hold;
}
