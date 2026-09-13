- **Choosing not to email a member when you book for them now also stops Xero
  emailing them the invoice (#2929).** When an officer books on somebody's
  behalf and picks **Create without emailing**, the club's own confirmation was
  held back but Xero could still email the member an invoice moments later on
  the Internet Banking path — which is the opposite of what the officer had just
  asked for.

  That one choice now covers that one invoice email too. The invoice is still
  raised in Xero exactly as before, is still authorised, and the member still
  owes it; only the emailing is held back. It appears on the booking among the
  withheld messages, which say plainly that the invoice exists and that the way
  to send it, if you decide the member should have it, is from Xero — nothing in
  the club's system re-sends it.

  It is a one-off for that booking creation and nothing more. It does not turn
  on the booking's **No emails** switch, does not change the member's address in
  Xero, and does not hold back any later reminder, change or cancellation
  email. Bookings made any other way — a member booking for themselves, a
  waitlist confirmation, a payment switched to Internet Banking, an officer
  repairing a missing invoice — are completely unchanged.

  Two things follow that are worth knowing. The withheld-messages banner can now
  appear on a booking whose **No emails** switch was never used, so read it as
  "these were deliberately held back" rather than as evidence the switch is on.
  And the instruction is recorded on the booking's invoice job rather than held
  in memory, so if that job is retried hours or days later it still knows the
  email was withheld on purpose instead of sending it because the original
  choice had been forgotten.
