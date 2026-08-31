- **The Xero repair tool can now see a booking edit that an officer priced by
  hand (#3187).** When an edit's money cannot be worked out from the booking's
  own history, the change is saved and the amount is parked for an officer to
  confirm. Because the booking's own totals never move, the repair tool's
  "this change is missing its supplementary Xero invoice" check read a change of
  zero and skipped every one of those bookings — exactly the ones the review
  process creates. If such an invoice was missing or was billing less than the
  officer settled on, nothing found it.

  The tool now reads the settled amount from the reviews themselves, so a
  missing invoice is reported and its "queue it" action really queues one for
  the right total, and an invoice that went out short of the settled total is
  reported for a person to correct by hand. A booking with no review, and one
  whose review is already fully invoiced, are unchanged and report nothing.

  A repaired invoice is raised with the payment state the member is actually
  in: unpaid where the club is asking for the money by internet banking, held
  until the card clears where a card request is outstanding, and paid where the
  card has already taken at least the full amount. This part is new rather than
  a correction — the check could never reach one of these bookings before, so it
  never raised an invoice for one — and it matters because the underlying
  "raise an invoice" step assumes the card was taken first, which is true of an
  ordinary price change (unchanged, and still handled that way) and not of a
  reviewed one.

  Two cases are deliberately reported rather than repaired, because repairing
  them would state something untrue about money: where the card took less than
  the officer settled on, and where the card request could not be created and is
  still waiting to be retried. Both are listed for a person to finish by hand.

  If the member happens to pay while the sweep is running, the tool notices and
  sends the invoice rather than leaving it held for a payment that has already
  arrived — which would otherwise have sat unsent for a fortnight while the
  booking reported as "waiting for payment" instead of as a problem.
