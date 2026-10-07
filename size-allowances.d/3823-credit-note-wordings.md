# File-size allowances for #3823 (issue #3536)

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2189
reason: the cash-or-bank control itself lives in its own component
  (hand-back-method-choice.tsx); what remains here is the dialog's state, its
  reset on close and submit, the one gate deciding when it is shown, and the
  field in the posted body, all of which belong beside the direction and
  amount state they are reset and posted with. Re-measured when epic #3813's
  C2 (#3827) merged in, which adds its own reason: an edit's refund hand-back,
  and an approved appeal's (D-3813-7), is a hand-back row that needs its own
  explaining paragraph, kept out of the cancelled-booking one (D-3813-6); each
  sits beside the other kinds' predicates and paragraphs it is chosen among.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/lib/xero-booking-repair-classify.ts
lines: 2312
reason: the repaired note has to carry its wording from the same stored
  request the amount is recovered from, inside the one arm that builds that
  action's payload; moving the spread elsewhere would split one payload
  across two files.
  Re-measured at #3829, the final main sync, which composed main's #3653,
  #3809, #3835 and #3792 growth of this file with the epic's.

file: src/lib/xero-operation-retry.ts
lines: 1877
reason: the modification-note retry reads the stored wording beside the
  stored method it already reads, in the one branch that rebuilds that call;
  lifting six lines out of a single call site would leave the retry's inputs
  read in two places. Re-measured when epic #3813's C2 (#3827) merged in,
  which adds its own reason: the retry and repair legs keep a refund request's
  note its own role, never re-enter it as per-delta, and never move the
  payment's pointer to it (D-3813-8) - conditions on the existing legs, not a
  new leg.
