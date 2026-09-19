- **The Xero health screen's "Missing invoices" list no longer names bookings
  whose invoice is already in Xero (#3467).** The list used to decide a
  booking was missing an invoice from whether its invoice operation had
  finished successfully, so a booking whose operation failed *after* Xero had
  accepted the invoice — a later bookkeeping step threw — was listed as
  missing although the accounts held it. A treasurer working the list chased
  invoices that already existed, and the **Trigger All Missing** button
  offered to raise a second one.

  The list now asks the same question the booking's own page and the invoice
  queue ask (#3001): does the club's record of this booking carry an invoice id
  or an active primary-invoice link? A booking whose invoice reached Xero stays
  off the list and shows under **Failed** operations instead, where its own
  page says which step is outstanding. A booking whose records hold neither an
  invoice id nor an active primary-invoice link is still listed. The finance
  dashboard's "Bookings missing invoices" figure and the stuck-state
  dashboard's "Paid bookings missing Xero invoices" item read the same count
  and move with it. The list's `hasLinkedInvoice` field, which the change made
  always false, is gone; nothing displayed it.
