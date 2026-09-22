# File-size allowance for #3580 — the booking ledger's first posting site

One already-over-budget file grows: `src/lib/payment-reconciliation.ts`, by 45
lines. Most of them are prose and a guard: the comment explaining why a
posting failure must not be able to fail a settle that has already taken the
member's money, and the `try`/`catch` that makes that true rather than merely
asserted — with the warning that records a plan which does not add up, so the
gap is reported rather than lost. The posting itself is a call and its
arguments.

**The work itself was split rather than allowed for**, which is why this list
has one entry instead of four. Everything the posting needs lives in new
modules, each inside its own budget: the planner that turns a confirmed
booking into charge lines (`booking-ledger-confirmation-posting.ts`), the one
door that writes the table (`booking-ledger-write.ts`), and the pure module
that derives a balance from lines (`booking-ledger-balance.ts`). Nothing was
added to the settle body except the call and its reasoning.

The alternative — posting from a caller outside the transaction — was rejected
on the rule the whole design rests on: a line records something that happened,
so it is written inside the transaction that made it happen. That places the
call here and nowhere else.

file: src/lib/payment-reconciliation.ts
lines: 2993
reason: the ledger posting call at the PAID claim, the guard that keeps a
  posting failure from rolling back a captured settle, the warning that
  records an unreconciled plan, and the comment that says why each is here. This
  file is a known split candidate of its own — it is the single settle door
  for every card and cash route — and splitting it inside a schema change
  would make both unreviewable.
