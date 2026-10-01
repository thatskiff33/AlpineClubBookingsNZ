# File-size allowances for #3451 (own-dependant identity on the edit doors)

Five already-over-budget files grow. **The seams that existed were taken first**,
which is why each growth is a call site and its comment rather than logic:

- `src/lib/booking-dependant-identity.ts` gained the one server entry point every
  door calls (`checkOwnDependantIdentityForParty`), the shared refusal body, the
  standalone door's pointer sentence and the code predicate — so no route spells
  the skip rule, the read or the wording for itself.
- The edit panel's half is a new hook (`use-edit-dependant-identity.ts`) and a
  new component (`edit-dependant-identity-question.tsx`), both far inside their
  budgets, and the question itself is drawn by the create screens' OWN
  components, not a copy.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2407
reason: one guarded call and the hoisted set of member ids that really resolved.
  It cannot leave this handler, because everything it reads is decided here and
  nowhere else: the resolved ids come out of the member resolution twenty lines
  above, the owner-or-admin 403 must already have run (or the refusal would
  answer a stranger's question about another member's family), and whether the
  reader is an officer acting for the member is this handler's local flag. Its
  position — after the resolution's collapsed D-8 refusals, before pricing — is
  the contract, and splitting it out would hide that order.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 544
reason: the request schema gains the answers field, the date-only override list
  gains it, and the catch chain gains one branch turning the guest planner's
  refusal into the create route's body. All three belong beside their siblings:
  the schema and override list are the route's whole input contract, and the
  catch chain is ordered — the branch must precede the generic ApiError one.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1692
reason: the guard has to run where this route resolves its members, inside the
  transaction and after the owner-or-admin 403, and it must use the set of ids
  that really resolved, which exists only there. The catch-chain branch that
  answers it sits with the route's other ordered refusal branches.

file: src/lib/booking-modify-plan.ts
lines: 3181
reason: the save half of the guard sits directly after the planner's member
  resolution, because that is the only place the ids that really resolved exist
  on the save path and the only position that is after the D-8 refusals and
  before the person-night guard and every write. The comment records why the
  approved policy-exception replay is skipped, which a reader would otherwise
  "fix" into a refusal at approval of a guest already answered for.

file: src/components/edit-booking-panel.tsx
lines: 2167
reason: the panel owns the added-guest state, the payload builder, the debounced
  quote and the save handler, and the answers have to reach all four. The logic
  was moved out to the new hook and component; what is left is the wiring — the
  hook call, one payload field, one callback to the quote hook, one branch in the
  save refusal handler and the component in the guests card's new slot.
