# File-size allowances for #3232 — the linked date move

Ten files grow. Six grow by two to twenty-three lines because the compiler
made them: `hostingCoverageActorOptions` now takes the vacated stay window as a
**required** field, so every actor-driven hosting call site had to state whether
its change moved a booking's dates. That was the point — an optional field with
a convenient default would have left the three date writers exactly as wrong as
they were, silently, which is the failure #3116 already cost this repository
once. Those six are not candidates for a split: the growth is one field and its
reason at an existing call site.

The three real ones are `adult-member-hosting-review.ts`,
`booking-batch-modification-service.ts` and the config-transfer registry the new
club setting has to be listed in, and each has its reason below. The new
code that could stand alone already does: `adult-member-hosting-linked-move.ts`
(the offer contract) and `booking-linked-date-move-service.ts` (the atomic move)
are new modules inside their budgets, and the one pure predicate that belonged
beside the two where-builders it explains was moved into
`adult-member-hosting-same-owner.ts` rather than left here.

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
lines: 1966
reason: the hosting reconciliation becomes deferrable, so a caller composing two
  booking writes into one transaction can run the supervision check once over the
  state that will really commit. That is nine lines of code and the rest is the
  explanation of why no ordering avoids the intermediate state — move A first and
  A's seam refuses because B is stranded; move B first and B's own seam refuses
  because B has no adult. A reader who does not have that in front of them will
  eventually "simplify" the deferral away, and it lives at the seam it changes.

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
lines: 2050
reason: fourteen lines at its two hosting seams, supplying the window each edit
  has just vacated. This is the writer the whole defect turned on — it holds
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

file: src/app/api/bookings/[id]/confirm-draft/route.ts
lines: 391
reason: three lines at its one hosting seam, saying that confirming a draft does
  not move its stay. Required by the compiler.
