# File-size allowances for #3166

One module this issue's fix round grew past its budget. The two other modules it
grew — `edit-financial-review.ts` and `stored-sold-price-evidence.ts` — were both
under 700 LOC before this change, so an allowance could not cover them and they
were SPLIT instead, at the seams the additions made obvious:
`edit-financial-review-occurrence.ts` (an occurrence's identity, its operator
prose, and the slot its next task goes in) and `stored-night-price-write.ts`
(what may be written into `BookingGuestNight.priceCents`, the write-side twin of
the read-side evidence module). Every other over-budget file this change touches
is already declared by the epic's earlier children, whose recorded lengths are
corrected in place rather than duplicated here — the gate refuses one change
carrying two allowances for one path.

file: src/lib/booking-request.ts
lines: 2881
reason: fourteen lines of docblock on the approval preservation path, and no
  code. `INV-MOD-028` says a blank night price is cleared only by a person
  supplying the amount, never by a reprice — and this path deletes and recreates
  an existing hold's night rows, which CAN overwrite a blank. It is outside the
  rule rather than an exception to it, because an officer accepted a specific
  quote option at a price they chose and those are the figures written. That
  reasoning belongs at the write it exempts: a reader auditing the enumeration
  from the invariant arrives here, and finding the write with nothing to say
  would read as a writer nobody had considered. Splitting a 2,881-line module to
  house fourteen lines of comment is not the better answer.
