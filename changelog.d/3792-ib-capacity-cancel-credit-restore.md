- **A late bank transfer on a booking that lost its place now returns the
  account credit it used (#3792).** When an internet banking payment arrives
  after the lodge has filled, the booking is cancelled and the transfer is
  held as account credit. Any account credit the member had put towards that
  booking was not given back. It is now returned in full, as it already was
  when a card payment meets a full lodge. For example, a booking paid with $80
  of credit and a $120 transfer now leaves the member with $200 of credit
  instead of $120. The booking's history records the returned credit.
