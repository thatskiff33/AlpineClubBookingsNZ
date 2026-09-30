# File-size allowances for #3582 — an edit's booking-ledger lines

Four already-over-budget edit doors grow by one posting call each, placed right
after the `BookingModification` row it anchors on, inside the transaction and
under the `lock(1)` each door already holds. The work itself was split rather
than allowed for: the planner (`booking-ledger-modification-posting.ts`), the
writer calls (`booking-ledger-modification-sync.ts`) and the shared sides
(`booking-modification-pricing.ts`) are new modules inside their own budgets.
Moving the call out of the door would separate a posting from the history row
and the transaction it records.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1668
reason: one ledger posting call after the guest-add history row, plus its import.

file: src/lib/booking-batch-modification-service.ts
lines: 2633
reason: one ledger posting call after the batch edit's history row, plus its import.

file: src/lib/booking-date-modification-service.ts
lines: 2340
reason: one ledger posting call after the date change's history row, and one after the admin date shift's (#3741), plus their imports.

file: src/lib/booking-guest-removal-service.ts
lines: 1523
reason: one ledger posting call after the removal's history row, plus its import.
