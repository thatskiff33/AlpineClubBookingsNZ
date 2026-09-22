# File-size allowance for #3580 — the booking ledger's first posting site

One already-over-budget file grows: `src/lib/payment-reconciliation.ts`, by 61
lines. Most of them are prose, and the prose is the point: it explains why
BUILDING the ledger rows is wrapped and WRITING them is not — a refused
statement has already aborted the transaction, so a `catch` around the write
would be a claim the runtime cannot keep, while a bad plan throws before
anything reaches Postgres and is genuinely safe to swallow. Review of #3580
found the first cut had wrapped both and said so in a comment; the comment was
wrong, and the fix is the split plus the reasoning that keeps the next reader
from undoing it. The posting itself is two calls.

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
lines: 3009
reason: the ledger posting at the PAID claim — the pure build, guarded; the
  write, deliberately not; the warning that records an unreconciled plan; and
  the comment that says why each half is treated differently, which is the
  finding review caught. This
  file is a known split candidate of its own — it is the single settle door
  for every card and cash route — and splitting it inside a schema change
  would make both unreviewable.
