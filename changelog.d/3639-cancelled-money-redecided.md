- **A cancelled booking's money is no longer re-decided later (#3639).** A
  delayed Stripe "payment succeeded" notice for a booking that was paid and
  then cancelled no longer refunds money the cancellation policy kept (a
  0%-tier cancellation lost the whole payment this way), and no longer
  rewrites a refunded payment back to paid; it is acknowledged and nothing
  moves, and an entry in the audit log says why. The same holds for a payment
  for a change to the booking, and for a repeat of a notice already refunded.
  A genuine late capture is still refunded, including after a crash and
  retry — or, if the club chooses, held for a treasurer: a new setting on the
  Cancellation policy page, **Payments that arrive after a booking was
  cancelled**, can be switched from "Refund them automatically" (the default)
  to "A treasurer approves each refund", which puts each one in the Payments
  refund tasks to refund to the card or keep. It covers the booking's own
  payment and a payment for a change to it, and changing it needs finance edit
  access. The booking-versus-Xero repair tool no longer raises a clearing
  credit note against the invoice of a cancelled booking paid by bank
  transfer, or of one whose payment already carries a refund or
  account-credit note (such as an internet-banking hold released before
  #3535). Both follow one rule: what did the cancellation already settle?
