# File-size allowances for fork #119 (fork PR #128): add an existing booking to a work party

The feature's own logic lives in a new module written to its own ceiling,
`src/lib/work-party-booking-correction.ts`. Two already-over-budget files grow
because the change must happen inside the one canonical booking-edit pipeline,
not beside it (`INV-SSOT`; the issue rejects a second repricing path).

file: src/lib/booking-batch-modification-service.ts
lines: 2845
reason: the `officerWorkPartyCorrection` service argument and its explanation,
  beside `waiveChangeFee` (the same kind of argument, for the same reason: a
  request body must not be able to carry it), plus the two places it changes
  the money: no change fee, and the untiered full-reduction settlement, plus
  the guard that refuses it off its one path and the audit marker. Those
  two decisions sit in the fee and settlement expressions they modify; moving
  them out would split one calculation across two files.

file: src/lib/booking-modify-plan.ts
lines: 3023
reason: the one internal-code admission for `applyPromoCodeChanges`, as its
  own helper (`enteredPromoCodeAdmitted`) directly above the function that
  refuses with it, and the parameter that carries it. The refusal and its
  single exception have to be read together.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1828
reason: the argument's one-line declaration (its explanation lives on the
  `OfficerWorkPartyCorrection` type), the guard call at the top, the promo
  admission handed to `applyPromoCodeChanges`, the no-fee and full-reduction
  branches inside the fee and settlement expressions they change, and the
  audit marker in the modification row and the result. Each sits in a step of
  the one edit; splitting `modifyBookingBatch` is a refactor of its own.

function: src/components/admin/admin-booking-tools-card.tsx#AdminBookingToolsCard
lines: 323
reason: the `BookingWorkPartyControls` mount beside the other money controls on
  the card, gated on the work-parties module, and a one-line note on the links'
  WCAG 2.5.8 spacing. Everything the control decides lives in its own
  component; moving the card's sections out is a refactor of its own.
