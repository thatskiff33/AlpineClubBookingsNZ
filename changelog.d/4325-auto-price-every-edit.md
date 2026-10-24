- **Every booking change is now priced automatically, and none is sent to an
  officer to work out (#4317).** Until now, a change to a booking whose records
  did not say clearly what each night was sold for — usually an older booking,
  or one created from a public request — was saved, but its money was held in
  **Refunds & Adjustments** for an officer to price by hand. The booking's total
  stayed frozen meanwhile, the member was told the club was checking, and any
  further price change to the booking was refused until the review was settled.

  Every change is now priced the moment it is saved, on every route: the
  booking edit, a date change, adding a guest, taking a guest off, a change
  during the stay, and the re-price when an invited guest accepts. Nights a
  guest keeps keep their price; nights given back are credited at what they
  were sold for; taking a guest off credits everything stored for that guest;
  nights added are charged at today's prices; and the club's normal change fee
  applies. Where the records do not say what each night sold for on its own, the
  guest's stored total is shared across their nights — nights with a recorded
  price keep it and the rest is split evenly — so the credits always add up to
  exactly what the guest was charged. The quote on **Edit Booking** is exactly
  what saving charges or credits. A booking whose total an older held change
  left out of step with its guests keeps that difference: a new change moves
  the total only by what it changes itself, never settling the held money, and
  is refused if that would take the total below zero. During the stay a promo
  code is kept as it was, even one that has since expired, and where the change
  leaves less to pay than the code took off, its discount shrinks to what is
  left, so a shorter stay is never charged more.
  Closing an older review now recalculates the booking's total from its guests,
  and a correction to a finished stay is charged on the removed nights' values
  rather than refused when a night has no recorded price.

  The booking ledger posts an edit only where the nights' recorded lines
  already match those values; an edit to a booking whose lines do not posts
  nothing and is counted as a gap until a later release re-posts them. Run
  `pnpm run booking-money:census` before deploying to see how many bookings
  that is (`ledgerNightValues`).

  A member declining an invitation on a paid booking now needs the owner or
  the club to choose between a refund and account credit on every booking,
  including ones whose money used to be held for review. An other-club member
  rate can now be set on any booking that could not be re-rated before. A
  guest whose stored total is below zero, which the system cannot store, would
  refuse the change.

  Reviews already open in **Refunds & Adjustments** stay there and are settled
  as before; while one is open, its booking still refuses a further price
  change. A later release settles the remaining reviews and retires those
  screens. This release must not be deployed until the night-price backfill has
  been run on production.
