# File-size allowances for the refund-note repair's pointer (#4279)

The adoption rule and its transaction live in the new
`src/lib/xero-refund-note-adoption.ts`. What is left in the completion writer
is the optional field on its completion type, the one call that adopts the note
on a won claim, and the choice of that transaction: each belongs beside the
claim and link writes it is ordered between.

file: src/lib/xero-sync.ts
lines: 1217
reason: the pointer adoption must run inside completeXeroSyncOperation's own
  transaction, after its guarded claim and before its link writes; moving that
  sequence out would split the claim from the writes it orders, in a file
  already over its limit before this change.
