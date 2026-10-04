# File-size allowances for #3660

Each file grows by exactly one line: the import of the shared captured-status
list from `src/lib/payment-transaction-status.ts` (#3606). That import replaces
status arrays the file had typed out by hand, so the growth is the price of
removing a duplicate (`INV-SSOT`), not new logic. Splitting either module is a
far larger change than this refactor, and there is no seam here to split along.

file: src/lib/booking-cancel.ts
lines: 2770
reason: the one added line is the import that replaces three hand-typed captured-status arrays with the shared list. Re-measured in place for #3653 on the same branch: a joiner's own cancel of a booking the group organiser paid for by card writes its organiser child refund debt inside the paid-cancel claim and runs it after commit, which has to sit in the claim it commits with; and (review of #3870) re-derives the frozen cancel figures from the final organiser refund and reports a debt the group cancel already owes as the group's. Re-measured once more at the #3630 compose: main's #3792 (member credit-ledger key in both cancel claims) landed in parallel.

file: src/lib/payment-reconciliation.ts
lines: 3077
reason: the one added line is the import that replaces two hand-typed captured-not-fully-refunded arrays with the shared list. Re-measured at the #3630 compose: main's #3792 member credit-ledger key in the settle landed in parallel.
