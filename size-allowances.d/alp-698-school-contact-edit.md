# Size allowances for #5245 (Edit school details)

Each of these files and functions was already over its budget. The growth is
the few lines that register one new Xero queue type and one button; everything
else lives in new files (`school-organisation-contact-edit.ts`,
`organisation-xero-contact-details.ts`, `organisation-contact-details-payload.ts`,
`school-contact-editor.tsx`). The outbox module ends no longer than on main, so
it needs no entry: two conditions beside its new dispatch branch now sit on one
line each.

file: src/lib/xero-operation-retry.ts
lines: 2057
reason: the retry must hand a failed contact-details row back to the outbox
  rather than re-resolve the contact; the branch shares the admin grant note's
  requeue and its rule lives in the payload leaf, leaving an import and two lines.

function: src/lib/xero-operation-retry.ts#retryXeroSyncOperation
lines: 754
reason: the same two lines, beside the stored-payload requeue they share.

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
