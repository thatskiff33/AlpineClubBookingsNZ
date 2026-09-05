# File-size allowances for #3275

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1407
reason: the nested night writer must stamp the new provenance beside the sold
  amount; extracting one field would split a single atomic row definition.

file: src/lib/booking-batch-modification-service.ts
lines: 2433
reason: identity-only edits must echo the stored source beside the stored amount;
  the one added projection belongs with the existing pricing projection.

file: src/lib/booking-date-modification-service.ts
lines: 2110
reason: both date-change writers must preserve locked sources and stamp newly
  sold amounts at their existing transactional write boundaries.

file: src/lib/booking-edit-guest-ranges.ts
lines: 1936
reason: the structural planner must carry source vectors alongside its existing
  amount vectors so retained rows cannot silently become newly sold rows.

file: src/lib/booking-modify-plan.ts
lines: 2935
reason: the canonical modify planner owns the locked, parked, and newly priced
  vectors that reach its night-row writer; splitting them would duplicate alignment logic.

file: src/lib/booking-request.ts
lines: 2904
reason: the two direct request-conversion writers must stamp SOLD on the same
  row objects that already carry their quoted amounts.

file: src/lib/waitlist.ts
lines: 1419
reason: the waitlist reprice creates sold night rows in one transaction and the
  source belongs on that existing row object rather than in a second helper.
