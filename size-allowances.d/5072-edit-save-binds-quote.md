# File-size allowances for #5072

Three already-over-budget files grow to bind a booking edit's save to the
figures its preview quoted (#4924, `INV-MOD-062`). The comparison itself, the
schema and the refusal message were written to their own new modules
(`src/lib/edit-quoted-figures.ts`, `src/lib/booking-modify-request.ts`,
`src/components/edit-booking/edit-price-changed.ts`). What remains in each
file below is the call at the one point it has to happen, with the comment
saying why it sits there.

file: src/lib/booking-batch-modification-service.ts
lines: 2758
reason: one `assertEditQuotedFigures` call and its comment. It must run on the
  post-lock re-read, after every figure is final and before anything leaves
  the transaction, so a refusal rolls the transaction back and keeps nothing.
  That point is inside `modifyBookingBatch`'s transaction; moving the call out
  would separate the guard from the ordering that makes it correct.

file: src/lib/booking-date-modification-service.ts
lines: 2254
reason: the `quotedFigures` input field and one `assertEditQuotedFigures` call
  on `adminShiftBookingDates`' post-lock re-read, before the night rewrite.
  Same reason as the batch service: the guard is only correct at that position
  inside the locked transaction.

file: src/components/edit-booking-panel.tsx
lines: 2156
reason: three short branches inside `handleSave` (re-price when Save is
  pressed inside the quote debounce, send the previewed figures, handle the
  409 refusal) plus the hook wiring for `requote`. Each one returns early from
  or mutates the save body mid-flow, between the hosting signature and the
  linked-move branch it must precede; lifting them into a hook would scatter
  one save sequence across two files. The message and the body parsing already
  live in `edit-booking/edit-price-changed.ts`.

function: src/components/edit-booking-panel.tsx#EditBookingPanel
lines: 2029
reason: this change binds a booking edit's save to the figures its preview
  showed; those lines sit inside the function `EditBookingPanel`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1807
reason: this change binds a booking edit's save to the figures its preview
  showed; those lines sit inside the function `modifyBookingBatch`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.

function: src/lib/booking-date-modification-service.ts#adminShiftBookingDates
lines: 587
reason: this change binds a booking edit's save to the figures its preview
  showed; those lines sit inside the function `adminShiftBookingDates`, which
  was already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
