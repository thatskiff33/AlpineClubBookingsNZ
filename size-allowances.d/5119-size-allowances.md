# Size allowances for #5119

function: src/app/(admin)/admin/finance/reports/page.tsx#ReportsPage
lines: 582
reason: names the report download by the club's short name instead of the hard-coded tac-report; those lines sit inside
  the function `ReportsPage`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel.tsx#SubscriptionBillingPanel
lines: 405
reason: refuses Xero invoice work while Xero is off; those lines sit inside
  the function `SubscriptionBillingPanel`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/app/(finance)/finance/_components/finance-dashboard-client.tsx#FinanceDashboardClient
lines: 493
reason: names the report download by the club's short name instead of the hard-coded tac-report; those lines sit inside
  the function `FinanceDashboardClient`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/membership-subscription-billing.ts#buildSubscriptionBillingPreview
lines: 1132
reason: refuses Xero invoice work while Xero is off; those lines sit inside
  the function `buildSubscriptionBillingPreview`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.

function: src/lib/nomination.ts#approveMemberApplication
lines: 1154
reason: refuses Xero invoice work while Xero is off; those lines sit inside
  the function `approveMemberApplication`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/xero-operation-retry.ts#retryXeroSyncOperation
lines: 752
reason: refuses Xero invoice work while Xero is off; those lines sit inside
  the function `retryXeroSyncOperation`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.
