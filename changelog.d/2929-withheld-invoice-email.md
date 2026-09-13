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
  waitlist confirmation, a payment switched to Internet Banking — are completely
  unchanged.

  **One case where the choice deliberately does not reach**, and it is worth
  knowing because it looks as though it should. A booking that includes
  non-member guests can be held as **PENDING** rather than confirmed, and its
  invoice is not raised at creation at all — it is raised days later, when the
  hold resolves and the booking is confirmed either by the overnight job or by
  an officer using **Confirm pending guests**. The member is emailed the ordinary
  booking confirmation at that moment regardless of what was chosen at creation,
  so withholding only the invoice email there would be an odd half-silence. The
  officer using Confirm pending guests is asked about emailing again at that
  point, which is the right place to decide it.

  Three things follow that are worth knowing. The withheld-messages banner can
  now appear on a booking whose **No emails** switch was never used, so read it
  as "these were deliberately held back" rather than as evidence the switch is
  on; it does not say which decision held each one back, and the remedy is the
  same either way. The instruction is recorded on the booking's invoice job
  rather than held in memory, so if that job is retried hours or days later it
  still knows the email was withheld on purpose instead of sending it because
  the original choice had been forgotten. And if that job **failed** and an
  officer later re-queues it — from the missing-invoices sweep, a force sync, or
  the Xero repair pass — the new job picks the original choice back up rather
  than starting fresh and emailing the member after all.
