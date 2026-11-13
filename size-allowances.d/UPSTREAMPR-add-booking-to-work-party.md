# File-size allowances for fork #119 (fork PR #128): add an existing booking to a work party

The feature's own logic lives in a new module written to its own ceiling,
`src/lib/work-party-booking-correction.ts`. Two already-over-budget files grow
because the change must happen inside the one canonical booking-edit pipeline,
not beside it (`INV-SSOT`; the issue rejects a second repricing path).

file: src/lib/booking-batch-modification-service.ts
lines: 2852
reason: the `officerWorkPartyCorrection` service argument and its explanation,
  beside `waiveChangeFee` (the same kind of argument, for the same reason: a
  request body must not be able to carry it), plus the two places it changes
  the money: no change fee, and the untiered full-reduction settlement, plus
  the guard that refuses it off its one path and the audit marker. Those
  two decisions sit in the fee and settlement expressions they modify; moving
  them out would split one calculation across two files.

file: src/lib/booking-modify-plan.ts
lines: 3016
reason: the one internal-code admission in `applyPromoCodeChanges`, next to
  the refusal it narrows, and the parameter that carries it. The refusal and its
  single exception have to be read together.
