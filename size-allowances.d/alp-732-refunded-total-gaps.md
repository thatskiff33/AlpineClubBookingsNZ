# File-size allowances for the refunded-total gaps (#5289)

The Payment-first completion's logic lives in the new
`src/lib/xero-payment-first-completion.ts` and the note-allocation role in a
new leaf. What is left in the completion writer is the flag that says its links
were written (set where each of its two link loops runs) and the one routing
line that sends a completion carrying a note's own allocation, as well as a
refund note's pointer, into that transaction.

file: src/lib/xero-sync.ts
lines: 1223
reason: the flag must be set inside completeXeroSyncOperation's own claim and
  link writes, the only place that knows whether a refused claim still recorded
  its links; moving it out would split the claim from the writes it orders, in
  a file already over its limit before this change.
