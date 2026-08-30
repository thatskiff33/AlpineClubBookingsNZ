- **A member whose booking change saved is now told the amount is still being
  worked out, instead of hearing nothing about it (#3033).** When a change to a
  booking can be made but the refund or credit for it cannot be read from the
  booking's own stored price history, the club holds the money for review. Until
  now that state was invisible to the member: their booking page said the stay
  was confirmed and there was nothing more to do, the "Booking Modified" email
  arrived with an empty money section, and the My Bookings row showed the new
  total with no hint that an adjustment was still to come.

  The booking page now confirms the change, says the club is working the amount
  out, and states plainly that nothing has been refunded or charged for it yet.
  No figure of any kind is shown — not a zero, not an estimate, not the new
  total — and nothing internal or fault-finding is said. The My Bookings row
  keeps the total and marks it as being checked rather than hiding or
  "correcting" it, and the modification email carries the same sentence, ahead
  of any additional payment the same change may also have created.

  The wording is editable under **Admin → Bookings setup → Booking messages**
  ("Adjustment being reviewed"), so a club can soften it without a release. Do
  not put an amount in it: the whole point of the message is that the amount is
  not yet known.

- **Finance staff can now see why a review exists and what to decide from
  (#3033).** The settlement queue on **Admin → Payments** used to tell an
  administrator that every row in it "was paid in cash or by a bank transfer
  that never reached Xero" — which is untrue of a booking-change review, where
  the booking is live and nothing was cancelled. Each sentence is now shown only
  over the rows it actually describes.

  A review row carries the evidence recorded when the change was applied: why
  the exact amount could not be established, which nights were given back and
  which added, the stored total for that guest, and whatever per-night prices
  were on file — with "no stored price" kept distinct from a genuine $0.00,
  because those mean different things. Alongside it is a link to the booking's
  own payment and rate history, offered only to administrators who may open a
  booking; anyone else sees the booking's identifier to quote instead. A booking
  with a review waiting also shows a warning on its own Admin tools card, with a
  link to the queue.

  Dismissing a review now reads as a finding — "somebody looked and nothing is
  owed" — rather than as the refusal wording used for a cash hand-back, and the
  button that would record an adjustment is disabled until an amount has been
  confirmed, instead of failing when pressed.
