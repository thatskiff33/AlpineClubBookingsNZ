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
lines: 2901
reason: docblock on the approval preservation path, and no code. `INV-MOD-028`
  says a blank night price is cleared only by a person supplying the amount,
  never by a reprice — and this path deletes and recreates an existing hold's
  night rows, so a reader auditing the invariant's enumeration arrives here and
  needs to find the write with something to say. That reasoning belongs at the
  write it exempts. Splitting a 2,900-line module to house it is not the better
  answer. Fix round (+20): the first draft gave the WRONG reason — that an
  officer chose the figures and nothing on the path re-derives an amount, both
  of which are false of the code (the school pipeline writes engine prices off
  the season table, and `buildApprovalGuestNights` falls back to an even split).
  The true reason is that a hold is never editable, so it cannot be carrying a
  blank; the growth is that argument plus the record of what the false one was,
  because a justification that was quietly wrong is exactly what the next
  reader needs to see corrected rather than silently replaced.
