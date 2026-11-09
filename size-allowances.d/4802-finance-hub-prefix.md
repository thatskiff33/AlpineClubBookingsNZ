# File-size allowances for the Finance hub move (#4802)

Each of these files links a Finance page, and now takes that link from the hub
registry (`adminHref`) instead of writing the URL by hand, so the link follows
the page when the switch goes on. The only growth in each is the one line that
imports `adminHref`; the links themselves stay the same length. The three
moved list pages also gain one named constant for their own address.

file: src/app/(admin)/admin/book/page.tsx
lines: 1664
reason: one import line, so the Xero setup link comes from the hub registry.
  Splitting the booking page to absorb an import would move code for no gain.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 999
reason: one import line, so the payments and refunds cards link through the
  hub registry. The cards belong with the rest of the dashboard.

file: src/app/(admin)/admin/finance/xero/_components/health-diagnostics-panel.tsx
lines: 737
reason: one import line, so the member-grouping link comes from the hub
  registry. The panel's diagnostics read as one unit.

file: src/components/admin/subscription-lockout-settings-panel.tsx
lines: 792
reason: one import line, so the Xero setup links come from the hub registry.
  The links sit inside the settings form they explain.

file: src/lib/audit-query.ts
lines: 1354
reason: one import line, so audit deep links come from the hub registry. The
  link table belongs beside the query that builds each row.

file: src/lib/stuck-state-dashboard.ts
lines: 1179
reason: one import line, so stuck-state links come from the hub registry.
  Each link sits in the detector it belongs to.

file: src/app/(admin)/admin/finance/payments/page.tsx
lines: 1423
reason: the page builds its own address, and router.replaces to it, from
  adminHref: one import, and a documented constant used three times. Splitting
  the payments board to absorb them would separate the constant from its users.

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 951
reason: as Payments: one import and a documented constant for the page's own
  address, beside the filter state that builds on it.

file: src/app/(admin)/admin/finance/subscriptions/page.tsx
lines: 849
reason: as Payments: one import and a documented constant for the page's own
  address, used by the filter sync and the reset.
