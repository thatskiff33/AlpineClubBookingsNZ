# File-size allowances for #4215

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1176
reason: the refunded-total recount has to add a refund request's paid-back
  cash in the one sum it rebuilds, and read it after the payment row its claim
  is keyed on. The reader itself lives in `refund-request-paid-back.ts`; what
  stays here is the call inside the existing read and one term of the sum, and
  splitting the recount out of this file is a refactor of its own.
