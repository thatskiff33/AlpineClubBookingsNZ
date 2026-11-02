# File-size allowances for #4656 (refund-note record gaps)

file: src/lib/payment-transactions.ts
lines: 1751
reason: one constant and its comment, `PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS`,
  the transaction budget of a short writer that waits on a `Payment` row. It
  sits directly above `lockPaymentForRefundedTotal`, the one statement that
  takes that row, because the budget is sized to that lock's holders (30s
  transactions) and its two users - the inbound recount's claim and the
  refund-note create's record - import both together. A module of its own
  holding one constant would separate the budget from the lock it is about.

file: src/lib/xero-credit-notes.ts
lines: 1383
reason: `createXeroCreditNote` throws `RefundNoteNotRecordedError` when Xero
  made a note its record did not write, and its own catch lets that error past
  its failure path. Both sit at the record call and the catch they change; a
  helper elsewhere would hide which path skips the failure write.

file: src/lib/xero-operation-outbox.ts
lines: 3462
reason: the worker's catch must treat a refund note made but not recorded as
  skipped before its generic failure path runs. That ordering is the fix: the
  branch has to sit at the top of the one catch every queue type shares.
