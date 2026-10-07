- **The booking money ledger's table exists, and the first lines are posted
  (#3580, programme #3527 stage 4 of 5, child C1 of 7).** `BookingLedgerLine`
  records a booking's money as append-only posted lines — charge, settlement
  or adjustment, each with a sign, a quantity, a unit price and the event that
  anchored it — so that a balance can be worked out from the lines instead of
  kept in columns that must be held in agreement. Confirming a booking now
  posts its charge lines inside the same transaction that takes the money.
  **Nothing reads them yet**: every screen, email, report and Xero document
  still reads today's figures, and will until the reads move (#3584). A line
  is never updated or deleted; one module writes the table, three database
  constraints hold the shape, and a census fails a second writer.
