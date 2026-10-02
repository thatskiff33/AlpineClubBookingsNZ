/**
 * Fixtures for the hut-leader stay check (#3817).
 *
 * The manual create and edit refuse a role-only assignment that claims a night
 * the member is not staying (`findHutLeaderStayRefusal`), which reads
 * `bookingGuest.findMany` (the member's guest rows) and `booking.findMany` (the
 * bookings they own). A route test about something else — overlap, locking,
 * audit — answers those reads with a stay covering the assignment's nights.
 */

function storedDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * One guest row whose stay is the nights `firstNight` .. `checkOut - 1` (the
 * half-open envelope `[firstNight, checkOut)`, no explicit night set), in the
 * shape the stay check selects.
 */
export function hutLeaderStayGuestRow(firstNight: string, checkOut: string) {
  return {
    stayStart: storedDay(firstNight),
    stayEnd: storedDay(checkOut),
    nights: [] as Array<{ stayDate: Date }>,
    booking: { checkIn: storedDay(firstNight), checkOut: storedDay(checkOut) },
  };
}
