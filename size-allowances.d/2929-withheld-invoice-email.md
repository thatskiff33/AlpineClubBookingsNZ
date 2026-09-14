# File-size allowances for #2929 — the withheld Xero invoice email

One file needs an allowance of its own. Thirteen others this change also grows
— `src/app/(admin)/admin/book/page.tsx`, `src/lib/booking-create.ts`,
`src/lib/xero-booking-invoices.ts`, `src/lib/xero-sync.ts`,
`src/lib/xero-operation-retry.ts`, `src/lib/cron-confirm-pending.ts`,
`src/lib/group-settlement.ts`, `src/lib/school-booking-request.ts` and the five
route handlers that enqueue a booking invoice — already carry a live allowance
from a sibling child of epic #2725, and the gate refuses two live allowances for
one path. Their `lines:` were therefore **re-measured** in the fragments that
already hold them (#2930, #3367, #3368) rather than re-declared here, which is
what the gate asks for in those words: an allowance whose number is not the
file's real length is exactly the drift it replaced. Those allowances are live
against `origin/main` — which is the base CI compares this gate against,
whatever branch the pull request targets — because their own fragments are still
in this diff, unmerged to `main` with the rest of the epic.

**Cross-lane watchpoint.** Re-measuring inside three sibling fragments makes
those three files shared surfaces: any further child of #2725 that grows one of
these paths has to edit the same `lines:` numbers, which is the collision the
fragment-directory rule exists to prevent. It is the least-bad option the gate
leaves — it refuses a second live allowance for one path — but a lane touching
these files should expect to rebase on them.

file: src/lib/xero-operation-outbox.ts
lines: 3272
reason: RE-MEASURED by #3001, which made this file seven lines SHORTER. Two
  strings it spelled out for itself now have one home each, because #3001's
  warning on the booking needed both: the booking-invoice correlation key, built
  inline from four literals and now one call to
  `buildXeroBookingInvoiceCorrelationKey`; and the active primary-invoice link
  lookup, which is the enqueue fence's "does an invoice already exist?" and is
  now the same `findActivePrimaryInvoiceLink` the warning asks, so the fence
  refusing a second mint and the surface refusing to say no invoice exists
  cannot drift apart. The number is re-measured here rather than declared in a
  second fragment, exactly as the note above asks — one
  hundred lines. Sixty-one are the docblock and body of
  `inheritedBookingInvoiceEmailInstruction`, which closes the door the durable
  instruction did not: the outbox dedups only on PENDING and RUNNING, so a
  FAILED booking-invoice operation is RE-MINTED by the admin missing-invoices
  sweep, force-sync or the repair pass, and a fresh row that recorded nothing
  emailed the member the officer chose not to email. That has to live here,
  beside the dedup whose gap it fills and inside the one function that mints
  the row. The rest is the option's own docblock, cut down from the seventeen
  lines it was: the field is now REQUIRED-and-nullable, so the prose census of
  which callers pass it is deleted — the compiler is the census, and a new
  enqueuer cannot compile without answering. This file is deliberately one
  dispatcher over every Xero outbox operation type; splitting the
  booking-invoice enqueuer out would put one queue type's shape in a second
  file, and is how two enqueuers come to disagree about what a queued operation
  carries.
