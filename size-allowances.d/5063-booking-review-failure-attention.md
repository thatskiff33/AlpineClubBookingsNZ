# File-size allowances for #5063 (booking review failure attention, #4945)

Two already-over-budget files in the member booking wizard grow, by 46 and 10
lines. A third, `page.tsx`, would have grown by more than 56. It does not,
because the one seam that existed was taken first: the recovery actions inside
the wizard's error box (guest-profile blocks, member-night conflicts, payment
targets, the lodge retry and the pointer to the Booking Officer request) moved
into `src/app/(authenticated)/book/_components/wizard-error-actions.tsx`, which
sits well inside its own budget. That left `page.tsx` at 632 lines, below the
704 it had on main. The two sentences for a missing review reason, and the check
for them, sit in `_lib/review-reason-missing.ts` rather than in the hook, for the
same reason.

What is left has nowhere else to go.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2444
reason: the attention counter must be raised beside each `setError` that a
  member's own press raises, in `handleSubmit`, `handleJoinWaitlist`,
  `handleSaveAsDraft` and the guests step's `handleGuestsDone`, including the
  "could not verify" endings. The 46 lines are that counter, its comment, 21
  one-line bumps, the import of the review-reason helper and the one derived
  flag the page reads. Lifting the bumps out would separate each from the write
  it pairs with, which is how a new failure ending would be added without one
  and leave the member on a dead button again. The hook itself is a separate
  split that needs its own plan.

file: src/app/(authenticated)/book/_components/review-step.tsx
lines: 1047
reason: ten lines make the reason-for-review field and the request card point
  at the wizard's error box. The field takes `aria-invalid` and
  `aria-describedby` only while the box holds the missing-reason refusal (a new
  optional prop, its default and the one derived constant), and the request card
  takes the id the box's "Go to the request" link lands on. Splitting a
  1,000-line step for ten lines would be a refactor in its own right, not part of
  this fix.
