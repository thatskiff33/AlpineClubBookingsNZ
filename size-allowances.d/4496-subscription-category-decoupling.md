# File-size allowances for #4496

Subscription billing categories (#4554). Three files this pull request first
pushed over budget were split instead (the member card's category field, the
category admin page's draft helpers, the category routes' shared select and
audit helpers). The five below were already over budget.

Main's function-length ratchet (#5057) landed after this PR was written. The
three functions this PR pushed past 300 lines were split rather than declared:
the category page's state and API calls moved to
`use-subscription-categories.ts` and its row and dialog to their own
components; the seasonal preview's category resolution and age-tier
resolution, and the save's audit metadata, became named helpers. The seven
function entries at the end were already over 300 lines before this PR.

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
lines: 1954
reason: the category is previewed and saved in the same two-step,
  token-checked flow as the membership type it sits beside. Re-measured after
  the function-length splits above, which added helper signatures and doc
  comments but kept each function under 300 lines.

file: src/lib/admin-member-detail-service.ts
lines: 1769
reason: five lines to read the member's current category with the rest of
  the seasonal assignment.

file: src/lib/admin-permissions.ts
lines: 952
reason: one line registering the category admin area.

function: src/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel.tsx#SubscriptionBillingPanel
lines: 410
reason: subscription billing category decoupled from membership type; those
  lines sit inside the function `SubscriptionBillingPanel`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/membership/members/[id]/_components/member-seasonal-membership-card.tsx#MemberSeasonalMembershipCard
lines: 491
reason: subscription billing category decoupled from membership type; those
  lines sit inside the function `MemberSeasonalMembershipCard`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/rules/fees/_components/finance-fees-sections.tsx#FinanceFeesSections
lines: 471
reason: subscription billing category decoupled from membership type; those
  lines sit inside the function `FinanceFeesSections`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.

function: src/lib/admin-member-detail-service.ts#getAdminMemberDetail
lines: 464
reason: subscription billing category decoupled from membership type; those
  lines sit inside the function `getAdminMemberDetail`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.

function: src/lib/membership-subscription-billing.ts#buildSubscriptionBillingPreview
lines: 1827
reason: subscription billing category decoupled from membership type; those
  lines sit inside the function `buildSubscriptionBillingPreview`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/lib/seasonal-membership-assignments.ts#rollForwardSeasonalMembershipAssignments
lines: 446
reason: subscription billing category decoupled from membership type; those
  lines sit inside the function `rollForwardSeasonalMembershipAssignments`,
  which was already over its limit before this change, and lifting it apart is
  a refactor of its own, not part of this fix.

function: src/lib/xero-subscription-invoices.ts#createXeroMembershipSubscriptionInvoice
lines: 414
reason: subscription billing category decoupled from membership type; those
  lines sit inside the function `createXeroMembershipSubscriptionInvoice`,
  which was already over its limit before this change, and lifting it apart is
  a refactor of its own, not part of this fix.
