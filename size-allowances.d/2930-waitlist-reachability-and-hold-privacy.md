# File-size allowances for #2930 (waitlist reachability and hold privacy)

Five already-over-budget files grow: three in the member booking wizard, and two
that the fix round reached when it closed the same hold leak on the two other
member-facing capacity refusals. **Three seams that did exist were taken first**,
and they are why this list is five files and not eight:

- `src/app/(authenticated)/book/_lib/capacity-advisory.ts` — the pure per-night
  shortfall calculation and its member-facing sentence, lifted out of the wizard
  hook. It is the piece worth testing on its own, and it took 53 lines with it.
- `src/app/(authenticated)/book/_components/capacity-short-notice.tsx` — the
  "these dates will not fit your party" panel, which the guests step and the
  review step would otherwise each have carried their own copy of. Two copies of
  a privacy-shaped sentence is the arrangement in which one of them eventually
  drifts into naming a reason (`INV-SSOT-001`), and this is precisely the
  sentence that must never say why the lodge is full.
- `src/app/(authenticated)/book/_components/waitlist-alternate-lodges.tsx` — the
  cross-lodge opt-in (ADR-004), lifted out of the route shell so BOTH doors to
  the waitlist can render it. The fix round found that it lived inside the 409
  refusal prompt only, so the review step's new primary Join Waitlist never
  offered it; a second inline copy in the review step would have been two
  spellings of one option (`INV-SSOT-001`). Lifting it took 30 lines OUT of
  `page.tsx`, which is why that file's entry below shrinks rather than grows.

All three new modules are comfortably inside their own budgets. What is left is
growth that has nowhere else to go.

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2063
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
lines: 1035
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
  feature. The fix round added eleven lines: the cross-lodge opt-in arrives as a
  single `ReactNode` prop and is rendered beside the waitlist action, with the
  docblock saying why it is a node rather than three props — the lodge list and
  the opt-in state belong to the wizard hook, and this component is
  presentational.

file: src/app/(authenticated)/book/page.tsx
lines: 687
reason: twenty-two lines, and eighteen of them are prop wiring the shell exists
  to do — the advisory and waitlist state travelling from the hook to the two
  steps that render it. The remaining four are the waitlist prompt's copy fix and
  the comment on it. That comment is the only place in the tree that records the
  observable symptom this issue was found by: a hold-only refusal used to render
  as "is at capacity on 0 nights", because the server's night list skipped a held
  night whose available beds are pinned to 0 rather than negative. Splitting a
  route shell whose whole job is to assemble props would not make that shorter,
  only harder to find. The fix round made this file SHORTER than its base: the
  cross-lodge opt-in moved to its own component, and the shell now builds it once
  and hands the same element to both doors. The entry stays because the file is
  still over budget and still changed.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2360
reason: two eight-line night-list projections became one derivation used by
  both, plus the docblock that is the actual deliverable. The route answers TWO
  audiences from one capacity result — a member, who gets the nights and no bed
  numbers at all, and an admin override, who gets the confirmable over-capacity
  set with them — and the reason those are different lists is `INV-CAP-021` read
  from both ends: a held night is never negotiable, and never distinguishable.
  The derivation has to sit where `capacity`, `adminOverride` and
  `partnerSharedGuests` are all in scope, which is inside this handler; lifting
  it to a module would mean passing all three back out and would separate the
  rule from the only place it is applied. Nothing else in this file moved.

file: src/lib/group-settlement.ts
lines: 1262
reason: one line of code and eight of comment. The refusal's night list now
  comes from `getCapacityFullNights` instead of an inline filter, and the comment
  is the only record of the two defects that line had: it dropped every
  whole-lodge-held night from a list the ORGANISER reads, and it mapped a `Date`
  rather than a date-only string, so this single refusal put an instant on the
  wire where every other one emits a lodge night. A reader who does not know
  both will re-inline it.
