# File-size allowances for #3599 — account-credit and hand-back lines

Two already-over-budget files grow by one call per credit-row write, because
credit rows have no chokepoint: each writer must post the booking's line in
its own transaction, and a census (`booking-ledger-credit-writers.test.ts`)
fails a write with no call after it. The work itself was split rather than
allowed for — the planner (`booking-ledger-credit-posting.ts`), the sync
(`booking-ledger-credit-sync.ts`) and the hand-back poster
(`booking-ledger-hand-back.ts`) are new modules inside their own budgets.
`invoice-paid-effects.ts`'s two calls are counted in #3581's entry, which this
stack re-measured (one path, one allowance, while both are measured against
`main` together).

file: src/lib/member-credit.ts
lines: 1013
reason: one sync call after each of the five booking-linked credit writes,
  plus its import. Moving the writes out of the module that owns the credit
  ledger's lock and its idempotency rules would split one invariant across
  two files.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1005
reason: one sync call after each of the two applied-credit rows the Xero
  allocation repair appends, plus its import.
