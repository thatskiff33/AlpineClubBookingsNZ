# File-size allowance for #3595 — confirmation posts once per booking

One already-over-budget file grows: `src/lib/payment-reconciliation.ts`, by 22
lines. Two statements and their reasons: the per-booking fence that asks
whether this booking is already confirmed on the ledger before planning, and
the warning that reports a write which inserted fewer rows than it planned.
Both questions live in new modules (`booking-ledger-read.ts`,
`booking-ledger-posting-keys.ts`), each inside its own budget; the settle
gains the call and the comment that says why the fence belongs here — it is
the only place holding the global `lock(1)` that makes the check race-free.

file: src/lib/payment-reconciliation.ts
lines: 3047
reason: the per-booking confirmation fence, asked under the settle's own
  lock(1), and the shortfall warning — plus the comment explaining why a key
  per night was not enough (#3595's review); and #3581's two explicit ledger
  calls for the manual settle and its reversal, which bypass the chokepoint. The file is a known split
  candidate; splitting the single settle door inside a ledger fix would make
  both unreviewable.

Re-measured by #3581 (stacked on this pull request), per this directory's
README: one path takes one allowance while both changes are measured against
`main` together, so #3581's two explicit settle calls — the manual mark-paid
settle and its reversal, each with the comment saying why it bypasses the
chokepoint — are counted here rather than in a second entry. 3031 lines is
this pull request's own figure; 3047 covers both.
