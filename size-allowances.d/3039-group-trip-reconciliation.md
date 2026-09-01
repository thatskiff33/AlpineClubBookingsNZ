# File-size allowances for #3039 (GROUP-TRIP 3)

file: src/lib/adult-member-hosting-review.ts
lines: 3456
reason: the Group Trip fan-out has to live inside the two existing hosting
  seams, and that is the whole point of it — `reconcileAdultMemberHostingReviewWithSiblings`
  and `enqueueOwnHostingCoverageReevaluation` are the two doors the thirty-odd
  booking writers already reach the rule through, so putting the fan-out there
  means a new writer cannot forget it (`INV-SSOT-001`). A separate module cannot
  hold it: it needs the engine's split-pair identity read, its participant-proof
  helpers and its coverage-facts types, and the engine must then call back into
  it, which is an import cycle. The growth is also mostly reasoning rather than
  logic — of the 477 lines, 200 are executable and 264 are the docblocks this
  repository asks for, including why the per-trip key precedes the per-owner one
  and why the cross-account path may refuse nothing. A split IS available, and is
  deliberately not taken here: it would mean lifting `hostingSiblingWhere`,
  `inheritedSplitPairGroupTrip` and `readInheritedSplitPairGroupTrip` into a new
  leaf module, which are #3038's freshly-landed code and are pinned by that
  child's "keeps the engine's newly-exported loaders inside the engine" census —
  a refactor of somebody else's just-merged surface, on the epic's highest-risk
  child, for a line count.
