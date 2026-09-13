- **The Fees page now tells you when a season cannot price every guest (#2933).**
  Setting up hut fees, a season that is missing a required nightly rate is
  flagged before a booking reaches it: a count above the season list, a **Missing
  rates** badge on the season, and a panel inside it naming each membership type
  and the age tiers it has no rate for. It is a warning and not a price — nothing
  is charged at zero, no other membership type's rate is used instead, and a
  booking that needs a missing rate is still refused rather than guessed at.

  The commonest cause is a membership type added after the seasons were created:
  every existing season then has no rate for it, and until now the only sign was
  the word "Not set" in one cell of a grid, which says nothing about a booking
  being refused. The only place the club was actually told was the setup
  checklist, which most clubs open once at installation.

  **One kind of missing rate was not being reported at all.** The setup checklist
  asked only about types that price at the member rate, so a season missing its
  **Non-Member** rates raised no warning anywhere — and the non-member rate is
  the one an ordinary public booking hits first. Both surfaces now use the same
  rule, so they cannot disagree.

  Nothing is flagged that an officer cannot act on, or should not act on. A
  closed season that has already ended is left alone. A membership type that
  prices from the Non-Member rates, or one that cannot book the lodge at all, is
  never flagged, because a rate set for it would never be read. An age group a
  club does not run is never asked for.

  One long-standing display error goes with it: where a membership type is priced
  by a single flat all-ages rate, the season's rate table used to show "Not set"
  against every age group, even though that flat rate is exactly what the club
  charges them. It now shows the amount, marked as the flat rate.
