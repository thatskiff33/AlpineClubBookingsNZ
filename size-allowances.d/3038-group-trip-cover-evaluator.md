# File-size allowances for #3038 (epic #2943)

file: src/lib/adult-member-hosting-review.ts
lines: 2814
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
  than this change's.

file: src/lib/diagnostics/tools/packs/booking-evidence.ts
lines: 2209
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
