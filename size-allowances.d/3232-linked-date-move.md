# File-size allowances for #3232 — the linked date move

Twelve files grow. Six grow by two to twenty-three lines because the compiler
made them: `hostingCoverageActorOptions` now takes the vacated stay window as a
**required** field, so every actor-driven hosting call site had to state whether
its change moved a booking's dates. That was the point — an optional field with
a convenient default would have left the three date writers exactly as wrong as
they were, silently, which is the failure #3116 already cost this repository
once. Those six are not candidates for a split: the growth is one field and its
reason at an existing call site.

The four real ones are `adult-member-hosting-review.ts`,
`booking-batch-modification-service.ts`, the config-transfer registry the new
club setting has to be listed in, and the `modify-dates` route that gains the
offer, and each has its reason below. The new code that could stand alone
already does: `adult-member-hosting-linked-move.ts` (the offer contract, which
also owns the pure construction of the quote), `booking-linked-date-move-service.ts`
(the atomic move), `booking-linked-date-move-preflight.ts` (the club's
change-fee answer, the settings and provider reads that must happen before the
transaction opens, and the budget and refusal belonging to that transaction) and
`booking-linked-date-move-arms.ts` (the three arms, over whichever
single-booking writer the surface runs) are new modules INSIDE their budgets, and
keeping them there is not decoration — the gate refuses an allowance for a new
file outright, so arriving over budget is not a thing this change could have
declared its way out of. The last two were split out when the completion
review's fixes took the service past its ceiling: the split is along the seams
the file's own headings already named, so the service file is the one procedure
it describes. The pure predicate that belonged
beside the two where-builders it explains was moved into
`adult-member-hosting-same-owner.ts` rather than left in either.

The twelfth is one line, and it is a line that REMOVES a duplicate rather than
adding a feature: `stuck-state-dashboard.ts` gains the import of the shared
officer-facing wording for an incident cause. The two officer surfaces had each
written their own phrase for the same stored value - "qualification changed" on
the bookings queue, "system change" here - and one of them had to be wrong the
moment a third cause was registered. Both now read from
`describeHostingCoverageIncidentCause`, so the file's own branch went away and
what is left is the import that replaced it.

file: src/lib/adult-member-hosting-review.ts
lines: 4450
reason: the same-owner dependent fan-out gains its plan/verify pair, the
  per-dependent queue items, the read-only stranding seam the offer shares with
  the refusal, and the disposition split that decides offer-versus-refuse.
  Splitting it was tried and rejected on evidence: every one of those needs
  private helpers of this module — COVERAGE_OWNER_FACTS_SELECT,
  inspectSameOwnerDependents, loadAdultMemberHostingPolicy, hostingModeIsActive,
  coverageNightsOf, the coverage-owner lock helpers — so a new module would have
  to import them back and this module would import the new one, a cycle around
  the code that decides whether a member's booking edit is refused. The whole
  point of #3232 is that the read direction and the enforcement direction must
  not drift apart; putting them in two files joined by a cycle is the arrangement
  most likely to let them.

