# File-size allowances for #3636

PR #3636 (issue #3372) makes the officer money figures net of refunds and
gives every "Net Collected" figure one booking scope. Each file below was
already over its budget on `main`; the growth is the net figure, its
breakdown line and the hint that says what it covers, on the surface that
shows it.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 971
reason: the Net Collected This Month card's read, its breakdown line and the
  comments that pin what the month and the booking scope mean sit inside the
  page's one getStats batch, with (#3924) the Refunds owed / Credits owed read
  beside it and the card stacking on a narrow screen; lifting getStats out of
  the page is a refactor of its own, not part of relabelling a figure.

file: src/app/(admin)/admin/payments/page.tsx
lines: 1420
reason: the net tile, its hints, the tolerant summary reader and the
  ledger-gap warning (its count in the club number format, #3637) belong beside the tiles they describe in this one client
  page; splitting the page is a separate refactor that would move the tiles
  away from the list whose filters decide their figures.

file: src/app/api/admin/reports/route.ts
lines: 373
reason: owner decision A gives Net Collected Cash its own payment read (the
  shared net-collected select since #3637), and it must sit in the same Promise.all as the report's other reads so the
  figures come from one request; moving the reads out of the handler is a
  refactor of the whole route.
