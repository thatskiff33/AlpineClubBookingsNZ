# File-size allowances for #4431

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 967
reason: the approver's account label is one cell on the existing credit-request
  row. A new component would only move that cell out of the table it belongs to.

file: src/lib/member-credit.ts
lines: 1143
reason: approval already claims the request and writes the credit in this
  function, under the member-credit lock. The grant-note enqueue has to stay
  in that same transaction, so the extra lines cannot move to another file.

file: src/lib/xero-operation-outbox.ts
lines: 3468
reason: the worker is a separate module. This file only gains the one dispatch
  branch that calls it, which has to sit in the existing scan.

file: src/lib/xero-operation-retry.ts
lines: 2127
reason: retry metadata for a credit-note create lives in the existing retry
  switch. The grant note is one more supported queue type there, not a second
  creator.
