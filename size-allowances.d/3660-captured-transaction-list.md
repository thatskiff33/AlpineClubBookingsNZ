# File-size allowances for #3660

Each file grows by exactly one line: the import of the shared captured-status
list from `src/lib/payment-transaction-status.ts` (#3606). That import replaces
status arrays the file had typed out by hand, so the growth is the price of
removing a duplicate (`INV-SSOT`), not new logic. Splitting either module is a
far larger change than this refactor, and there is no seam here to split along.

file: src/lib/booking-cancel.ts
lines: 2526
reason: the one added line is the import that replaces three hand-typed captured-status arrays with the shared list.

file: src/lib/payment-reconciliation.ts
lines: 3063
reason: the one added line is the import that replaces two hand-typed captured-not-fully-refunded arrays with the shared list.
