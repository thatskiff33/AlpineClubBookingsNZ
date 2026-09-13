# File-size allowances for #2698 — whole-lodge holds exclude custodian beds

Four already-over-budget files grow, and **two splits were taken rather than
allowed for.**

`src/app/api/admin/hut-leaders/[id]/route.ts` was sitting exactly ON its 250-line
ceiling, so an allowance could not have covered it and should not have: a file
still inside its budget has the cheapest possible split available to it. Both of
its locked transactions moved to
`src/lib/hut-leader-assignment-service.ts` — the edit and the delete, each with
the lock order and the reasoning for it — and the route came back to 238 lines,
inside its budget, holding what a route is for: authorisation, parsing, deriving
the update from the request, and turning a refusal into a response. The three
near-identical audit rows moved the same way, to
`src/lib/hut-leader-assignment-audit.ts`, which also gives the `lodge` category
decision one home to be changed in. Both new modules are comfortably inside
their own budgets, and the create route shares the service's bed-hold helper, so
the ordering question cannot drift between create and edit.

The four growths left have no seam that would make the code easier to follow.
A Next.js route module may only export route handlers, so the create cannot be
split by line count; the two library files each gained a rule that belongs
beside the rule it qualifies; and the admin page gained the second of two
deliberately identical cards.

file: src/app/api/admin/hut-leaders/route.ts
lines: 398
reason: the create's half of the #2698 ordering case — the amendment detection
  (through the service helper the edit shares), the decline-by-default refusal,
  the conditional global cohort key ahead of the lodge key, and the audit row
  this writer never had. It stays in the handler because this transaction also
  mints a kiosk PIN and sends an email after commit, so pulling only its middle
  out would split one flow across two files without shortening either
  meaningfully; and the lock ORDER is asserted over this handler's own body by
  `lodge-admission-lock-contract.test.ts`, which is where a reader should find
  it. About a third of the growth is the comments saying which counterpart each
  key excludes, which is the part a future reader cannot infer. The review
  round added the conjunct that keeps a bedless request out of the club-wide
  cohort, with the reason at the gate.

file: src/lib/capacity.ts
lines: 1132
reason: `wholeLodgeHoldRepresentedBeds` and `wholeLodgeHeldNightOccupiedBeds`
  are eight lines of arithmetic and about seventy of docblock, and the docblock
  is the deliverable. The pin they replace read `lodgeCapacity` and was correct
  by luck; it is now composed from the hold's represented beds plus the
  custodian beds it excludes, which is the same number and a different claim,
  and the next person to read it will otherwise "simplify" it straight back.
  They sit beside `buildWholeLodgeHoldIndex` because they qualify that term and
  nothing else, and moving them out would separate the rule from the term it is
  about. The rest is the `custodianBeds` field on `NightOccupancy` and the three
  pin sites' comments.

file: src/lib/bed-allocation-lifecycle.ts
lines: 2534
reason: four lines. The planner feed gains the custodian-hold argument the
  exclusion needs, plus the three-line comment saying it is deliberately the
  same hold set the custodian expansion above it was built from — which is the
  property that makes no bed-night claimed twice true rather than coincidental.

file: src/app/(admin)/admin/hut-leaders/page.tsx
lines: 1357
reason: the officer's Accept/Decline card for the ordering case, its state, its
  focus effect, and the two request paths that can raise it (the create form's
  POST and the inline bed change's PUT). It is written beside the existing
  over-capacity card it deliberately mirrors — same `role="alert"`, same focus
  treatment, same ViewOnlyActionButton gating — and roughly half the growth is
  the two handlers threading one more optional flag through. Extracting it would
  put the second of two visually and behaviourally identical cards somewhere
  else, which makes the page harder to read, not easier, and neither card can
  move into `assignment-form.tsx`: that component is presentational and does not
  see the PUT path at all. The review round added the delete's refusal message,
  which had been silent, and the two lines that dismiss whichever card the other
  replaces.
