# Size allowances for #5112

file: src/app/(admin)/admin/finance/reports/page.tsx
lines: 774
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

file: src/app/api/admin/members/export/route.ts
lines: 556
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

file: src/app/api/member/data-export/route.ts
lines: 423
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

file: src/lib/booking-exception-request-service.ts
lines: 2492
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

file: src/lib/booking-exception-requests.ts
lines: 743
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1259
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

file: src/lib/public-page-content-tokens.ts
lines: 771
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside this file, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/finance/reports/page.tsx#ReportsPage
lines: 582
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside the function `ReportsPage`, which was already over its
  limit before this change, and lifting it apart is a refactor of its own, not
  part of this fix.

function: src/app/(finance)/finance/_components/finance-dashboard-client.tsx#FinanceDashboardClient
lines: 493
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside the function `FinanceDashboardClient`, which was already
  over its limit before this change, and lifting it apart is a refactor of its
  own, not part of this fix.

function: src/app/api/admin/members/export/route.ts#GET
lines: 496
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside the function `GET`, which was already over its limit before
  this change, and lifting it apart is a refactor of its own, not part of this
  fix.

function: src/app/api/member/data-export/route.ts#GET
lines: 359
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside the function `GET`, which was already over its limit before
  this change, and lifting it apart is a refactor of its own, not part of this
  fix.

function: src/lib/additional-payment-resend-service.ts#resendAdditionalPaymentEmail
lines: 383
reason: splits the Whakapapa module off the generic conditions widget, adds
  three club booking-timing settings and club-named download filenames; those
  lines sit inside the function `resendAdditionalPaymentEmail`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
