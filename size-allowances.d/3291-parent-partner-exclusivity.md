# File-size allowances for #3291

These seven files were already over their budgets. Each remains the established
writer or selector for its workflow; the growth is the lock, authoritative
re-read, stable refusal, or call to the shared exclusivity helper at that exact
writer. Moving those few orchestration lines elsewhere would split a transaction
across modules without removing the existing file's responsibility.

file: src/app/api/admin/members/[id]/dependents/link/route.ts
lines: 448
reason: the eight lines acquire the two existing-member lock tiers at the route's
  transaction boundary; extracting them would hide the order from the writer.

file: src/lib/admin-family-group-requests-service.ts
lines: 1675
reason: the family-request transaction must re-read its selected child after its
  lifecycle and partner locks; moving that state machine branch would separate
  the approval decision from the write and its rollback boundary.

file: src/lib/admin-members-service.ts
lines: 1756
reason: six selector lines consume the shared parent and partner predicates in
  the established member-list query; a new wrapper would only obscure those
  composable Prisma conditions.

file: src/lib/member-application-mapping.ts
lines: 1183
reason: the mapping preview already owns every blocker attached to a selected
  existing record; the added shared partner fact belongs beside those outcomes
  so preview-token hashing and operator feedback cannot drift.

file: src/lib/member-merge.ts
lines: 2823
reason: merge alone owns its ordered multi-tier transaction and refusal audit;
  the final-topology participant lock and under-lock recheck must remain visible
  beside the relation moves they fence.

file: src/lib/member-partner-link.ts
lines: 1552
reason: all partner lifecycle writers stay in this one service and now wrap their
  existing transactions with the shared direct-parent check and decoded race;
  splitting individual outcomes would fragment one public lifecycle contract.

file: src/lib/nomination.ts
lines: 2586
reason: application approval already owns its complete rollback boundary; the
  deduped relationship locks and final shared guard must stay inside that same
  transaction so no fee, email, audit, or Xero side effect can precede refusal.
