# File-size allowances for #3635 (lane Y: resolved in Xero, broken booking links)

file: src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx
lines: 817
reason: the redemption's booking link now goes through the one booking-page
  path builder instead of a hard-coded path to a page that does not exist;
  that costs its import.

file: src/app/(admin)/admin/waitlist/page.tsx
lines: 1022
reason: the suppressed-offer link now goes through the one booking-page path
  builder, with the returnTo its neighbour carries, instead of a hard-coded
  path to a page that does not exist; the import and the wrapped call.

file: src/app/api/admin/bookings/[id]/mark-paid/route.ts
lines: 256
reason: it revalidates the real booking page through the one route-pattern
  constant instead of a path that does not exist; that costs its import.

file: src/lib/xero-hardening-report.ts
lines: 1106
reason: the report's failure counts (repeated, failed, partial, unsupported)
  leave out an operation an officer resolved in Xero; the predicate's import,
  the selected column and one filter sit where the failure rows are read.

file: src/lib/xero-refund-note-link-repair.ts
lines: 883
reason: the blocker query stops waiting on a create resolved in Xero, and the
  comment that said resolving gates nothing is inverted in place; the rule
  lives in `xero-operation-resolution.ts`.
