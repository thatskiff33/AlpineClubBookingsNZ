# File-size allowances for #5149 (fork #119, #129, #127, #130, #132): add a booking to, or remove it from, a work party

The feature's own logic lives in new modules written to their own ceilings:
`src/lib/work-party-booking-correction.ts`, and the batch service's argument
in `src/lib/booking-batch-work-party-correction.ts`. The change must happen
inside the one canonical booking-edit pipeline, not beside it (`INV-SSOT`; the
issue rejects a second repricing path). `booking-batch-modification-service.ts`
and `booking-modify-plan.ts` are past their hard ceilings, so they do not
grow: the argument's type and guard moved out to their own module, the
identity-only pricing echo moved out verbatim to
`src/lib/booking-identity-only-pricing.ts`, and the internal-code admission is
`enteredPromoCodeAdmitted` in `src/lib/promo-code-list-rules.ts`. Fork #127
and #130 add the started-stay code day to the argument's module and Remove's
admission and removal helpers beside `enteredPromoCodeAdmitted`, and the
pricing pass takes the bed skip through `skipBookingLifecycleRules`, so
neither file grows. The settlement-choice rules moved to
`src/lib/work-party-settlement-options.ts` to keep the service under its own
budget.

file: src/lib/booking-guests.ts
lines: 832
reason: `getAllowedGuestMemberIds` is the one definition of a member's family
  (INV-SSOT). It is now exported for a second reader, "Add to work party"
  (`work-party-booking-facts.ts`), which refuses the officer's own and family's
  bookings (owner decision 3, 18 Nov 2026); the two-line doc names that second use. Moving the function out would split the
  member-guest boundary from the set it is built on.

function: src/lib/booking-batch-modification-service.ts#modifyBookingBatch
lines: 1842
reason: the argument's one-line declaration (its explanation lives on the
  `OfficerWorkPartyCorrection` type), the guard call at the top, the promo
  admission handed to `applyPromoCodeChanges`, the no-fee and full-reduction
  branches inside the fee and settlement expressions they change, the audit
  marker in the modification row and the result, and the F20 (#1887)
  `refundedExcessCreditCents` carried out on both results so a caller can check
  every cent that comes back. Fork #127/#130: the edit policy is asked for the
  officer-only "work-party-correction" mode beside the finished-stay
  correction's identical flag, the pricing pass is told the correction moves
  no bed, and the correction's direction rides the one argument to the promo
  engine. Each sits in a step of the one edit; splitting `modifyBookingBatch`
  is a refactor of its own.

function: src/app/(authenticated)/bookings/[id]/_lib/booking-detail-editor-data.ts#buildBookingDetailEditorData
lines: 311
reason: fork #130: the booking page reads which work party the booking is on,
  beside the data it already loads for the officer tools card.
