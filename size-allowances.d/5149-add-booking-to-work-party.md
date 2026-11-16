# File-size allowances for #5149 (fork #119, fork #129): add an existing booking to a work party

The feature's own logic lives in new modules written to their own ceilings:
`src/lib/work-party-booking-correction.ts`, and the batch service's argument
in `src/lib/booking-batch-work-party-correction.ts`. The change must happen
inside the one canonical booking-edit pipeline, not beside it (`INV-SSOT`; the
issue rejects a second repricing path). `booking-batch-modification-service.ts`
and `booking-modify-plan.ts` are past their hard ceilings, so they do not
grow: the argument's type and guard moved out to their own module, the
identity-only pricing echo moved out verbatim to
`src/lib/booking-identity-only-pricing.ts`, and the internal-code admission is
`enteredPromoCodeAdmitted` in `src/lib/promo-code-list-rules.ts`.

file: src/lib/booking-guests.ts
lines: 832
reason: `getAllowedGuestMemberIds` is the one definition of a member's family
  (INV-SSOT). It is now exported for a second reader, "Add to work party", which
  refuses the officer's own and family's bookings when money comes back; the
  two-line doc names that second use. Moving the function out would split the
  member-guest boundary from the set it is built on.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1837
reason: the argument's one-line declaration (its explanation lives on the
  `OfficerWorkPartyCorrection` type), the guard call at the top, the promo
  admission handed to `applyPromoCodeChanges`, the no-fee and full-reduction
  branches inside the fee and settlement expressions they change, the audit
  marker in the modification row and the result, and the F20 (#1887)
  `refundedExcessCreditCents` carried out on both results so a caller can check
  every cent that comes back. Each sits in a step of the one edit; splitting
  `modifyBookingBatch` is a refactor of its own.

function: src/components/admin/admin-booking-tools-card.tsx#AdminBookingToolsCard
lines: 323
reason: the `BookingWorkPartyControls` mount beside the other money controls on
  the card, gated on the work-parties module, and a one-line note on the links'
  WCAG 2.5.8 spacing. Everything the control decides lives in its own
  component; moving the card's sections out is a refactor of its own.
