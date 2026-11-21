# Size allowances for #5245 (Edit school details)

Each of these files and functions was already over its budget. The growth is
the few lines that register one new Xero queue type, one permission prefix and
one button; everything else lives in new files, and the outbox module itself
ends shorter, because its entrance-fee payload reader moved to the payload
module (`xero-operation-outbox-payload.ts`) beside the payload it reads
(`school-organisation-contact-edit.ts`, `organisation-xero-contact-details.ts`,
`organisation-contact-details-payload.ts`, `school-contact-editor.tsx`).

function: src/lib/xero-operation-outbox.ts#processQueuedXeroOutboxOperations
lines: 523
reason: one dispatch branch for the school contact-details row, in the chain
  every queue type routes through; splitting the chain is a refactor of its own.

file: src/lib/xero-operation-retry.ts
lines: 2068
reason: the retry must hand a failed contact-details row back to the outbox
  rather than re-resolve the contact; the branch shares the admin grant note's
  requeue and its rule lives in the payload leaf, leaving an import and two lines.

function: src/lib/xero-operation-retry.ts#retryXeroSyncOperation
lines: 754
reason: the same two lines, beside the stored-payload requeue they share.

file: src/lib/admin-permissions.ts
lines: 958
reason: the route-to-area map is the one place an admin API prefix gets its
  permission area; the new `/api/admin/organisations` prefix and its reason
  belong beside `/api/admin/booking-requests`.

file: src/app/(admin)/admin/booking-desk/bookings/page.tsx
lines: 836
reason: the Edit school details button sits in the school cell of the bookings
  table; one import and one line.

function: src/app/(admin)/admin/booking-desk/bookings/page.tsx#AdminBookingsPage
lines: 663
reason: the same one line in the table's school cell.

function: src/lib/organisation-xero-contacts.ts#findOrCreateXeroContactForOrganisation
lines: 362
reason: the link transaction is the one place that can see an officer's
  correction committed while the school's first contact was being created from
  the older details; the rule lives in `organisation-xero-contact-details.ts`,
  leaving one call and its comment under the lock it needs.
