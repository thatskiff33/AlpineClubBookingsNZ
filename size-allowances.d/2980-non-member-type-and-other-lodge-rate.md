# File-size allowances for #2980

Nine already-over-budget files grow here. None of them gains a new concern — each
gains the *rate-based* form of a rule it already carried in `isMember` form, and
in four of them the growth is mostly the reasoning behind an owner decision that
had to be written down where the next reader will meet it.

**One clean file was split rather than ratcheted**, which is the standard this
list should be read against: the other-lodge control came out of
`edit-guests-card.tsx` into `other-lodge-rate-control.tsx` when that file reached
706 against its 700 budget, so it carries no debt at all.

file: src/lib/membership-type-policy.ts
lines: 1344
reason: this is the change. The offer rule and the #2543 reprice rule now sit
  side by side as two functions over one shared core, because the owner's
  decision turns entirely on their being distinguishable — TYPE_POLICY_FORCED
  gets the tick, NON_MEMBER_DEFAULT via lockout does not. Splitting them into
  separate files is the specific mistake that would let the two drift, and the
  drift is a money outcome. Roughly half the growth is the docblock explaining
  which is which and why.

file: src/lib/booking-modify-plan.ts
lines: 2367
reason: the flag must now follow what pricing actually charged rather than what
  the election asked for, which means the plan carries the priced result through
  to the write. That is a data path within one existing function's remit; moving
  it out would put the decision and the write it guards in different files.

file: src/lib/booking-batch-modification-service.ts
lines: 1478
reason: the quote-priced exemption for an election-only edit (owner decision,
  21 Aug 2026) belongs beside the other three exemptions it is modelled on. A
  fifth file holding one of five sibling rules is harder to reason about than
  the fifty lines it would save.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2331
reason: the preview must agree with the save by construction, so its
  hand-written exemption list was replaced by a call to the shared predicate.
  The net is still growth because the eligibility resolution and its
  admin-gating comment moved in. This route is a long-standing split candidate
  in its own right and is not made materially worse here.

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2572
reason: resolves the eligible-guest set server-side and ships it to the panel
  behind the admin-only spread, so a read-only viewer never receives a list that
  encodes subscription standing. That gating has to happen where the payload is
  assembled.

file: src/components/edit-booking-panel.tsx
lines: 1879
reason: threads the eligibility list from the page to the guests card. Prop
  plumbing through the component that already owns every other edit-booking
  prop; a new intermediate component would add a layer to avoid ten lines.

file: src/app/(admin)/admin/members/[id]/page.tsx
lines: 1350
reason: the member record must not contradict the roster. This resolves the same
  non-member fallback name the list now shows, in the two places the detail page
  states a membership type. Adjacent to page.tsx.

file: src/app/(admin)/admin/members/page.tsx
lines: 606
reason: fetches the club's membership types once and hands them to both the
  toolbar and the table. The alternative — each calling the hook for itself —
  costs a second identical admin request on every page load.

file: src/lib/policies/pricing.ts
lines: 831
reason: six lines. A comment correcting a statement that is no longer true —
  OTHER_LODGE_MEMBER is no longer reachable only by a non-member — in the file
  that states the rate-source contract.
