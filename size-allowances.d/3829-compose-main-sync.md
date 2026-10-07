# File-size allowance for #3829 (compose child of epic #3813)

The final `main` sync composed main's #3653 group-cancel refund plan with the
epic's #3827 hand-back netting: a group cancellation's per-child refund is now
sized net of cash an edit or refund request already promised back by hand, as
every other cancellation already is.

file: src/lib/group-cancel.ts
lines: 941
reason: one import and the hand-back figure passed to the one refundable-base
  helper main's #3653 already calls inside the mirror-plan loop; the loop is
  the only place that base is computed for a group, so the figure belongs
  beside it rather than in a new module.
