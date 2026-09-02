# File-size allowances for #3232 — the linked date move

Eleven files grow. Six grow by two to twenty-three lines because the compiler
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
also owns the pure construction of the quote) and
`booking-linked-date-move-service.ts` (the atomic move) are new modules INSIDE
their budgets, and keeping them there is not decoration — the gate refuses an
allowance for a new file outright, so arriving over budget is not a thing this
change could have declared its way out of. The pure predicate that belonged
beside the two where-builders it explains was moved into
`adult-member-hosting-same-owner.ts` rather than left in either.

file: src/lib/adult-member-hosting-review.ts
lines: 4368
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
lines: 2041
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
lines: 2003
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
lines: 2074
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
