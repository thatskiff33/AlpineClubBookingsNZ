# File-size allowances for #3209

Three already-oversized modules each gain one call to the shared
system-cancellation seam, plus the comment that says why the call is there. The
seam itself is a NEW module rather than more length on any of them, or on the
3,000-line hosting engine, which is where the bulk of this change went.

file: src/lib/group-cancel.ts
lines: 915
reason: net of the fourteen lines this change GAVE BACK, by moving the child
  status set it shared with the reaper into `booking-status.ts`. What is left is
  two calls — one reconcile inside the per-child cancellation transaction
  and one drain after it commits — plus the comment that stops the next reader
  deleting them. The comment earns its place because the defect it closes was
  invisible precisely by looking finished: this loop already frees the beds, so
  a reader checking that an organiser cancel is fully reconciled sees bed
  reconciliation and stops. It also corrects a pre-existing sentence in this
  file that said the reaper "only re-drives not-yet-CANCELLED groups", which is
  false and was load-bearing in the first draft of this change's reasoning. The
  argument for why an organiser cancel must never be refusable is NOT repeated
  here — it lives once, in the new seam module.

file: src/lib/payment-reconciliation.ts
lines: 2909
reason: one call in the capacity-failed void branch, and ten comment lines that
  have to be there. This is the branch a whole-file census certified while it
  reached no seam at all, because a seam exists further down the same function
  on the mutually exclusive settle path — so the comment states which enqueue
  belongs to which branch, at the point where the next reader would otherwise
  conclude the file already handles it. Splitting the settle function is a real
  refactor of the money path and does not belong in a supervision fix.

file: src/lib/waitlist-cross-lodge.ts
lines: 978
reason: one call in the price-drift unwind transaction and one drain after it,
  with eight comment lines recording the non-obvious fact that makes them
  necessary: the replacement booking this unwind cancels can be PAID, because a
  zero-price stay is auto-confirmed on creation, and that creation may already
  have RESTORED cover to another booking of the same owner and closed its
  incident. Without the note the two calls read as defensive noise on a booking
  that "was only just created", which is exactly the reading that left the gap.
file: src/lib/adult-member-hosting-review.ts
lines: 2709
reason: the cross-lodge coverage gap this pull request also closes. Forty-odd
  lines are the new `hasHostingSiblingAtActiveLodge` read and its docblock; the
  rest is the mode gate's own rationale, REWRITTEN rather than added to. That
  rationale is #2623 T5's, and it was the load-bearing part: it argued in as many
  words that skipping the fence was safe because "neither the sibling fan-out nor
  `settleSameOwnerDependentCoverage` is reachable", which was true of the second
  and false of the first — and the next reader following that argument would
  reinstate the defect. Replacing it costs more lines than adding a clause because
  it now has to say which lodge decides, why the same-owner half needs no widening
  and how the lock property survives, each of which a reader has to have at the
  gate rather than two files away. Splitting a 2,700-line engine that eleven
  writers reach through one entry point is a real refactor and does not belong in
  a supervision fix; `INV-HOST-042` carries the same argument for anyone reading
  the rule rather than the code.
