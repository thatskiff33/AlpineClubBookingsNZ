- **A booking change whose money the club has to work out by hand now gets that
  money moved properly once an admin confirms the figure, and can only move it
  once (#3032).** When a stay or guest change is valid but the exact refund or
  credit cannot be read from the booking's own stored price history, the change
  is saved and the money is held as an explicit review for the club to price.
  Until now, closing that review recorded the admin's decision and, in the
  commonest case, moved nothing at all.

  Confirming the amount now sends it down whichever of the club's existing
  settlement routes fits the booking: a card refund where the booking was paid by
  card, a ledger entry where the club hands the money back by internet banking,
  or account credit where nothing was ever captured. The member's booking history
  says which of those happened — a refund is only ever recorded as a refund once
  the card refund has actually issued, so nobody is told their money is back
  while it is still in the club's account.

  Two admins closing the same review at the same moment produce exactly one
  payment, and a retry of the original booking change reopens nothing. Both are
  now proven against a real database rather than argued: the test forces the
  dangerous timing rather than hoping for it, by holding the contended lock open
  until both attempts are queued behind it.

  Where the money cannot be settled automatically — the rare case where the
  booking change it belongs to has already issued credit of its own — the club is
  told plainly what to do instead, and the review stays open holding the
  question, rather than closing as if it had been paid.

- **A booking cannot be changed again in a way that affects its price while the
  club is still working out the money for the last change (#3032).** Otherwise
  the second change would be priced from an amount nobody has settled, and that
  guess would be written into the booking's history for the change after it to
  read back. The refusal says the booking is unchanged and to try again once the
  review is finished.

  Deliberately narrow: correcting a guest's name, choosing how to use account
  credit, and an admin shifting the stay dates without repricing all still work
  normally, because none of them reads the booking's stored money. So does a
  member coming off a booking they never consented to be on — that must always be
  possible, so it goes ahead and the club is left with a second amount to price
  rather than the member being trapped on the booking.
