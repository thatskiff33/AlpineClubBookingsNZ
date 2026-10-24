- **A second refund handed back on a bank-transfer booking now gets its own
  Xero credit note (#4287).** When a bank-transfer payment already had its
  refund credit note in Xero, a cancellation refund the treasurer handed back
  later was counted under that first note and Xero never got a note for it, so
  Xero showed less credit than the club had paid back. Each such refund now
  gets a credit note of its own, for exactly that refund's amount. The same
  applies to the first refund handed back on a bank-transfer payment that was
  also partly paid by card, where the first note's amount could otherwise come
  out wrong. If Xero later voids such a note and the nightly check takes the
  refund back off the booking, that refund stops counting towards any later
  credit note on the payment. When the treasurer then re-confirms that refund
  with a new credit note, it counts again, once, so a later card refund's credit
  note is no longer raised short (#4315).

  Nothing is raised for refunds handed back before this release: the
  read-only query in the deploy notes still lists those payments so their
  notes can be raised by hand. A refund appeal's card part, a Stripe dashboard
  refund and a late card capture's refund on a bank-transfer payment get their
  own notes too, from #4312. A cancellation never refunds a bank-transfer
  payment to a card (it gives account credit), so no card refund is left
  sharing the first note.

  While the previous version still runs during an upgrade, or after rolling
  back, its Xero worker cannot raise these new credit notes and leaves them
  failed; retry them from the Xero failed-operations panel once this version
  is running alone.
