- **An internet banking hold that has started being paid is no longer
  cancelled (#3643).** When a held booking's deadline passed, the payment job
  cancelled it as if nothing had been paid, even when the member had already
  paid part of the Xero invoice — the member lost their beds and the money went
  untracked. The job now reads the booking's invoices from Xero first. If any
  payment is recorded against them, the booking stays confirmed with its beds
  held, and admins get one "Internet banking hold needs attention" email naming
  the booking, the invoice, and what has been paid and what is still owing. The
  booking is marked paid once the rest arrives. Or it can be cancelled in the
  app: cancelling now records the part payment as money received, applies the
  cancellation policy to it as account credit, and clears only what the invoice
  still owes with a credit note reading "Unpaid balance cleared - booking
  cancelled". The cancel dialog shows that same credit before you confirm. An
  organisation's booking, or a payment Xero cannot give exactly, cannot be
  credited: an officer can still cancel it as unpaid, and the treasurer is
  emailed to settle the payment by hand. That cancel also puts one item with
  no amount in **Money to settle**; closing it with a note, once the payment is
  settled in Xero, stops the Xero repair tool listing the booking for review.
  If Xero later reports that invoice paid, the app credits and hands back
  nothing for it by itself: the item records the date and the invoice's cash,
  comes back onto the queue if it had been closed, and the club decides.
  A hold whose invoice cannot be read from Xero is kept, with one
  email, until seven days after its deadline, then released with a second
  email; if its check-in date comes first, the stay has started and it is left
  for the treasurer to reconcile by hand instead (#3663). A fully unpaid hold is released exactly as before. The
  Xero repair tool no longer offers to queue or retry a full clearing credit
  note for an invoice with a payment recorded against it; it asks for a person
  to review instead, and stops asking once nothing is owed: a booking paid in
  full before its cancel is not listed, and a rest you cleared by hand drops
  off once its failed operation is marked resolved - as does a clearing note
  refused because part of the booking was paid. A clearing note that was
  created but not allocated is allocated for its own amount, not the full
  booking. A cancelled organisation
  booking whose late payment became a hand-back task is shown as needing no
  clearing note.
