- **The booking ledger now records the money that settles a booking (#3581).**
  Card payments, Internet Banking payments, cash
  recorded by an officer and card refunds each post a line — derived from the
  same payment rows the system's payment figures come from, wherever those
  rows are written. When a payment is undone — a mark-paid reversed, a refund that later
  fails — the line is reversed by a new one rather than edited. Nothing reads
  the ledger yet (#3584), so no figure anyone sees changes. Account credit and
  hand-back refunds follow in #3599.
