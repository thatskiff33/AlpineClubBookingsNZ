# File-size allowances for #3924

PR #3924 (issue #3372) shows "Refunds owed" and "Credits owed" beside every
Net Collected figure (owner, 7 Oct 2026). Each file below was already over its
budget on `main`; the growth is the two figures' read and their place on the
surface that shows them. The reading and the markup live in their own modules
(`refunds-and-credits-owed.ts`, `components/admin/refunds-and-credits-owed.tsx`).

file: src/app/(admin)/admin/reports/page.tsx
lines: 787
reason: the two figures' fields on the page's report type, their two CSV rows
  and the shared component under the Net Collected cards; the page's
  report type, CSV builder and cards are one client page, and splitting it is
  a refactor of its own.

file: src/lib/finance-booking-metrics.ts
lines: 1328
reason: the two fields on the payment summary type and its zero value, and the
  one read beside the Net Collected summary; the summary shape is defined here
  and every Finance consumer reads it from here.
