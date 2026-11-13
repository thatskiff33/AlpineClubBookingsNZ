# File-size allowances for #5063 (booking review failure attention, #4945)

Two already-over-budget files in the member booking wizard grow, by 33 and 2
lines. A third, `page.tsx`, would have grown by 56. It does not, because the
one seam that existed was taken first: the recovery actions inside the wizard's
error box (guest-profile blocks, member-night conflicts, payment targets and the
lodge retry) moved unchanged into
`src/app/(authenticated)/book/_components/wizard-error-actions.tsx`, which sits
well inside its own budget. That left `page.tsx` at 613 lines, below the 704 it
had on main.

What is left has nowhere else to go.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2431
reason: the attention counter must be raised beside each `setError` that a
  member's own press raises, in `handleSubmit`, `handleJoinWaitlist` and
  `handleSaveAsDraft`, including their "could not verify" endings. The 33 lines
  are that counter, its comment and about twenty one-line bumps. Lifting the
  bumps out would separate each from the write it pairs with, which is how a new
  failure ending would be added without one and leave the member on a dead
  button again. The hook itself is a separate split that needs its own plan.

file: src/app/(authenticated)/book/_components/review-step.tsx
lines: 1039
reason: two lines point the reason-for-review field at the error box
  (`aria-describedby`, with the import of the shared id) because the
  missing-reason refusal is written in that box rather than beside the field.
  Splitting a 1,000-line step for two lines would be a refactor in its own
  right, not part of this fix.
