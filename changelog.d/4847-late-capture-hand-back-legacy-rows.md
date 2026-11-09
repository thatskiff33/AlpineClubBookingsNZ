- **An older late card payment item can no longer be marked paid back by hand
  after Stripe already refunded it (#4843).** Items about a card payment taken
  after its booking was deleted, raised before 19 August 2026, skipped the
  check that refuses a hand-back once the payment was refunded, so the booking
  could show more returned than the member got. They now get the same check
  as newer items; an item that was already refunded stays open to be dismissed
  with a note.
