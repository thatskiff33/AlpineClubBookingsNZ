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
lines: 799
reason: the compact status-cell chip belongs beside the existing booking and
  operational review signals; extracting nine lines would split one row.

file: src/app/(admin)/admin/reports/page.tsx
lines: 773
reason: the reconciliation warning and CSV rows consume the report response
  beside the existing cash warning and export builder they must agree with.

file: src/app/api/admin/reports/route.ts
lines: 361
reason: the route classifies the same coherent booking projection already used
  for its aggregate, avoiding a second read or a divergent report cohort.

file: src/app/api/member/data-export/route.ts
lines: 371
reason: the existing booking export query must carry the complete canonical
  projection so the exported state describes the same stored record.

file: src/lib/admin-bookings-service.ts
lines: 1438
reason: list hydration already owns the one bounded heavy booking projection;
  classifying there avoids another query and keeps pagination coherent.

file: src/lib/finance-booking-metrics.ts
lines: 1324
reason: reconciliation must use the exact contributing booking cohort and the
  same stable snapshot as the existing finance calculations.

file: src/lib/xero-booking-invoices.ts
lines: 1621
reason: reconciliation evidence remains attached to the initial operation and
  stale-contact repair, while the invoice owner can be an Organisation without
  changing the provider invoice shape.
