/**
 * The furthest ahead, in days from the club's today, a stay may start when it
 * is only being asked about rather than booked: the central server's
 * availability lookups (`CENTRAL_AVAILABILITY_MAX_DAYS_AHEAD`) and the booking
 * form's "work parties during your stay" list (`GET /api/work-parties/active`,
 * owner decision, #5305). One value so the two cannot drift (`INV-SSOT`).
 *
 * A bound on a lookup, not a booking rule: booking itself has no horizon.
 */
export const BOOKING_HORIZON_DAYS = 730;
