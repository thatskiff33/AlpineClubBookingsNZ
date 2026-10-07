# File-size allowances for #3854

The group settlement's booking-ledger lines are posted from the transactions
that already move the money, so each over-budget writer gains only its call
site; the posting itself lives in the new
`src/lib/booking-ledger-group-settlement-sync.ts`.

file: src/lib/group-settlement.ts
lines: 1654
reason: the children's ledger lines must post inside the settle's own claim
  transaction, under its lock(1) and lodge keys, beside the PAID flips; the
  growth is one import and a two-line call into the ledger module.

file: src/lib/group-cancel.ts
lines: 948
reason: the organiser cancel's per-child ledger lines must post inside its
  per-child claim transaction, and the plan's refund line inside the replay's
  mirror transaction; the growth is the frozen-plan copy the kept figure needs
  after a failed refund clears the live plan, and the replay's one call. The
  sync lens's F2 adds the child's payment re-read under the claim's lock(1),
  which the mirror and the kept figure both read, in that same transaction.
