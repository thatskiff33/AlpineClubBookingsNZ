# File-size allowances for #5021

The fresh-proof call has to sit in the handler that already owns the request,
immediately after that handler's authorisation guard. Splitting each of these
files to absorb one to five lines would move the check away from the route it
guards.

file: src/app/(admin)/admin/config-transfer/page.tsx
lines: 650
reason: the fresh-proof call sits in this page's existing submit handler, after its authorisation guard.

file: src/app/(admin)/admin/deletion-requests/deletion-requests-client.tsx
lines: 1494
reason: the fresh-proof call sits in this client's existing submit handler, after its authorisation guard.

file: src/app/(admin)/admin/display/setup/display-wizard-steps.tsx
lines: 1460
reason: the fresh-proof call sits in this wizard's existing submit handler, after its authorisation guard.

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 968
reason: the fresh-proof call sits in this page's existing submit handler, after its authorisation guard.

file: src/app/(admin)/admin/lodge/page.tsx
lines: 564
reason: the fresh-proof call sits in this page's existing submit handler, after its authorisation guard.

file: src/app/(admin)/admin/members/_components/member-editor-dialog.tsx
lines: 1293
reason: the fresh-proof call sits in this dialog's existing submit handler, after its authorisation guard.

file: src/app/(admin)/admin/members/_components/member-import-dialog.tsx
lines: 883
reason: the fresh-proof call sits in this dialog's existing submit handler, after its authorisation guard.

file: src/app/(admin)/admin/system/backups/backups-client.tsx
lines: 845
reason: the fresh-proof call sits in this client's existing submit handler, after its authorisation guard.

file: src/app/api/admin/backups/config/route.ts
lines: 292
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/booking-exception-requests/[id]/route.ts
lines: 818
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 957
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/bookings/[id]/review/route.ts
lines: 361
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1299
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/integrations/credentials/route.ts
lines: 350
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/lodge/route.ts
lines: 510
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/members/bulk-update/route.ts
lines: 752
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/members/export/route.ts
lines: 549
reason: the fresh-proof call sits in this route, after its authorisation guard and before the export is built.

file: src/app/api/admin/members/import/route.ts
lines: 819
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 750
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/app/api/admin/xero/import-member-contact/route.ts
lines: 397
reason: the fresh-proof call sits in this route, after its authorisation guard and before the body is read.

file: src/components/admin/booking-requests/policy-exception-requests-panel.tsx
lines: 1015
reason: the fresh-proof call sits in this panel's existing submit handler, after its authorisation guard.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2722
reason: the fresh-proof call sits in this panel's existing submit handler, after its authorisation guard.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2375
reason: the fresh-proof call sits in this queue's existing submit handler, after its authorisation guard.
