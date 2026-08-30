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
  or account credit where nothing was ever captured. Where the booking has a Xero
  invoice, the matching credit note is raised too, so the club's accounts and its
  own records do not quietly drift apart. The member's booking history says which
  of those happened — a refund is only ever recorded as a refund once the card
  refund has actually issued, so nobody is told their money is back while it is
  still in the club's account.

  A card refund that cannot be sent — the card network is down, the payment has
  already been refunded elsewhere — says so on screen instead of reporting
  success, and the club is told it will be retried automatically. The retry is
  recorded before the card is ever contacted, so even a server restart mid-refund
  cannot lose it, and the retry can only ever complete the same refund rather
  than send a second one.

  An amount larger than the card payment can give back is refused before anything
  is closed, so the review stays open and can be priced again — rather than being
  marked settled with nothing actually moved.

  Two admins closing the same review at the same moment produce exactly one
  payment, and a retry of the original booking change reopens nothing. Both are
  now proven against a real database rather than argued: the test forces the
  dangerous timing rather than hoping for it, by holding the contended lock open
  until both attempts are queued behind it.

  Where the money cannot be settled automatically — the rare case where the
  booking change it belongs to has already issued credit of its own — nothing is
  closed and the club is told plainly to hand the amount back another way and
  record what it paid on the review before closing it. The note is what the
  record then rests on: a closed review never claims this system moved money it
  did not move.

- **A booking cannot be changed again in a way that affects its price while the
  club is still working out the money for the last change (#3032).** Otherwise
  the second change would be priced from an amount nobody has settled, and that
  guess would be written into the booking's history for the change after it to
  read back. The refusal says the booking is unchanged and to try again once the
  review is finished.

  The price preview refuses on exactly the same terms, so the member is never
  shown a figure the save is going to reject.

  Deliberately narrow: correcting a guest's name, choosing how to use account
  credit, and an admin shifting the stay dates without repricing all still work
  normally, because none of them reads the booking's stored money. So does a
  member coming off a booking they never consented to be on — that must always be
  possible, so it goes ahead rather than the member being trapped on the booking
  until somebody prices an unrelated question.
