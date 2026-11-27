# File-size allowances for #5238 (edit figures on every door)

The figures logic lives in `src/lib/edit-quoted-figures.ts`,
`src/lib/booking-linked-date-move-request.ts` and
`src/lib/hosting-coverage-linked-move-client.ts`; the batch service, the
linked-move service and the edit panel shrank. What is left here is the wiring
each door needs where its request is parsed and its save is called.

file: src/app/api/bookings/[id]/modify-dates/route.ts
lines: 394
reason: the route must parse the figures, refuse a save without them before
  any service runs, hand them to both writers, and answer the refusal ahead of
  the generic ApiError branch; each is one line at the place it happens, and
  the shared schema shape and refusal reader already live in
  edit-quoted-figures.ts.

function: src/lib/booking-date-modification-service.ts#modifyBookingDates
lines: 1161
reason: the comparison has to run inside the transaction after the fresh
  figures are computed and before the first settlement write; it is one call
  to the shared assertEditQuotedFigures, and #4927 owns splitting this function.

function: src/lib/booking-linked-date-move-service.ts#runLinkedDateMove
lines: 372
reason: each booking's figures must reach its own save inside the one
  transaction, and a missing one must be refused before the commit; both are
  single calls into booking-linked-date-move-request.ts, and #4927 owns
  splitting this function.
