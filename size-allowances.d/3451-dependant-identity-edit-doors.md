# File-size allowances for #3451 (own-dependant identity on the edit doors)

Five already-over-budget files grow. **The seams that existed were taken first**,
which is why each growth is a call site and its comment rather than logic:

- `src/lib/booking-dependant-identity.ts` gained the one server entry point every
  door calls (`checkOwnDependantIdentityForParty` — create, both exception
  doors, the approval and the edit doors) and the code predicate, and the new
  `src/lib/booking-dependant-identity-doors.ts` holds the per-door wording, the
  voice decision and the rename/answer helpers — so no route spells the skip
  rule, the read or the wording for itself. Both are inside their budgets.
- The edit panel's half is a new hook (`use-edit-dependant-identity.ts`) and a
  new component (`edit-dependant-identity-question.tsx`), both far inside their
  budgets, and the question itself is drawn by the create screens' OWN
  components, not a copy.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2437
reason: one local guard helper, called twice: before the name-fix-only and
  credit-only echoes (so preview and save cannot disagree about an answer) and
  before the member resolution, against the ids the party claims (so its answer
  never says whether another claimed id is a real member). Both positions are
  decided by this handler's own order — after its owner-or-admin 403 — and
  splitting the helper out would hide that order, which is the contract.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 551
reason: the request schema gains the answers field, the date-only override list
  gains it, and the catch chain gains one branch turning the guest planner's
  refusal into the create route's body. All three belong beside their siblings:
  the schema and override list are the route's whole input contract, and the
  catch chain is ordered — the branch must precede the generic ApiError one.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1704
reason: the guard has to run inside this route's transaction, after its
  owner-or-admin 403 and before its member lookup, and both of those positions
  exist only here. The catch-chain branch that answers it sits with the route's
  other ordered refusal branches.

file: src/lib/booking-modify-plan.ts
lines: 3191
reason: the save half of the guard sits directly before the planner's member
  resolution, because that is the only position on the save path that is after
  the service's ownership check and before the lookup (whose collapsed refusal
  the guard must not out-run), the person-night guard and every write. The
  comment records why the ordering is a privacy property, which a reader would
  otherwise "tidy" back below the lookup.

file: src/components/edit-booking-panel.tsx
lines: 2193
reason: the panel owns the added-guest state, the payload builder, the debounced
  quote and the save handler, and the answers have to reach all four. The logic
  was moved out to the new hook and component; what is left is the wiring — the
  hook call, one payload field, one callback to the quote hook, one branch in the
  save refusal handler and the component in the guests card's new slot.

file: src/app/api/bookings/[id]/exception-requests/route.ts
lines: 315
reason: the request schema gains the answers field and the call hands the
  service the booking owner and the answers. The schema is the door's whole
  input contract and the owner is read from the booking this handler already
  loaded; there is nothing to move out.

file: src/lib/booking-exception-request-service.ts
lines: 2424
reason: the edit's exception request asks the own-dependant question about the
  guests it adds, before the member lookup, and freezes the answers beside the
  delta. Both belong inside `createModificationExceptionRequest`, beside the
  create-door path, because they must run before the proposal is frozen and
  write into the same requestedChanges document the approval reads back.

file: src/lib/booking-exception-approval.ts
lines: 1245
reason: the approval reads the frozen answers in the same row read that
  verifies the delta, replays them with it, and translates the planner's
  refusal into the officer's send-it-back refusal. Each is a few lines beside
  the code it extends; splitting would separate the delta from the answers that
  travel with it.
