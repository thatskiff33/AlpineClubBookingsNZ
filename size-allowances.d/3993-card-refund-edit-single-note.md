# File-size allowances for #3993

file: src/lib/xero-booking-repair-classify.ts
lines: 2387
reason: the card-refund silence and the paid-off refusal have to sit in the
  edit-note arm, beside the missing-note and allocation decisions they guard.
  The predicate and the remedy wording live in xero-modification-note-refusal.ts.
  Splitting the per-booking classifier is its own job, as the file's header says.

file: src/lib/xero-operation-retry.ts
lines: 2111
reason: the operations screen refuses a replay of an edit note the invoice
  cannot take from the same meta both the PARTIAL and FAILED credit-note
  branches already return. The check is two calls of one predicate. Lifting
  the retry meta out of this module is a refactor of its own.
