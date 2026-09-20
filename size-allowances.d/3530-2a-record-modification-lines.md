# File-size allowances for #3530 stage 2a — record the lines behind an edit's delta

Four already-over-budget edit paths and one route grow, each by the one block
that composes an edit's BEFORE and AFTER sides and hands them to the new pure
module. The lines themselves — shape, diff, parser, sentence, side composers,
the guard — live in the new `booking-modification-lines.ts`, written to its own
ceiling, and the run splitter moved OUT of the invoice builder into its own
`night-price-runs.ts`. What remains at each site is the call, because only the
site knows which guest snapshot it loaded, which breakdown it priced or which
rows it just wrote, and which promotion figure it decided.
`edit-financial-review-charge.ts` stood exactly at its budget and stays there.

file: src/lib/booking-date-modification-service.ts
lines: 2291
reason: the date change composes its lines from the guest snapshot it loaded
  and the breakdown it priced, index-aligned with `guestsForPricing`, and
  returns them so the audit row can list them. Both inputs are locals of the
  transaction that writes the modification row, and the composition belongs
  beside that write - the same place `previousData`/`newData` are composed -
  so a later change to what the row records is made once.

file: src/lib/booking-guest-removal-service.ts
lines: 1504
reason: the same composition for the removal, from the loaded snapshot (the
  removed guest included) and the remaining guests' breakdown, plus the result
  field the route's audit row reads.

file: src/lib/booking-batch-modification-service.ts
lines: 2585
reason: the batch edit composes its AFTER side from the guest rows it has just
  WRITTEN, re-read inside the transaction - the one reading that cannot
  disagree with what landed when the plan orders remaining strands and added
  guests differently from the breakdown - and the audit details gain the
  lines. That re-read has to sit between the write and the modification row.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1633
reason: the guest add composes its lines the same way the batch edit does,
  from the rows it just wrote, inside the transaction that writes the
  modification row; its audit row and result carry them.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 557
reason: the removal route's audit row spreads the lines and their dollar
  sentences from the service result - two spreads and the import.
