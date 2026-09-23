- **The booking ledger now records the money that settles a booking (#3581,
  programme #3527 stage 4, child C2).** Card payments, bank transfers, cash
  recorded by an officer and card refunds each post a line — derived from the
  same payment rows, at the same place, as the payment figures the system
  already keeps, so every payment path is covered and a new one cannot be
  missed. When a payment is undone — a mark-paid reversed, a refund that later
  fails — the line is reversed by a new one rather than edited. Nothing reads
  the ledger yet (#3584), so no figure anyone sees changes. Account credit and
  hand-back refunds follow in #3599.
