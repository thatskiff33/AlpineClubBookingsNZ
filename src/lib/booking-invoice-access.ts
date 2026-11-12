/**
 * Who may download a booking's invoice (fork #115, owner decision 1): everyone
 * who can view the booking page EXCEPT a linked guest viewer — a guest on
 * someone else's booking. That is the booking's manager (its owner, or an
 * admin) and an admin with bookings view access.
 *
 * THE ONE RULE for the Download invoice button and `GET
 * /api/bookings/[id]/invoice` (`INV-SSOT`). It reads the page's own
 * `resolveBookingDetailViewer` answer, so the button can never be shown to
 * someone the route refuses, or the reverse. A deleted booking stays admin-only,
 * as on the page.
 */
export function canDownloadBookingInvoice(
  viewer: { isAdmin: boolean; canManageBooking: boolean; canViewAsAdmin: boolean },
  booking: { deletedAt: Date | null },
): boolean {
  if (booking.deletedAt && !viewer.isAdmin) return false;
  return viewer.canManageBooking || viewer.canViewAsAdmin;
}