file: src/lib/booking-batch-modification-service.ts
lines: 2201
reason: three changes at this one seam, and all three are about a caller that
  composes two booking writes into one transaction. The hosting reconciliation
  becomes deferrable, so the supervision check runs once over the state that will
  really commit — nine lines of code, and the rest is why no ordering avoids the
  intermediate state (move A first and A's seam refuses because B is stranded;
  move B first and B's own seam refuses because B has no adult). The deferred
  envelope-constraint flush is skipped for that same caller, because
  `SET CONSTRAINTS ... IMMEDIATE` applies for the remainder of the transaction and
  the first booking's flush made the triggers immediate for the second booking's
  writes — a measured 500 on a real database, so the paragraph explaining it is
  worth more than the line it guards. And `waiveChangeFee` arrives as a service
  argument rather than a request-body field, with the reason stated where somebody
  might otherwise "tidy" it into the input type and hand every member a fee
  waiver. All three live at the seam they change; a reader without them in front
  of them will simplify one of them away.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 514
reason: one schema field for the member's answer and one response branch for the
  offer. The policy it dispatches to — which refusals become an offer, what
  accepting means — is deliberately NOT here: it is
  modifyBookingWithLinkedMoveSupport, so a second date surface cannot make a
  second copy of the arm that either deadlocks a member or strands a booking.

file: src/components/edit-booking-panel.tsx
lines: 2085
reason: the offer is a THIRD refusal shape this one panel has to read, choose an
  answer to and put back on the retry, and the state machine it joins is already
  here — the quote, the exception offer and the officer's override prompt all
  retire against the same proposal signature. The reusable parts were extracted
  rather than added: the reader is `hosting-coverage-linked-move-client.ts`, the
  retire-on-change state is its own hook, and the offer itself is its own
  component. What is left in the panel is the wiring those three cannot own — one
  branch in `handleSave`, one guard in `handleSaveClick`, one render slot — and
  moving that out would mean threading the whole save closure through a fourth
  seam to save twenty lines.

file: src/lib/booking-date-modification-service.ts
lines: 2090
reason: fourteen lines at its two hosting seams supplying the window each edit
  has just vacated, plus the member's linked-move answer threaded to the seam
  that honours it — this writer owes the field because it owes the offer. This is the writer the whole defect turned on — it holds
  oldCheckIn/oldCheckOut in the same function that calls the seam — so the
  reasoning belongs at the call site rather than one indirection away.

file: src/lib/booking-cancel.ts
lines: 2423
reason: three lines at each of four hosting seams, saying that a cancellation
  removes a stay rather than moving it. Required by the compiler; there is
  nothing here to split.

file: src/lib/booking-guest-removal-service.ts
lines: 1331
reason: two lines at its one hosting seam, saying that removing a guest moves no
  dates. Required by the compiler.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1387
reason: two lines at its one hosting seam, saying that a guest change moves no
  dates. Required by the compiler.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1137
reason: the new club setting joins the travelling singleton beside the
  non-member hold, and the twelve lines are the field, its constraint and the
  reason it TRAVELS rather than staying deployment-local — the distinction this
  file exists to make, one entry at a time. The registry and its reasoning are
  the module.

file: src/app/api/bookings/[id]/modify-dates/route.ts
lines: 373
reason: the same two additions its `/modify` sibling took — one schema field for
  the member's answer, one response branch for the offer — plus the club-day
  resolution the accepted move needs before any transaction opens, and the
  paragraph saying why the answer is deliberately NOT one of the officer-authority
  flags this route gates on ADMIN (gating it that way would 403 the only person
  entitled to answer it). It has to be here rather than skipped: this route is one
  of the three writers that now supplies the vacated window, so it already
  NOTICES the stranded booking, and a door that noticed without offering would
  refuse moves that used to succeed. The policy itself is not here — all three
  arms are the shared `withLinkedMoveArms`, so the two doors cannot grow two
  copies of it.

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 391
reason: three lines at its one hosting seam, saying that confirming a draft does
  not move its stay. Required by the compiler.

file: src/lib/stuck-state-dashboard.ts
lines: 1143
reason: one line, and it is an import that deleted a branch. This file wrote its
  own phrase for an incident cause ("system change") while the bookings queue
  wrote a different one for the same stored value ("qualification changed"), and
  #3232 D3 registers a third cause that neither would have named. The wording now
  has one home and this file calls it, so the ternary went and the import came -
  net one line, in the direction of less duplication (`INV-SSOT-001`,
  `INV-HOST-052`). Splitting a 1143-line aggregator over one import line would be
  the definition of churn; the file's real size debt is its twenty-odd
  independent stuck-state probes and is untouched by this change.

file: src/lib/booking-exception-approval.ts
lines: 1095
reason: twenty lines, and nineteen of them are the reason for the one. The
  approval is the other caller that hands `modifyBookingBatch` its own
  transaction, so it owes the same pre-transaction value the linked move does —
  the club's member-guest policy, its subscription-lockout mode and the Xero
  organisation's lock dates, resolved by the route before the transaction opens
  and threaded in on the context beside the club day that is already there for
  exactly this reason. The field is required rather than optional so the compiler
  enumerates the callers, which is what found the two test fixtures. Its neighbour
  paragraph, which claimed this was the ONE path supplying a caller transaction,
  is corrected in the same edit: #3232 made it two, and a docblock asserting
  otherwise is how the next reader concludes the exposure cannot reach them.

file: src/app/api/admin/booking-exception-requests/[id]/route.ts
lines: 769
reason: thirteen lines, one call and its reason. This route is the last position
  on the approve-and-execute path that is outside a transaction, which is why the
  club day is already resolved here; the batch modification's own settings and
  provider reads have to be resolved in the same place and for the same reason
  (`INV-LOCK-004`). Splitting a 769-line handler over one pre-transaction call
  would move the call away from the club-day resolution it belongs beside, which
  is the one thing a reader needs to see together.

file: src/lib/booking-modify-plan.ts
lines: 2883
reason: eleven lines at one throw site, and ten of them say why the class
  matters. The member-path capacity refusal is now
  `InsufficientCapacityError` — the same 400 with the same sentence, so nothing
  on the wire changed — because the linked move decides its "there are not beds
  for both" arm by asking the refusal what kind it is, and this is the only
  capacity refusal a member can ever receive. As a bare `ApiError` it was
  indistinguishable from a minimum-stay block, so that arm was unreachable and a
  full lodge refused the member with no door at all. The comment is at the throw
  because that is where somebody would otherwise "simplify" the class back to an
  `ApiError`.
