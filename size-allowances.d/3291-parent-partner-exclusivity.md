# File-size allowances for epic #3271 (#3291 and #3292)

These seven files were already over their budgets. Across the atomic epic, each
remains the established writer or selector for its workflow; the growth is the
application guard, authoritative re-read, pair-row serialization, or stable
database refusal at that exact transaction boundary. Moving those orchestration
lines elsewhere would split a transaction across modules without removing the
existing file's responsibility.

file: src/app/api/admin/members/[id]/dependents/link/route.ts
lines: 469
reason: the route acquires lifecycle, partner, and canonical pair-row locks at
  its transaction boundary, then decodes trigger races before logging the error.

file: src/lib/admin-family-group-requests-service.ts
lines: 1710
reason: the family-request transaction re-reads its requester and child after all
  lock tiers and owns the clean 409 if the database backstop wins the race.

file: src/lib/admin-members-service.ts
lines: 1756
reason: six selector lines consume the shared parent and partner predicates in
  the established member-list query; a new wrapper would only obscure those
  composable Prisma conditions.

file: src/lib/member-application-mapping.ts
lines: 1178
reason: the mapping preview already owns every blocker attached to a selected
  existing record; the added shared partner fact belongs beside those outcomes
  so preview-token hashing and operator feedback cannot drift.

file: src/lib/member-merge.ts
lines: 2898
reason: merge owns its ordered multi-tier transaction and refusal audit; its
  complete prospective pair-row set and under-lock topology comparison must stay
  visible beside the relation moves they fence.

file: src/lib/member-partner-link.ts
lines: 1570
reason: all partner lifecycle writers use this service's single lock seam for
  advisory-to-pair-row order; splitting it would fragment one lifecycle contract.

file: src/lib/nomination.ts
lines: 2612
reason: application approval owns its complete rollback boundary; prospective
  mapped pairs and database-race decoding must stay inside that transaction so
  no fee, email, audit, or Xero side effect can precede refusal.
