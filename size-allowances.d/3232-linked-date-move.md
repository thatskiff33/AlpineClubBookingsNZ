# File-size allowances for #3232 — the linked date move

**The entries below are the list of files that grow, and no sentence here
restates how many.** This paragraph used to open "twelve files grow", which was
wrong three ways at once: the entry list already held fifteen, the paragraph's
own breakdown accounted for eleven of the twelve it claimed, and the completion
and fix rounds then added more. A count restated in prose beside a list that
already carries it is a number nobody maintains — `npm run quality:budget`
prints the real figure from the entries. What follows describes the *shapes*.

**Most of the growth is two to twenty-three lines the compiler demanded.**
`hostingCoverageActorOptions` now takes the vacated stay window as a
**required** field, so every actor-driven hosting call site had to state whether
its change moved a booking's dates. That was the point — an optional field with
a convenient default would have left the date writers exactly as wrong as they
were, silently, which is the failure #3116 already cost this repository once.
Those entries are not candidates for a split: the growth is one field and its
reason at an existing call site. (No count of the date writers appears here
either. It was published as "three" in three places and there are four; the
compiler is the proof and `adult-member-hosting-call-sites.test.ts` is the one
place a figure lives.)

**The substantive entries each carry their own reason below.** The new code that
could stand alone already does: `adult-member-hosting-linked-move.ts` (the offer
contract and the pure construction of the quote),
`hosting-coverage-linked-move-client.ts` (the browser contract, which since the
fix round also owns the sentences BOTH sides say),
`booking-linked-date-move-service.ts` (the atomic move),
`booking-linked-date-move-preflight.ts` (the club's change-fee answer and the
settings and provider reads that must happen before the transaction opens),
`booking-linked-date-move-arms.ts` (the three arms, over whichever
single-booking writer the surface runs), `use-retired-prompt.ts` (the shared
retire-on-change hook) and `booking-night-overlap.ts` (the in-memory night
overlap, in a module with no imports) are new modules INSIDE their budgets, and
keeping them there is not decoration — the gate refuses an allowance for a new
file outright, so arriving over budget is not a thing this change could have
declared its way out of.

**One file was SPLIT rather than declared, and the gate is why.**
`booking-history.ts` sat at exactly its 700-line ceiling, and the final fix round
had to add a required `audience` argument to `buildBookingHistoryItems` — the
thing that makes "only staff read an officer's private override reason"
unrepresentable instead of policed by a query in a page a hundred and seventy
lines away. An allowance cannot carry a file over its budget for the FIRST time,
which is the gate's own rule and the right one: a file still inside its budget has
the cheapest possible split available to it. So the narrative half moved out to
`booking-history-modification-narrative.ts` — how one stored `BookingModification`
row is turned into a sentence, which is a different job with a different reason to
change from deciding which events appear on a timeline and for whom, and which is
the half that grows every time the modification service learns to record something
new. It owns the row shape it reads rather than importing it back, so there is one
declaration of what a modification row contains (`INV-SSOT-001`). The builder came
out at 629 lines and the new module at 119; neither needs an allowance.

`stuck-state-dashboard.ts` grows by one line, and it is a line that REMOVES a
duplicate rather than adding a feature: it gains the import of the shared
officer-facing wording for an incident cause. The two officer surfaces had each
written their own phrase for the same stored value — "qualification changed" on
the bookings queue, "system change" here — and one of them had to be wrong the
moment a third cause was registered. Both now read from
`describeHostingCoverageIncidentCause`, so the file's own branch went away and
what is left is the import that replaced it.

file: src/lib/adult-member-hosting-review.ts
lines: 4473
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
  most likely to let them. The fix round added the twenty-three lines that make
  "can this stranding be answered by a shift" ONE named local read by both
  refusal throws, instead of computed at one and hard-coded `true` at the other.

file: src/lib/booking-batch-modification-service.ts
lines: 2402
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
  of them will simplify one of them away. The completion review added a fourth,
  and it is the one that had to be here: everything this service must read BEFORE
  its transaction is now one named function, and the service REFUSES a caller
  transaction that did not call it (`INV-LOCK-004`). Code above
  `withOptionalTransaction` reads as "before the transaction" and is false for a
  caller that supplies one — so three reads, one of them a live HTTPS request to
  Xero, were running under the global money key and the lodge capacity key. The
  paragraph saying that is what stops the next reader concluding the position is
  safe because it looks safe. The fix round added a fifth, twenty-eight lines
  including its reason: a waived change fee was an unmarked zero, so the row, the
  audit and the Xero leg could not tell "no fee was due" from "we waived it
  because our own supervision rule compelled this move". The marker belongs at
  the one line that decides the fee and the two writers that record it. The final
  fix round added three more, each at the same seam and each the answer to a defect
  a delta review found in this file's own contract. The service now says on its
  RESULT whether the settlement needed a card-or-credit choice, because a caller
  reading that off the resolved amounts disagreed with the refusal this service
  raises — an OR over both refund options — and the disagreement deadlocked the
  member on every retry. The waiver marker moved off the request flag and onto the
  fee that was really suppressed, which needed the fee calculated before it is
  zeroed. And the pre-transaction value a caller-supplied transaction must hand in
  is now branded and minted by one function that takes no candidate check-ins, so
  the lock-date facts cannot be resolved from a set that does not contain the
  booking they will judge; a comment asking nobody to do that was the only thing
  stopping it. All three are contract changes at the one seam they govern.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 514
