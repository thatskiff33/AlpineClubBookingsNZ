# File-size allowances for #5052 (issue #4918)

Two registries that were already over budget on the merge base each gain the
entry for the new privacy hosting settings. Neither gains a branch or a
responsibility. The credentials route, which also grew, was brought back under
its base length by collapsing a multi-line type import, so it needs no entry.

file: src/lib/admin-permissions.ts
lines: 951
reason: one line, `/api/admin/privacy-hosting`, in the content area's prefix
  list of ROUTE_AREA_PREFIXES. That table is the single map from admin route
  to permission area, and the route-area matrix test reads it; registering the
  route anywhere else would split the permission map in two.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1217
reason: the privacy-hosting-settings entry in SINGLETONS, plus its import.
  Every exported singleton is declared inline in that one array, and the
  singleton census and the export and import paths read it there. Moving one
  spec to its own module would make it the only one outside the registry, so
  a reader checking which singletons transfer would have to know to look
  elsewhere. The entry is longer than most because it validates and
  normalises each field against its own admin-route schema, which the review
  of this PR asked for so the two fields cannot silently share one rule.
