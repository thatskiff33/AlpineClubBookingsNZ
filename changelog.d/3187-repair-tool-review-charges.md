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

  A repaired invoice is also raised with the payment state the member is
  actually in: unpaid where the club is asking for the money by internet
  banking, held until the card clears where a card request is outstanding, and
  paid where it has already been captured. Previously the repair action would
  have recorded a card payment against every invoice it created, including ones
  nobody had paid.
