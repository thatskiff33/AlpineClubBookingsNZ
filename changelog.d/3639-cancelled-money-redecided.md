- **A cancelled booking's money is no longer re-decided later (#3639).** A
  delayed Stripe "payment succeeded" notice for a booking that was paid and
  then cancelled no longer refunds money the cancellation policy kept (a
  0%-tier cancellation lost the whole payment this way), and no longer
  rewrites a refunded payment back to paid; it is acknowledged and nothing
  moves. A genuine late capture is still refunded, including after a crash
  and retry. The booking-versus-Xero repair tool no longer raises a clearing
  credit note against the invoice of a cancelled booking paid by bank
  transfer, or of one whose payment already carries a refund or
  account-credit note (such as an internet-banking hold released before
  #3535). Both follow one rule: what did the cancellation already settle?
