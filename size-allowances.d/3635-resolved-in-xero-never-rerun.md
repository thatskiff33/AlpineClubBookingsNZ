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
lines: 1152
reason: the report's failure counts (repeated, failed, partial, unsupported)
  leave out an operation an officer resolved in Xero; the predicate's import,
  the selected column and one filter sit where the failure rows are read, and
  the summary keeps the count of resolved rows it left out. #3635 round-3 R6:
  the over-coverage class reads resolved refund-note coverage too, takes
  payments covered only by resolved notes as candidates, reports an
  unreadable one, and targets the note-eligible cash; the coverage and cash
  readers live in `xero-resolved-in-xero-fences.ts` and
  `refund-note-eligible-cash.ts`, and what stays is the candidate query and
  the item, beside the class it corrects.

file: src/app/api/admin/subscription-billing/route.ts
lines: 334
reason: it revalidates the member's admin page through the one route-pattern
  constant, which names the page file, instead of a pattern that matched no
  page; that costs its import.

file: src/app/api/admin/xero/force-sync/route.ts
lines: 340
reason: force-sync of one booking is the single deliberate override of an
  officer's resolved-in-Xero mark, so it passes the override and its audit row
  names the operation it overrode, at the one call and the one audit write
  that must carry them; the fence itself lives in
  `xero-resolved-in-xero-fences.ts`.

file: src/lib/xero-refund-note-link-repair.ts
lines: 883
reason: the blocker query stops waiting on a create resolved in Xero, and the
  comment that said resolving gates nothing is inverted in place; the rule
  lives in `xero-operation-resolution.ts`.
