# File-size allowances for #3209

file: src/lib/group-cancel.ts
lines: 913
reason: twenty-three lines, seventeen of them two comments, on a module that
  was already 890 and wants a split. The change itself is two calls — one
  reconcile inside the per-child cancellation transaction and one drain after
  it commits. The comments earn their place because the defect they close was
  invisible precisely by looking finished: this loop already frees the beds,
  so a reader checking that an organiser cancel is fully reconciled sees bed
  reconciliation and stops. Saying at the call site that CONFIRMED and PAID are
  the two coverage-source statuses, that `ACTIVE_CHILD_STATUSES` contains both,
  and that the drain is scoped per child because every joiner is a different
  owner from the organiser whose drain runs in `booking-cancel.ts`, is what
  stops the next reader deleting either line as redundant. The argument for why
  an organiser cancel must never be refusable is NOT repeated here — it lives
  once, in `adult-member-hosting-system-cancellation.ts`, which is a new module
  rather than more length on this one or on the 3,051-line hosting engine.