reason: one schema field for the member's answer and one response branch for the
  offer. The policy it dispatches to — which refusals become an offer, what
  accepting means — is deliberately NOT here: it is
  modifyBookingWithLinkedMoveSupport, so a second date surface cannot make a
  second copy of the arm that either deadlocks a member or strands a booking.

file: src/components/edit-booking-panel.tsx
lines: 2127
reason: the offer is a THIRD refusal shape this one panel has to read, choose an
  answer to and put back on the retry, and the state machine it joins is already
  here — the quote, the exception offer and the officer's override prompt all
  retire against the same proposal signature. The reusable parts were extracted
  rather than added: the reader is `hosting-coverage-linked-move-client.ts`, the
  retire-on-change state is now the SHARED `use-retired-prompt.ts` hook (the
  fix round's own de-duplication), and the offer itself is its own component.
  What is left in the panel is the wiring those three cannot own — one branch in
  `handleSave`, one guard in `handleSaveClick`, one render slot — and moving that
  out would mean threading the whole save closure through a fourth seam to save
  twenty lines. The fix round added the Return-method control for the case where
  the OTHER booking's price falls and this booking's own quote asks for no
  choice, with the paragraph saying why it stays in the panel rather than moving
  inside the offer component (the answer travels as a top-level payload field
  injected after the proposal signature is captured, which the component cannot
  reach), and the two lines that gate Save on the chosen arm and announce the
  bottom error slot.

file: src/lib/booking-date-modification-service.ts
lines: 2090
reason: fourteen lines at its two hosting seams supplying the window each edit
  has just vacated, plus the member's linked-move answer threaded to the seam
  that honours it — this writer owes the field because it owes the offer. This is
  the writer the whole defect turned on — it holds oldCheckIn/oldCheckOut in the
  same function that calls the seam — so the reasoning belongs at the call site
  rather than one indirection away.

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
  of the writers that now supplies the vacated window, so it already NOTICES the
  stranded booking, and a door that noticed without offering would refuse moves
  that used to succeed. The policy itself is not here — all three arms are the
  shared `withLinkedMoveArms`, so the two doors cannot grow two copies of it.

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
lines: 770
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

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2716
reason: thirteen lines, and they are what makes D3 true. The decision D3 records
  is justified by an officer reading the booking's history, and they could not:
  the incident's audit row set no `targetId`, which is exactly what this page's
  history query filters on, and the action was not in its allowlist. So an
  officer following the queue's "Review booking" button saw the generic cause and
  nothing else, and guessed. The two actions join the allowlist BEHIND
  `canSeeAdminTools`, because `details` can be an officer's private override
  reason and this page is read by the booking's own member — the data feed is
  gated rather than the render, which is the pattern #2008's duplicate-capture
  rows on this same page already follow, and the comment is at the gate because
  that is what stops the next reader "simplifying" it into the shared list.
  Splitting a 2711-line page over a thirteen-line query addition would move the
  gate away from the `canSeeAdminTools` definition and the sibling gated reads it
  belongs beside.

file: src/lib/policies/adult-member-hosting.ts
lines: 991
reason: twenty-six lines, twenty-two of which are the reason for the four. There
  were three spellings of "can a same-owner stranding refuse the actor, or only
  escalate" — the settle path's literal `ADMIN_REVIEW_REQUIRED`, the offer's
  read-only probe on `mode !== "ENFORCED"`, and the wider active pair the plan
  they share gates on. They agree today, which is what made it dangerous:
  extending the refusal in one of them makes the probe return an empty list, so
  the caller raises a 409 naming nobody, the browser's fail-closed reader
  discards it, and the member gets a body no reader matches. The predicate
  belongs beside `hostingModeIsActive`, which answers the WIDER question, so a
  reader meets both distinctions together; anywhere else and it is a mode
  predicate living away from the module that owns mode semantics.
