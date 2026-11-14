# Size allowances for #5107

file: src/app/(admin)/admin/booking-desk/bookings/page.tsx
lines: 836
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/chores/page.tsx
lines: 706
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/config-transfer/page.tsx
lines: 651
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 1001
reason: adds the getAdminPage import and renders the page heading and the
  pending-review card heading from the refund-requests registry label in place
  of typed strings (#4968). The file was already over its limit; splitting it
  apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/display/layouts/page.tsx
lines: 1068
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/display/reference/page.tsx
lines: 611
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/membership/member-applications/page.tsx
lines: 805
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/membership/membership-cancellations/page.tsx
lines: 1216
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

file: src/app/(admin)/admin/roster/page.tsx
lines: 587
reason: adds the getAdminPage import and renders the page heading from its
  registry label in place of a typed string (#4968). The file was already over
  its limit; splitting it apart is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/dashboard/page.tsx#AdminDashboardPage
lines: 616
reason: the pending-review card heading now reads the refund-requests registry
  label, two more lines than the typed string it replaces (#4968). The function
  was already over its limit; lifting it apart is a refactor of its own, not
  part of this fix.

function: src/app/(admin)/admin/setup/setup-page-client.tsx#SetupPageClient
lines: 413
reason: the Setup heading now reads the registry label, two more lines than the
  typed string it replaces (#4968); the card arrays that used to sit above it
  moved to hub-cards.ts. The function was already over its limit; lifting it
  apart is a refactor of its own, not part of this fix.
