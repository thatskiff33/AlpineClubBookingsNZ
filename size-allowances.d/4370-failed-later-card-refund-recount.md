# File-size allowances for #4370

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1171
reason: the refunded-total recount has to take failed-later card refunds off
  in the one sum it rebuilds, before its clamp and floors, and read them after
  the payment rows its claim is keyed on. The reader lives in
  `failed-card-refund-recount.ts`; what stays here is its import, one element
  of the existing read and one term of the sum. Splitting the recount out of
  this file is a refactor of its own.

function: src/lib/xero-inbound/credit-note-repairs.ts#repairRefundedPaymentBusinessState
lines: 427
reason: the read must sit in the same Promise.all as the recount's other
  inputs, after the payment rows and inside the compare-and-set claim (#3979),
  and the subtraction must be a term of the raw total ahead of the floors; the
  two added lines are that element and the comment naming the ordering.
