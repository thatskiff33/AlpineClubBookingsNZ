- **An unused officer endpoint for a member's family links has been removed
  (#5405).** `GET /api/admin/members/[id]/family` had not been called by any
  screen since July 2026, when the two officer booking screens that used it
  moved to their own endpoints. Nothing an officer or member sees changes.

  If a fork or an external tool still calls it, it will now get a 404. Use
  `GET /api/admin/bookings/eligible-family` or
  `GET /api/admin/bookings/[id]/eligible-family` instead: they return the same
  shape, and need permission to edit bookings where the removed endpoint needed
  permission to view memberships.
