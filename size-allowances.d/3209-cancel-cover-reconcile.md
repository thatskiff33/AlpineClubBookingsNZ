# File-size allowances for #3209

Three already-oversized modules each gain one call to the shared
system-cancellation seam, plus the comment that says why the call is there. The
seam itself is a NEW module rather than more length on any of them, or on the
3,000-line hosting engine, which is where the bulk of this change went.

file: src/lib/group-cancel.ts
lines: 929
reason: two calls — one reconcile inside the per-child cancellation transaction
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
