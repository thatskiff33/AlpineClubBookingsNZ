- **Finance figures drop soft-deleted bookings (#3745).** Guest nights,
  occupancy, booked revenue, the payment status counts, outstanding and
  collected additional payments, and the booking hut fees the P&L view compares
  with Xero no longer count a booking an admin has deleted. Net collected cash
  already left deleted bookings out (#3637), so every Finance figure now counts
  the same bookings, the same as Reports' default view. The admin delete
  action only deletes bookings that are already cancelled (INV-ADDPAY-030),
  which Finance already left out, so most clubs will see no change: a figure
  moves only where a direct database edit left a deleted booking with a stay
  status.
- **The legacy dashboard booking export leaves deleted bookings out too
  (#3745).** Its past-stay and forward-pipeline lists no longer include a
  booking an admin has deleted, so they match the Finance dashboard. Deleted
  bookings are always cancelled, which the export already left out, so most
  clubs will see no change here either.
