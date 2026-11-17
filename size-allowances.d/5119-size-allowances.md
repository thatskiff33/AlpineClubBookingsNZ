# Size allowances for #5119

function: src/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel.tsx#SubscriptionBillingPanel
lines: 436
reason: refuses Xero invoice work while Xero is off; those lines sit inside
  the function `SubscriptionBillingPanel`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.

function: src/lib/membership-subscription-billing.ts#buildSubscriptionBillingPreview
lines: 1834
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
