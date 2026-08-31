# File-size allowances for #3038 (epic #2943)

file: src/lib/adult-member-hosting-review.ts
lines: 2979
reason: TWO CHILDREN OF ONE EPIC, ONE DECLARATION. #3037 added a single line
  here — the new host-scope column in the policy loader's narrowed `select`,
  which the call-site census pins to the schema because an omitted column hands
  the resolver `undefined` and quietly widens or narrows a lodge's rule with a
  green typecheck. Both children diff against `main`, so its allowance and this
  one are live together and the gate rightly refuses two numbers for one file;
  #3037's fragment now carries that reasoning as prose and this is the single
  live declaration. As for #3038's own growth: this file is the ONE place in the product that turns a persisted booking
  into evaluator input, and a third host scope is a third loader beside the two
  already here. Splitting it would put `loadSameGroupTripHosts` in a module of
  its own while `loadSiblingHosts` and `loadSameBookingOwnerHosts` stayed — and
  the whole correctness argument for the new one is that it is the SAME SHAPE as
  its siblings, right down to returning the ids the next scope must exclude. A
  reader who cannot see the three side by side cannot check that. The
  deduplication chain is likewise a property of the call site where all three
  meet, not of any one loader. Most of the growth is that reasoning: why the
  cross-booking sources are host-only, why the exclusion is a query clause
  rather than a post-filter, and why the per-owner advisory lock deliberately
  does NOT widen to cover a scope whose sources belong to other members (#3039
  owns the per-group key). The file's existing length is #3128's business rather
  than this change's. Review then added sixty-three lines more, and they are the
  reason a second evaluator now gets the split-pair carve-out RIGHT rather than
  a second copy of it: `readInheritedSplitPairGroupTrip` is the same
  `hostingSiblingWhere` set through the same `inheritedSplitPairGroupTrip`, for
  a caller that holds no sibling rows. Putting it anywhere else would be the
  third answer to "what group is this booking in?", which is exactly what
  `INV-SSOT-001` forbids; the rest is the docblock explaining why the carve-out
  reaching only one of the two evaluators is a disagreement rather than a
  smaller version of the same answer, and why the parameter type is the fence's
  primary structural guard.

file: src/lib/diagnostics/tools/packs/booking-evidence.ts
lines: 2219
reason: thirty-one lines, and twenty-five of them are the docblock on a third
  ceiling constant. The evidence pack is where a bounded read's failure
  direction INVERTS — a writer's truncation errs towards the rule, a
  diagnostic's fabricates a live blocker on a covered booking — and the third
  population is the first one whose bind means "this trip is big" rather than
  "this account is misshapen". That distinction has to sit beside the other two
  or the next person to add a ceiling copies the wrong number; splitting the
  constants away from the single evidence read they parameterise would separate
  them from the only call site that can explain them.

file: src/lib/group-booking.ts
lines: 1865
reason: thirty-five lines, thirty of them comment, and the code change is a
  MOVE rather than an addition: the `GroupBookingJoin` roster write now happens
  immediately after the joiner's booking is created instead of at the end of the
  same transaction. That ordering is load-bearing and invisible — the row IS the
  booking's Group Trip identity, so reconciling hosting before it is written
  evaluates the joiner as belonging to no Group Trip — and the explanation has
  to be at the statement, inside the transaction, where somebody tidying the
  block will read it. The remaining lines are the member join passing the
  container id it already holds to its own preflight. Splitting a join flow that
  is one transaction from top to bottom would put the ordering rule and the
  statements it orders in different files.

file: src/lib/booking-exception-request-service.ts
lines: 2253
reason: fifty-four lines, forty of them the reason. This file already carried
  `resolveProposalBookingOwner` and `resolveProposalOperationalPresence` — two
  functions that exist solely because a modification proposal must be re-judged
  against the SAME facts the booking path judged, and the second one's docblock
  says in as many words that "without this half a modification proposal would
  raise a violation for a party the booking path allows". #3038 gave adult-member
  hosting a third such fact and this adds the third resolver,
  `resolveProposalGroupTrip`, beside its two siblings. Splitting it out would put
  one member of a three-part set in another module while the two it exists to
  match stayed here, and the pattern is only legible when a reader sees all three
  in a row. Most of the added length is the hazard: this evaluation is FROZEN
  into the request, shown to an officer as a live violation, used under `HOLD` to
  reserve beds, and then reproduced at approval — so the #2525 drift gate
  compares a phantom with itself and nothing downstream can catch a violation
  invented here. That is the sentence the next person to add a proposal input
  needs, and it belongs at the function. Review added sixty-seven lines on top,
  and they NET OUT one database read: the owner resolver and the Group Trip
  resolver were each `findUnique`-ing the same booking id, so they now share one
  `PROPOSAL_BOOKING_SELECT` — which is also the only place `parentBookingId` can
  be selected, without which this path structurally could not apply the
  split-pair carve-out the persisted evaluator applies. The added prose is that
  hazard stated once, at the resolver: for a split child, and only for a split
  child, identity resolved from the two canonical relations alone is `null`, so
  the two evaluators would disagree about precisely the booking the carve-out
  exists for.

file: src/lib/booking-create.ts
lines: 1969
reason: seventeen lines, and the code change is a MOVE: the `GroupBookingJoin`
  roster write now happens before the #738 split child is created rather than
  after it. The ordering is load-bearing and invisible — that row IS the
  booking's Group Trip identity, and the split child is reconciled against the
  hosting rule the instant it is written, so with the write last the half
  carrying the party's NON-MEMBER guests was recorded as uncovered while every
  later evaluation of it found the cover. The rest is the comment saying so, and
  it has to sit at the statement, inside the transaction, where somebody tidying
  the block will read it. `verifyAndCreateNonMemberJoin` already orders itself
  this way for the same reason; this makes the two join paths agree. Splitting a
  creating transaction that is one sequence from capacity to reconciliation would
  put the ordering rule and the statements it orders in different files.

file: src/app/api/bookings/route.ts
lines: 1383
reason: nine lines, one of them code. #3038 made
  `evaluateProposedAdultMemberHosting`'s `groupBookingId` REQUIRED rather than
  optional, precisely so the compiler enumerates every call site and each has to
  state its answer out loud — the previous arrangement let this route's omission
  read as "no Group Trip" silently, which is the class of defect that produced
  the blocker this pull request fixes. This route's answer is `groupBookingId:
  null`, and the eight comment lines are why that is an answer and not a
  placeholder: the route creates ordinary bookings, has no join path, and an
  organiser's own booking has no container either. Deleting the note would make
  the literal look like something to fill in later.

file: src/lib/email/booking.ts
lines: 1505
reason: eight lines, all comment, no code. `sendHostingCoverageLostEmail`'s
  docblock justified pointing the recipient at their own booking on the premise
  that "the cover that went away was on their own account (#2576 §11)". Under
  `SAME_GROUP_TRIP` that premise is false — the stay is on another member's
  account — while the conclusion still holds for a different reason: the message
  names nobody, and the link is to the RECIPIENT'S own booking. An invariant or a
  docblock that asserts a rationale which no longer covers the live behaviour is
  worse than one that says nothing, because the next change deletes the right
  behaviour for the stated wrong reason. The correction has to be at the function
  it justifies; there is nothing to split.
