# File-size allowances for #5076 (issue #4946)

The review step must show the selected lodge's refund terms above its primary
button. The schedule state itself was moved into its own hook
(`book/_hooks/use-selection-cancellation-schedule.ts`), so what is left in each
already-oversized file below is only the wiring that has to live there.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2453
reason: the wizard owns the date and lodge selection and the policy-check call,
  so it is the only place that can clear the schedule when the selection
  changes and record it when the check answers. The nine added lines are the
  import, the hook call, two clears, one record and the returned value; moving
  them out would split the selection-ownership guard from the state it guards.

file: src/app/(authenticated)/book/_components/review-step.tsx
lines: 1062
reason: the terms must render inside the review step, directly above its
  Confirm / Continue to Payment button, on every payment path. The block itself
  is a separate component; the added lines are its import, the prop and its
  documentation, and the placement with the member-facing lead sentence.

file: src/app/(authenticated)/book/page.tsx
lines: 634
reason: the page shell passes wizard state to the step views; the two added
  lines destructure the schedule and hand it to the review step, the same way
  every other review-step prop is wired.

function: src/app/(authenticated)/book/_components/review-step.tsx#ReviewStep
lines: 997
reason: this change wires the lodge's refund terms into the review step (the
  schedule state itself lives in its own hook); those lines sit inside the
  function `ReviewStep`, which was already over its limit before this change,
  and lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts#useBookingWizard
lines: 2250
reason: this change wires the lodge's refund terms into the review step (the
  schedule state itself lives in its own hook); those lines sit inside the
  function `useBookingWizard`, which was already over its limit before this
  change, and lifting it apart is a refactor of its own, not part of this fix.

function: src/app/(authenticated)/book/page.tsx#BookPage
lines: 609
reason: this change wires the lodge's refund terms into the review step (the
  schedule state itself lives in its own hook); those lines sit inside the
  function `BookPage`, which was already over its limit before this change,
  and lifting it apart is a refactor of its own, not part of this fix.
