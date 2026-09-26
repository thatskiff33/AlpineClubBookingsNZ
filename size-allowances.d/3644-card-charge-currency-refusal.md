# File-size allowances for #3644 (issue #3567, review fix round)

The review asked for the charge-currency refusal to run at EVERY entry point
that can end in a card charge, straight after the club format is resolved and
before any claim, attempt row, customer lookup or status write. The rule itself
lives in `src/lib/stripe-charge-currency.ts` and the re-issue logic in
`src/lib/additional-intent-currency.ts`; what is left in each file below is the
one- or two-line call at its entry point (and, on the reuse paths, the currency
term beside the existing stale-amount term), compacted to the minimum.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 924
reason: the refusal has to sit at this route's own entry point, before its
  claim transaction; a two-line guard does not justify splitting the route.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 651
reason: the refusal has to sit at this route's own entry point, before its
  claim transaction; a two-line guard does not justify splitting the route.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 834
reason: the entry refusal, the currency term on the existing stale-intent
  branch, the 409 for an old-currency intent still processing and the
  member-facing mapping in the existing catch all belong to this route's own
  flow; each is one to three lines.

file: src/lib/cron-confirm-pending.ts
lines: 2036
reason: a charge the product would refuse locally (the stored currency, the
  minimum) is decided inside the claim transaction, before the claim, so it
  writes no attempt row, and handled as its own resolution beside the other
  branches of this one loop, so hold expiries, bumps and extensions still run;
  lifting the loop out is its own refactor.

file: src/lib/group-settlement.ts
lines: 1292
reason: the refusal must precede this function's own CONFIRMED commit, and
  the reuse condition gains one term; both are inside one existing function.

file: src/lib/payment-recovery.ts
lines: 3199
reason: charge operations are kept out of this module's own queue query (and
  its stale-queue alert, also for the stale window after the club format
  changes) while card payments are off, so they cannot fill the batch and
  starve refunds; the filter belongs beside the query it narrows.

file: src/lib/setup-readiness.ts
lines: 2188
reason: the unusable-currency block belongs in the existing Stripe step; a
  separate step module for five lines would split one check across files.
