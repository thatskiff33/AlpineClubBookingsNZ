# File-size allowances for #3292

These five existing writers were already over budget. Their small growth is the
pair-row serialization step or the stable database-conflict decoder at the
transaction boundary that owns the relationship write. Moving those lines to a
new module would hide the reviewed lock order or split error semantics from the
operation whose transaction must roll back.

file: src/app/api/admin/members/[id]/dependents/link/route.ts
lines: 469
reason: the route must take the pair row after its lifecycle and partner locks,
  and decode a trigger race before the existing logger can expose the raw error.

file: src/lib/admin-family-group-requests-service.ts
lines: 1710
reason: the request approval transaction owns both the under-lock relationship
  re-read and the clean 409 response when the database backstop wins the race.

file: src/lib/member-merge.ts
lines: 2898
reason: merge must lock and compare the complete prospective pair topology in
  its established multi-tier transaction before any relation move is applied.

file: src/lib/member-partner-link.ts
lines: 1570
reason: one shared lock seam covers every partner lifecycle writer and must keep
  its advisory-to-pair-row ordering visible beside the service transactions.

file: src/lib/nomination.ts
lines: 2612
reason: application approval pre-derives and locks every prospective mapped pair
  inside its atomic transaction, then maps a database race to the same clean 409.
