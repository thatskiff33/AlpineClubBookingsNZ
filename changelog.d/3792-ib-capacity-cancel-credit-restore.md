- **A late bank transfer on a booking that lost its place now returns the
  account credit it used (#3792).** When an internet banking payment arrives
  after the lodge has filled, the booking is cancelled and the transfer is
  held as account credit. Any account credit the member had put towards that
  booking was not given back. It is now returned in full, as it already was
  when a card payment meets a full lodge. For example, a booking paid with $80
  of credit and a $120 transfer now leaves the member with $200 of credit
  instead of $120. The booking's history records the returned credit, and the
  cancellation email and the admin alert both state the amount returned. The
  email now says the credit came back in full, not "per the cancellation
  policy", for a booking cancelled for capacity or because an internet banking
  hold expired.
- **Credit returned on a cancelled booking stays put when Xero changes later
  (#3792).** If someone removes that credit's allocation from the invoice in
  Xero after the booking was cancelled, the next sync no longer adds the same
  credit to the member's balance a second time; if someone raises it, the sync
  no longer takes it off them. It leaves the balance as it is, alerts the
  treasurer to check the credit note in Xero, and records the refusal in the
  audit log (the Xero category, which nobody gains or loses access to), so it
  is there even when the alert email is held back. This covers
  every way a cancellation returns applied credit. A Xero change on a booking
  that is still live works as before.
