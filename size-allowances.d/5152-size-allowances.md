# Size allowances for #5152

function: src/app/(admin)/admin/booking-desk/waitlist/page.tsx#AdminWaitlistPage
lines: 780
reason: sweeps admin failed-response reads onto the shared refusal reader;
  those lines sit inside the function `AdminWaitlistPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/finance/reports/page.tsx#ReportsPage
lines: 586
reason: sweeps admin failed-response reads onto the shared refusal reader;
  those lines sit inside the function `ReportsPage`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.

function: src/app/(admin)/admin/finance/subscriptions/_components/subscription-billing-panel.tsx#SubscriptionBillingPanel
lines: 421
reason: sweeps admin failed-response reads onto the shared refusal reader;
  those lines sit inside the function `SubscriptionBillingPanel`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/subscriptions/page.tsx#SubscriptionsPage
lines: 662
reason: sweeps admin failed-response reads onto the shared refusal reader;
  those lines sit inside the function `SubscriptionsPage`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/hut-leaders/page.tsx#HutLeadersPage
lines: 1391
reason: sweeps admin failed-response reads onto the shared refusal reader;
  those lines sit inside the function `HutLeadersPage`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.

function: src/app/(admin)/admin/rules/fees/_components/finance-fees-sections.tsx#FinanceFeesSections
lines: 472
reason: sweeps admin failed-response reads onto the shared refusal reader;
  those lines sit inside the function `FinanceFeesSections`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/(admin)/admin/rules/promo-codes/promo-codes-page-client.tsx#PromoCodesPageClient
lines: 1613
reason: sweeps admin failed-response reads onto the shared refusal reader;
  those lines sit inside the function `PromoCodesPageClient`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/app/(admin)/admin/membership/member-applications/page.tsx#MemberApplicationsPage
lines: 724
reason: converts admin failed-response reads to the shared reader (check ok
  before parsing, fallback sentence for an unreadable body or rejected fetch);
  those lines sit inside the function `MemberApplicationsPage`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
