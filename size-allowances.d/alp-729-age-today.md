# Size allowances for ALP-729 (#5190 PR 3, "Age today" and mid-season age-ups)

"Age today" reads each member's age on the club's today, so every caller of the
shared liability rule now passes that day in. Each entry below is that one
argument, or the one call that hands a mid-season age-up to its own module, at
the place that already decides the rule. The age-up logic itself lives in new
modules (`subscription-age-up-billing.ts`, `subscription-age-up-credit.ts`,
`subscription-age-up-sync.ts`, `member-credit-age-up.ts`,
`age-up-adjustments-list.tsx`), and the charge arithmetic moved out of
`membership-subscription-billing.ts` into `membership-charge-calculation.ts`.
Splitting the long functions below is a refactor of its own.

file: src/app/api/admin/members/export/route.ts
lines: 530
reason: the club's today, pinned to the export's moment, for the filter and
  the per-row rule; the filename already used it.

function: src/app/api/admin/members/export/route.ts#GET
lines: 469
reason: the same pinned today, passed to the filter and to the row rule.

file: src/app/api/admin/subscriptions/route.ts
lines: 362
reason: the club's today beside the season year, from the same zone read.

file: src/lib/admin-members-service.ts
lines: 1664
reason: the club's today at the listing's pinned moment, for the filter and
  the per-row rule.

function: src/lib/admin-members-service.ts#listAdminMembers
lines: 930
reason: the same pinned today, passed to the filter and to the row rule.

file: src/lib/seasonal-membership-assignments.ts
lines: 1881
reason: the reconcile after a save and after a roll-forward passes the club's
  today it already holds.

function: src/lib/seasonal-membership-assignments.ts#rollForwardSeasonalMembershipAssignments
lines: 447
reason: the roll-forward's reconcile passes the club's today it already holds.

file: src/lib/xero-operation-retry.ts
lines: 2058
reason: an age-up credit's failed row is retried through the stored-payload
  requeue, beside the admin grant credit note it mirrors.

function: src/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel.tsx#SubscriptionBillingPanel
lines: 439
reason: the confirm dialog quotes the invoice and credit totals and the list
  of adjustments renders beside the charges; both live in
  age-up-adjustments-list.tsx, so only the calls remain here.

function: src/lib/membership-subscription-billing.ts#buildSubscriptionBillingPreview
lines: 1826
reason: the age-up planner must see each member at the point the season
  charge is judged, priced and put in the token, so its hooks sit inside the
  preview; the planner itself is subscription-age-up-billing.ts.

function: src/lib/xero-membership-sync.ts#checkMembershipStatus
lines: 453
reason: a top-up invoice is filtered out before the season invoice is matched,
  so it is never taken for the member's subscription.

function: src/lib/xero-membership-sync.ts#refreshAllMembershipStatuses
lines: 308
reason: a top-up has no coverage row, so the changed-invoice fan-out hands
  its invoices to subscription-age-up-sync.ts at the one place it has them.

function: src/lib/xero-subscription-invoices.ts#createXeroMembershipSubscriptionInvoice
lines: 420
reason: marking a top-up's adjustment issued has to share the transaction that
  records the invoice, or a member could book against an invoice already sent.
