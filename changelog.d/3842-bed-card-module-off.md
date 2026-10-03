- **The admin dashboard no longer shows a Bed Allocation card when the club has
  bed allocation switched off (#3841).** Before this, a club that doesn't use
  bed allocation still saw the card, and it counted every guest due in the next
  seven days as "awaiting a bed", a number that could never be cleared. Its link
  also led to a page that is closed while the module is off. The card now
  appears only when bed allocation is on, as the bookings list and the
  stuck-state checks already behave. Nothing changes for clubs that use bed
  allocation.
