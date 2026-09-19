# File-size allowances for #3278

file: src/lib/booking-request.ts
lines: 2970
reason: two explicit zero components belong in the existing atomic held-booking
  approval payload beside its total and final price; extracting them would hide
  the four-column money identity without reducing lifecycle complexity.

file: src/lib/school-booking-request.ts
lines: 2903
reason: two explicit zero components belong in the existing atomic school-booking
  approval payload beside its total and final price; extracting them would hide
  the four-column money identity without reducing lifecycle complexity.

file: src/app/(admin)/admin/bookings/page.tsx
lines: 818
reason: the compact status-cell chip belongs beside the existing booking and
  operational review signals; extracting it would split one row. Re-measured
  after the chip was routed through the shared audience helper, which moved its
  wording and its "only when unreconciled" rule into one home.

file: src/app/(admin)/admin/reports/page.tsx
lines: 773
reason: the reconciliation warning and CSV rows consume the report response
  beside the existing cash warning and export builder they must agree with.

file: src/app/api/admin/reports/route.ts
lines: 361
reason: the route classifies the same coherent booking projection already used
  for its aggregate, avoiding a second read or a divergent report cohort.

file: src/lib/admin-permissions.ts
lines: 983
reason: the booking-officer predicate belongs beside the booking-authority
  helper it composes with (`bookingManagementAuthorizationRole`) and the area
  check it calls; a second permissions module for one predicate is the split
  `INV-SSOT` warns about, where "who is a booking officer" gains a second home.

file: src/lib/admin-bookings-service.ts
lines: 1438
reason: list hydration already owns the one bounded heavy booking projection;
  classifying there avoids another query and keeps pagination coherent.

file: src/lib/finance-booking-metrics.ts
lines: 1324
reason: reconciliation must use the exact contributing booking cohort and the
  same stable snapshot as the existing finance calculations.

file: src/lib/xero-booking-invoices.ts
lines: 1668
reason: reconciliation evidence remains attached to the initial operation and
  stale-contact repair, while the invoice owner can be an Organisation without
  changing the provider invoice shape. Re-measured after the fix that persists
  the reconciliation before any provider work, so a throw between the two
  cannot leave the booking claiming a state the ledger never recorded, and
  again after review separated the raise-time verdict from the one a replay
  records, which is what stops a retry restating history it did not observe.
