# File-size allowance for #4858 (the superseded runner's hold)

file: src/lib/payment-recovery.ts
lines: 3617
reason: one call and its one-line comment in
  `processRefundSupersededPaymentOperation`, between its ledger sizing read and
  its first provider request. The hold itself lives in
  `card-refund-resend-preflight.ts` beside the outside-app hold it mirrors; only
  the call has to sit here, because its order after the sizing read is what
  makes every refund the size counted one the hold checks.
