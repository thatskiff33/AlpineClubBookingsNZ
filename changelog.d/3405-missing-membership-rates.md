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
  the one an ordinary public booking hits first. The Fees page and the checklist
  now read one rule, so they agree about which types owe a rate, which seasons
  still matter, and what today's date is at the club.

  **A second silent gap goes with it.** Nothing you can do to the built-in
  **Non-Member** or **Full** membership type on the Membership types page stops
  it pricing — non-member guests still price from the Non-Member rates, and a
  member the system cannot otherwise place, or a guest recognised as another
  lodge's member, still prices from the Full rates. Archive one, or change its
  booking behaviour, and it used to drop out of the rate grid, so nobody could
  set those rates and nothing warned they were missing, while bookings that
  needed them were still being refused. Both types now stay in the grid and in
  the warning whatever you do to them — and, just as important, a season save,
  a Xero hut-fee item code and a configuration bundle all still accept their
  rates, so following the warning actually works. A club's own retired
  membership type is unaffected: it is left alone, as before.

  Nothing is flagged that an officer cannot act on, or should not act on. A
  closed season that has already ended is left alone. A membership type that
  prices from the Non-Member rates, or one that cannot book the lodge at all, is
  never flagged, because a rate set for it would never be read. An age group a
  club does not run is never asked for.

  **Saving a season no longer fills the blanks in with $0.00.** Every empty rate
  box used to be saved as a rate of zero, so an officer who opened the season the
  warning named — to fix it, to change the dates, or for no reason at all — wrote
  a real $0.00 nightly rate into every blank box. The warning then disappeared,
  because the rates now existed, and those guests were charged nothing instead of
  being refused. An empty box now means no rate, exactly as the flat whole-lodge
  rate box beside it always has. A rate somebody deliberately types as **0.00**
  is kept and is now shown as `0.00` in the box rather than looking empty, and
  emptying every box is refused with a message rather than saved.

  Two display corrections go with it. Where a membership type is priced by a
  single flat all-ages rate, the season's rate table showed "Not set" against
  every age group; it now shows that amount, marked as the flat rate, so the
  table says what the booking engine actually charges. And a season whose last
  night is today stays in the setup checklist all day, rather than dropping out
  of it from lunchtime onwards while the Fees page still listed it.
