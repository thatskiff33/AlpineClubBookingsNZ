- **Taking a guest off a booking no longer fails when the club's own records
  cannot say what that guest paid (#3032).** Some older bookings — ones made
  before the system kept a price against each night, and ones created by
  approving a booking request — carry a total for a guest without a readable
  breakdown behind it. Until now a removal from such a booking was turned away
  with "the club needs to confirm the amount for this change before it can be
  saved", which left the member unable to do the one thing they were trying to do
  and gave the office no record that anything needed pricing.

  The removal now goes through. The guest comes off the booking straight away,
  and the refund or credit that removal earns is held as a pending item for the
  office to price from the booking's real history and confirm. Nothing is
  guessed: no card refund, no account credit, no invoice adjustment and no change
  to what the booking says it costs happens until a person confirms the figure.
  The pending item records what the club had on file for that guest's nights
  before the removal, because those records are deleted with the guest and could
  not otherwise be recovered.

  This matters most for a member who has been added to somebody else's booking
  and declined — or never answered, so their invitation lapsed. That removal must
  always be able to go ahead, and it can now do so without the club settling an
  amount it cannot stand behind. Retrying a removal that already went through
  raises no second pending item.

  Editing the dates or the party of a booking that is **already under way** is
  still turned away in the same situation, for a reason that has not gone away:
  that kind of edit rewrites every guest's nightly prices, and there is no honest
  figure to write for a night whose price was never recorded. The wording tells
  the member nothing has been changed, which remains true.
