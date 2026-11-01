- **A card payment for released credit is no longer recorded twice in Xero
  (#4494).** Where a booking's extra invoice for the balance its first invoice
  missed was raised after the member paid by card for credit used in Xero, the
  extra invoice could record that same card payment as its own, beside the
  payment the credit-release sweep records on the booking's invoice, overstating
  the money received. The extra invoice now never pays itself from that money,
  and is raised unpaid when nothing else could pay it. An extra invoice queued
  before this release records no payment when it is sent, retried or repaired
  if what it would take, together with the credit-release money, is more than
  the card took. The sweep waits for such an invoice that has not been sent and
  still can be, and holds, telling an officer, where it may already have
  recorded part of the card payment or will not be sent on its own. Members see
  no change.
