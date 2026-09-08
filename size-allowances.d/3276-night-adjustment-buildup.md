# File-size allowances for #3276

Stage 2 of programme #3272 records what each promotion took off each night or
guest. The pricing engine's per-target detail and the recorder call at every
promotion writer land in files that were already over budget; each is a
handful of lines beside the money it describes, and lifting any of them out
would put the decision and the write in different files — the drift #3275
just finished closing for the price provenance.

file: src/lib/policies/pricing.ts
lines: 1031
reason: the per-target detail is emitted by the same loops that sum the
  discount, so the row and the total are the same term; a separate walk over
  the guests would be a second computation of the same money.

file: src/lib/promo.ts
lines: 1907
reason: the work-party window must filter rates and dates by the same
  positions, and the beneficiary of a row is decided by the same
  assigned-scope test the allocations use; both belong beside the code that
  makes those decisions.

file: src/lib/booking-create.ts
lines: 2028
reason: three creates redeem a promotion and each records the build-up after
  its redemption write, inside its own transaction; the split child records
  its empty build-up beside its sibling.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1433
reason: the record must sit after the nested night write and the promotion
  rewrite, inside the transaction, and skip a parked add — a decision this
  route already makes in place.

file: src/lib/booking-date-modification-service.ts
lines: 2148
reason: the date change records after its night rewrite and the admin shift
  carries the rows across its translation; both writers live here and both
  orderings are load-bearing.

file: src/lib/booking-guest-removal-service.ts
lines: 1367
reason: recalculateBookingPromo now hands the build-up and the engine result
  back to its callers, and the removal records for the remaining guests
  right after it.

file: src/lib/booking-modify-plan.ts
lines: 2973
reason: applyPromoCodeChanges reports the build-up on every branch, including
  the two stubs, so the batch service can record after the night rewrite.

file: src/lib/booking-batch-modification-service.ts
lines: 2488
reason: the ordering hazard is here — the promotion is written before the
  nights — so the snapshot, the record and the restore must bracket
  applyGuestChanges in this file.

file: src/lib/waitlist.ts
lines: 1446
reason: the reprice degrades instead of rolling back, so the pure
  reconciliation runs before the first night write and the record after the
  last, both beside the writes they bracket.
