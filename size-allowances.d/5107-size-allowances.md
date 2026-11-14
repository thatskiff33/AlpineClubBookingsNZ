# Size allowances for #5107

file: src/app/(admin)/admin/booking-desk/bookings/page.tsx
lines: 836
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already
  over its limit; splitting it apart is a refactor of its own, not part of
  this fix.

file: src/app/(admin)/admin/chores/page.tsx
lines: 748
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already
  over its limit; splitting it apart is a refactor of its own, not part of
  this fix.

file: src/app/(admin)/admin/config-transfer/page.tsx
lines: 651
reason: adds the getAdminPage import and reads the page heading, and the
  full-administrators-only message, from the registry label in place of a
  typed string (#4968). The file was already over its limit; splitting it
  apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 1001
reason: the pending-review card heading now reads the refund-requests
  registry label, which takes two more lines than the typed string it
  replaces, and the existing admin-hubs import gains getAdminPage (#4968).
  The file was already over its limit; splitting it apart is a refactor of
  its own, not part of this fix.

file: src/app/(admin)/admin/display/layouts/page.tsx
lines: 1068
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already
  over its limit; splitting it apart is a refactor of its own, not part of
  this fix.

file: src/app/(admin)/admin/display/reference/page.tsx
lines: 611
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already
  over its limit; splitting it apart is a refactor of its own, not part of
  this fix.

file: src/app/(admin)/admin/membership/member-applications/page.tsx
lines: 805
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already
  over its limit; splitting it apart is a refactor of its own, not part of
  this fix.

file: src/app/(admin)/admin/roster/page.tsx
lines: 587
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already
  over its limit; splitting it apart is a refactor of its own, not part of
  this fix.

file: src/components/admin/booking-policies/minimum-night-stay-section.tsx
lines: 862
reason: adds the getAdminPage import, and the card title reads the minimum
  stay registry label in place of a typed string (#4968). The file was
  already over its limit; splitting it apart is a refactor of its own, not
  part of this fix.

function: src/app/(admin)/admin/dashboard/page.tsx#AdminDashboardPage
lines: 616
reason: the pending-review card heading now reads the refund-requests
  registry label, two more lines than the typed string it replaces (#4968).
  The function was already over its limit; lifting it apart is a refactor of
  its own, not part of this fix.

function: src/app/(admin)/admin/setup/setup-page-client.tsx#SetupPageClient
lines: 413
reason: the Setup heading now reads the registry label, two more lines than
  the typed string it replaces; the card arrays that used to sit above it
  moved to hub-cards.ts (#4968). The function was already over its limit;
  lifting it apart is a refactor of its own, not part of this fix.
