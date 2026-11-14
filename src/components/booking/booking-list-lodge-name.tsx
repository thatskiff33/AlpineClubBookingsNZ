/**
 * INV-CAP-039: the lodge line under a booking LIST row's dates — My Bookings
 * and the dashboard's Next Stay, draft and Recent Bookings rows.
 *
 * It renders whatever `bookingListLodgeLabel` (`@/lib/lodges`) decided on the
 * server and nothing else: null means the ADR-002 single-lodge rule hid the
 * name, so the row looks as it always has. The decision is never re-made here.
 */
export function BookingListLodgeName({
  lodgeLabel,
}: {
  lodgeLabel: string | null;
}) {
  if (!lodgeLabel) return null;
  return (
    <p className="text-xs font-medium" data-testid="booking-list-lodge">
      {lodgeLabel}
    </p>
  );
}
