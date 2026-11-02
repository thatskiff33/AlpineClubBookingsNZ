# File-size allowance for #4656 (refund-note record gaps)

file: src/lib/payment-transactions.ts
lines: 1751
reason: one constant and its comment, `PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS`,
  the transaction budget of a short writer that waits on a `Payment` row. It
  sits directly above `lockPaymentForRefundedTotal`, the one statement that
  takes that row, because the budget is sized to that lock's holders (30s
  transactions) and its two users - the inbound recount's claim and the
  refund-note create's record - import both together. A module of its own
  holding one constant would separate the budget from the lock it is about.
