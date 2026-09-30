- **Finance figures drop soft-deleted bookings (#3745).** Guest nights,
  occupancy, booked revenue, the payment status counts, outstanding and
  collected additional payments, and the booking hut fees the P&L view compares
  with Xero no longer count a booking an admin has deleted. Net collected cash
  already left deleted bookings out (#3637), so every Finance figure now counts
  the same bookings, the same as Reports' default view. A figure changes only
  where a deleted booking still holds a stay status; bookings deleted through
  the admin delete action are cancelled first, and were already left out.
