# File-size allowances for #3039 (GROUP-TRIP 3)

file: src/lib/adult-member-hosting-review.ts
lines: 3876
reason: THE SINGLE LIVE DECLARATION FOR THIS PATH ACROSS THREE EPIC CHILDREN.
  #3037 added one line here, #3038 added the third host scope's loader, and this
  child adds the Group Trip fan-out; all three diff against `main`, so the gate
  rightly refuses more than one number for one file and the last child's is the
  one that carries it. The earlier children's reasoning is kept as prose in their
  own fragments. As for #3039's own growth: the fan-out has to live inside the
  existing hosting seams, and that is the whole point of it —
  `reconcileAdultMemberHostingReviewWithSiblings`,
  `enqueueOwnHostingCoverageReevaluation` and, since the review round found the
  gap, `enqueueHostingCoverageReevaluationForMember` are the three doors the forty
  or so booking and membership writers already reach the rule through, so putting
  the fan-out there means a new writer cannot forget it (`INV-SSOT-001`). A
  separate module cannot hold it: it needs the engine's split-pair identity read,
  its participant-proof helpers and its coverage-facts types, and the engine must
  then call back into it, which is an import cycle. The growth is also mostly
  reasoning rather than logic — the executable additions are the plan, the
  lock-and-verify, the per-dependent enqueue and the third seam's loop, and the
  rest is the docblocks this repository asks for: why the per-trip key precedes the
  per-owner one and why the ORDER is not what makes it deadlock-free, why the
  cross-account path may refuse nothing, why a date move made the old
  night-narrowed dependent set strand a sibling silently, and why the membership
  seam owes the same fan-out. A split IS available, and is deliberately not taken
  here: it would mean lifting `hostingSiblingWhere`,
  `inheritedSplitPairGroupTrip` and `readInheritedSplitPairGroupTrip` into a new
  leaf module, which are #3038's freshly-landed code and are pinned by that child's
  "keeps the engine's newly-exported loaders inside the engine" census — a refactor
  of somebody else's just-merged surface, on the epic's highest-risk child, for a
  line count. The review round did push work OUT of this file rather than in:
  `coverageDependentEnvelopeAcrossNightsWhere` went to the envelope module, the two
  advisory-lock primitives collapsed from four to two in the lock module, and the
  fake booking store left three test files for one support module.

file: src/lib/group-settlement.ts
lines: 1254
reason: twelve lines, ten of them comment, and the code change is one argument.
  The organiser settlement loop calls the confirming hosting seam once per child
  inside ONE transaction, and every child's Group Trip fan-out enumerates every
  other child of the same trip — so a twenty-child settlement did twenty plans and
  wrote about three hundred and eighty queue rows while holding the global and
  per-lodge keys, because the trip ceiling bounds each fan-out and not the product.
  The fix is a `settledTripIds` set shared by the loop, so the trip's plan, key and
  item writes happen once. The comment says why that set is NOT `bestEffort` as
  well, which is the discriminator the next caller needs: a de-confirming
  transition may never skip its fan-out. Both belong at the loop that owns them;
  splitting a settlement that is one transaction from capacity check to
  confirmation would put the ordering rule and the statements it orders in
  different files. `size-allowances.d/3123-club-time-legacy-sites.md` also names
  this path, and that fragment has merged, so it is inert.

file: src/lib/cron-group-settlement-reaper.ts
lines: 752
reason: twelve lines, nine of them comment, and the same one-argument change as
  `group-settlement.ts` above for the same measured reason — the reaper reverts
  every child of one settlement inside one transaction, so the per-child Group Trip
  fan-out was O(n^2) reads and n-1 duplicate queue rows per sibling. The comment
  carries the half that is specific to this file and must not be copied wrongly:
  this revert is `CONFIRMED -> PAYMENT_PENDING`, which TAKES a coverage source
  away, so unlike the Xero PAID seam it may never degrade its fan-out to the cron —
  a contended trip must roll the whole pass back. That sentence has to sit at the
  call it governs; there is nothing to split.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1542
reason: seventeen lines, fourteen of them comment, and the code change is one
  option. This transaction claims a booking `PAID` for an invoice the club has
  ALREADY been paid, and its own existing comment says so in as many words — so it
  must not be refused. Since this change the confirming seam it calls also reaches
  ANOTHER account's rows (the trip key, and a `Member FOR KEY SHARE NOWAIT` fence
  over the sibling owners), both lost fail-fast, so a third party editing their own
  booking in the same trip could roll this transaction back. `bestEffort` degrades
  the cross-account half to the cron instead. The comment is the proof that this is
  safe HERE and nowhere a transition can remove cover — `CONFIRMED` and `PAID` are
  both eligible coverage sources and `PAYMENT_PENDING -> PAID` only adds one, so
  skipping can delay a favourable re-evaluation and can never strand anybody. A
  flag whose safety argument is not written at the call site is a flag the next
  caller copies onto a de-confirming path, which is exactly the defect this epic
  exists to prevent. There is nothing to split: the reasoning belongs at the one
  statement it justifies.
