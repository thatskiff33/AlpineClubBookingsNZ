- **A credit note's allocation repaired by an older version of the repair tool
  now counts straight away in a bank transfer's refund total (#4786).** Since
  #4767 a cancelled booking's invoice-clearing credit note, or a booking edit's
  credit note, can be closed when an older version of the repair tool had
  already made one of its allocations. Until Xero's next update for that note
  arrived, the refunded total of a bank-transfer payment, and the invoice
  corrections counted when such a payment is kept at its stored figure, did
  not see that allocation yet. They now count it, once.

  The audit of bank-transfer holds whose invoice was left open already counted
  it. It now counts only the allocation records a credit note's own allocation
  or that older repair writes, and for each note and invoice only one: the
  latest of the note's own records, or the older repair's where there is none.
  So a note's allocation is never added twice. Nothing changes in Xero,
  and no stored record is rewritten.
