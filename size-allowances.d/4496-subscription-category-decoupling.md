# File-size allowances for #4496

Subscription billing categories (#4554). Three files this pull request first
pushed over budget were split instead (the member card's category field, the
category admin page's draft helpers, the category routes' shared select and
audit helpers). The five below were already over budget.

file: src/lib/membership-subscription-billing.ts
lines: 2720
reason: the category branch reads and writes the same closed-family maps,
  exemption gate and per-run double-billing sets as the membership-type
  branch, inside one preview build. The family-recipient, already-invoiced,
  hold-label and component-line rules both branches apply are local helpers
  in that build, so each rule exists once (INV-SSOT-001). Splitting it out now would mean passing
  that shared state across a module boundary in money code; a later split of
  the whole preview builder is the better seam. The final review added the
  one-category-per-family and cross-run mixed-axis guards to that same loop,
  since they read the same per-run sets and existing-charge rows.

file: src/app/api/admin/fee-configuration/route.ts
lines: 677
reason: the category fee schedule is saved in the same transaction and under
  the same fee-schedule lock as the other fee schedules this route already
  writes.

file: src/lib/seasonal-membership-assignments.ts
lines: 1887
reason: the category is previewed and saved in the same two-step,
  token-checked flow as the membership type it sits beside.

file: src/lib/admin-member-detail-service.ts
lines: 1774
reason: five lines to read the member's current category with the rest of
  the seasonal assignment.

file: src/lib/admin-permissions.ts
lines: 951
reason: one line registering the category admin area.
