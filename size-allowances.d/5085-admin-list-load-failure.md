# File-size allowances for #5085 (#4961) - admin list load failures

Three admin route pages that were already over budget each gain a load-error
state (#4961, INV-SSOT-007). The growth is the new state, the clears of stale
rows and totals on every failure, and the one gate in front of each empty state.
It is not new feature surface, and no logic was moved out of the pages.

Splitting these pages is a refactor of its own and would not shorten this change.
The gate has to sit in the same render branch as the empty state it guards, and
the clears have to sit in the same `fetchData` that sets the rows, or a later
edit can add a branch that skips them. The census
`admin-load-error-census.test.ts` checks exactly that, per page file.

The Communications page is 311 lines and under budget, so it needs no entry.

file: src/app/(admin)/admin/finance/payments/page.tsx
lines: 1485
reason: +62 lines over the base. They are the `loadError` state, the clears in
  `fetchData` for a refusal, a server error and a dropped connection, the
  `AdminLoadError` branch, and the hidden toolbar and table row. The existing
  summary-card block is wrapped in the "no load error" branch, so it re-indents
  without gaining lines. The diagnostics `loadErrorCode` and the field-level
  `filterError` stay where they were.

file: src/app/(admin)/admin/finance/subscriptions/page.tsx
lines: 891
reason: +42 lines over the base. The page had no `catch` at all, so the rejected
  fetch is now handled. The failure branch clears rows, total and the summary
  (new `EMPTY_SUMMARY`) and sets the load error, and the count cards and the
  "No subscriptions found" row sit behind the gate.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1478
reason: +48 lines over the base. Two separate load-error states (assignments and
  unassigned nights), each written only under the existing `activeLodgeIdRef`
  guard and reset on a lodge switch. The unassigned-nights failure now renders a
  "could not be checked" card in place of the amber warning, because the
  warning's absence would read as "every night is covered".
