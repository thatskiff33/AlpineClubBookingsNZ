# File-size allowances for #5076 (issue #4946)

The review step must show the selected lodge's refund terms above its primary
button. The schedule state itself was moved into its own hook
(`book/_hooks/use-selection-cancellation-schedule.ts`), so what is left in each
already-oversized file below is only the wiring that has to live there.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2407
reason: the wizard owns the date and lodge selection and the policy-check call,
  so it is the only place that can clear the schedule when the selection
  changes and record it when the check answers. The nine added lines are the
  import, the hook call, two clears, one record and the returned value; moving
  them out would split the selection-ownership guard from the state it guards.

file: src/app/(authenticated)/book/_components/review-step.tsx
lines: 1052
reason: the terms must render inside the review step, directly above its
  Confirm / Continue to Payment button, on every payment path. The block itself
  is a separate component; the added lines are its import, the prop and its
  documentation, and the placement with the member-facing lead sentence.

file: src/app/(authenticated)/book/page.tsx
lines: 706
reason: the page shell passes wizard state to the step views; the two added
  lines destructure the schedule and hand it to the review step, the same way
  every other review-step prop is wired.
