# File-size allowances for #3935

The officer's "In cash" answer has to ride the one refund-note pipeline end to
end - enqueue, outbox dispatch, builder, retry - beside the refund method it
qualifies, as #3536's `noteWording` already does for the modification note.
Each file gains only the field's pass-through; the reading lives once in
`xero-refund-method.ts`.

file: src/lib/xero-credit-notes.ts
lines: 1279
reason: the builder is where the note's words are chosen and its retry payload
  recorded; the wording has to be resolved beside the method it qualifies, and
  moving one option out of the builder would split that choice in two.

file: src/lib/xero-operation-outbox.ts
lines: 3290
reason: the enqueue writes the payload and the dispatcher reads it back in this
  file; a field carried by both must be added in both, beside refundMethod.

file: src/lib/xero-operation-retry.ts
lines: 1879
reason: two lines in the refund-note replay, beside the refund method it
  forwards; the replay of every field of that row lives in this one call.
