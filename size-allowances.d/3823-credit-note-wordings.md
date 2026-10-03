# File-size allowances for #3823 (issue #3536)

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2134
reason: the cash-or-bank control itself lives in its own component
  (hand-back-method-choice.tsx); what remains here is the dialog's state, its
  reset on close and submit, the one gate deciding when it is shown, and the
  field in the posted body, all of which belong beside the direction and
  amount state they are reset and posted with.

file: src/lib/xero-booking-repair-classify.ts
lines: 2257
reason: the repaired note has to carry its wording from the same stored
  request the amount is recovered from, inside the one arm that builds that
  action's payload; moving the spread elsewhere would split one payload
  across two files.

file: src/lib/xero-operation-retry.ts
lines: 1853
reason: the modification-note retry reads the stored wording beside the
  stored method it already reads, in the one branch that rebuilds that call;
  lifting six lines out of a single call site would leave the retry's inputs
  read in two places.
