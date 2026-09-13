# File-size allowances for #2930 (waitlist reachability and hold privacy)

Three already-over-budget files in the member booking wizard grow. **Two seams
that did exist were taken first**, and they are why this list is three files and
not five:

- `src/app/(authenticated)/book/_lib/capacity-advisory.ts` — the pure per-night
  shortfall calculation and its member-facing sentence, lifted out of the wizard
  hook. It is the piece worth testing on its own, and it took 53 lines with it.
- `src/app/(authenticated)/book/_components/capacity-short-notice.tsx` — the
  "these dates will not fit your party" panel, which the guests step and the
  review step would otherwise each have carried their own copy of. Two copies of
  a privacy-shaped sentence is the arrangement in which one of them eventually
  drifts into naming a reason (`INV-SSOT-001`), and this is precisely the
  sentence that must never say why the lodge is full.

Both new modules are comfortably inside their own budgets. What is left is
growth that has nowhere else to go.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 1998
reason: the hook is the wizard's single state machine, and this change alters
  what that machine decides rather than adding a feature beside it — the
  advisory replaces a hard stop, `waitlistOnly` becomes an input to
  `showPaymentMethodChoice` and to the payment-method reset effect, and the
  lodge's own capacity replaces the club-identity figure in four party-size
  ceilings. Each of those is a few lines of code inside an existing decision,
  and none of them can move: a state machine split by line count puts half a
  decision in another file. The pure part already did move, to
  `_lib/capacity-advisory.ts`, which is where the 94-line first measurement
  came down to this one. The remainder is mostly explanation, and it is load-
  bearing: the comment on the removed capacity stop is the only record of WHY
  a client-side refusal there was the defect rather than a safeguard, and the
  comment on `showPaymentMethodChoice` is the only statement of the owner's
  contract point 5 anywhere in the code that implements it.

file: src/app/(authenticated)/book/_components/review-step.tsx
lines: 1024
reason: the waitlist-only arm has to be here, because it is a fork in this
  step's PRIMARY ACTION — Join Waitlist in place of Confirm Booking — and the
  button it replaces sits at the end of a single return block alongside Back and
  Save as Draft. Lifting the action row out would mean threading eight
  props through a component that exists only to hold one ternary. The notice
  itself already went to `capacity-short-notice.tsx`; what remains is the fork,
  its five new props and the docblock on `waitlistOnly` explaining why the
  payment-method chooser is withheld rather than merely hidden — the one place a
  reader can learn that `createWaitlistedBooking` accepts no payment method at
  all, which is what makes asking for one a false promise rather than a missing
  feature.

file: src/app/(authenticated)/book/page.tsx
lines: 702
reason: twenty-two lines, and eighteen of them are prop wiring the shell exists
  to do — the advisory and waitlist state travelling from the hook to the two
  steps that render it. The remaining four are the waitlist prompt's copy fix and
  the comment on it. That comment is the only place in the tree that records the
  observable symptom this issue was found by: a hold-only refusal used to render
  as "is at capacity on 0 nights", because the server's night list skipped a held
  night whose available beds are pinned to 0 rather than negative. Splitting a
  route shell whose whole job is to assemble props would not make that shorter,
  only harder to find.
