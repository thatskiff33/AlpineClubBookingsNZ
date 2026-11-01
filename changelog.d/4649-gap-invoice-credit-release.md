- **A card payment for released credit is no longer recorded twice in Xero
  (#4494).** Where a booking's extra invoice for the balance its first invoice
  missed was raised after the member paid by card for credit used in Xero, the
  extra invoice could record that same card payment as its own, beside the
  payment the credit-release sweep records on the booking's invoice, overstating
  the money received. The extra invoice now never pays itself from that money,
  and is raised unpaid when nothing else could pay it. An extra invoice queued
  before this release is raised unpaid when it is sent, and the sweep holds,
  telling an officer, where such an invoice already recorded part of the card
  payment. Members see no change.
