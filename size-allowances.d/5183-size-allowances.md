# Size allowances for #5183

file: src/app/api/admin/mountain-conditions/route.ts
lines: 447
reason: adds a check of the saved selectors to the Update from upstream refresh,
  so a selector the current engine refuses is named as a 400 instead of a bare
  500 (#5183). The file was already over its limit; splitting it apart is a
  refactor of its own, not part of this fix.
