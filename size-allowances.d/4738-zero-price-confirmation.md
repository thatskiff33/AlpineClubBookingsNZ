# File-size allowances for #4738

Each zero-price door marks a booking PAID and now posts its confirmation in
that same transaction, under the locks it already holds, with the journal
context resolved before the transaction opens (INV-LOCK-004).

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 412
reason: the confirmation post sits beside the PAID write it confirms, inside
  the transaction that holds the draft's locks, and moving it out would
  separate the ledger post from the status change it belongs to.

file: src/app/api/bookings/[id]/waitlist-confirm/route.ts
lines: 571
reason: the post runs only after the $0 flip wins its status-guarded claim,
  inside that transaction, so a lost claim posts nothing; splitting it out
  would put the post on the far side of the claim.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 951
reason: the post follows the zero-worth payment row in the $0 branch's own
  transaction, and lifting the pre-transaction journal read out of the route
  is a refactor of the route.

file: src/app/api/admin/bookings/[id]/force-confirm/route.ts
lines: 371
reason: only the PAID branch of the force-confirm posts, beside the payment
  upsert it confirms; splitting it would separate the post from the branch
  that decides the booking is paid.

file: src/lib/cron-confirm-pending.ts
lines: 2042
reason: the $0 claim already receives the journal context; the post is one
  call after its zero-worth payment row, and splitting the claim out of the
  cron is a refactor of its own.
