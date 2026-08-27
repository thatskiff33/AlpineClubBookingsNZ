# Booking Policy Exceptions

Audience: Developer, Agent.

Prefix defined in this file: **`INV-EXCEPT`** — the durable member-request
and officer-decision flow for eligible SOFT booking-policy failures.

Read this file when you are changing how a member asks for a policy exception,
what a request freezes, or how a Booking Officer approves, declines or executes
one.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines and the bracketed cross-file `[INV-*]` pointers
registered in the PR were added.

## Booking-policy exception requests (#2365, epic decision D-R5)

### INV-EXCEPT-001

The durable member-request + admin-decision flow for eligible SOFT policy
failures. It NEVER covers a hard failure — whole-lodge capacity, invalid/past
dates, authentication, subscription/membership eligibility, duplicate
member-night, payment, privacy or data-integrity — which stay firm refusals
(the #2363 allowlist is the only thing that can enter review). These invariants
hold over the store (`BookingChangeRequest`, `kind = POLICY_EXCEPTION`) and the
pure workflow logic (`src/lib/booking-exception-requests.ts`):

- **The proposal is immutable and self-proving.** A request freezes the complete
  proposal — the whole proposed booking for a new-booking request, the live base
  footprint AND the full proposed result for a modification — and a SHA-256
  `proposalHash` over its canonicalised form (recursively key-sorted JSON, sorted
  and de-duplicated per-guest nights, content-ordered guests). The hash is
  order-independent, so re-freezing the same facts is byte-identical, and it
  changes if any night, guest or — for a modification — the live base drifts. An
  approval recomputes it to prove it is executing exactly what was reviewed.

### INV-EXCEPT-004

- **The evidence is frozen and authoritative.** `frozenEvidence` is the #2363
  aggregate — every covered structured violation with its reason code, policy
  id/version, resolved scope, exact affected NZ nights, requirements and frozen
  per-policy capacity mode — plus the HOLD-if-any-HOLD aggregate. An approval may
  override ONLY these reviewed violations, and nothing that is not on the #2363
  allowlist can be stored (`freezePolicyExceptionEvidence` refuses it).

### INV-EXCEPT-005

- **A held request's provisional reservation is per-night and directional.**
  Today only the MODIFICATION path writes a reservation; a modification request
  reserves ONLY the incremental beds beyond a capacity-holding live booking
  (`max(0, proposed - live)` per night, because that live booking already holds
  its own footprint and #2365 forbids touching it before approval), OR the FULL
  proposed footprint when the live base is **not** capacity-holding (a
  DRAFT / generic PENDING / un-held PAYMENT_PENDING / WAITLISTED / BUMPED booking,
  which contributes nothing to occupancy for a delta to sit atop). A shrinking
  modification reserves nothing. New-booking requests do **not** yet write a
  reservation — that hold is DEFERRED to #2526, and their approval-time NO_HOLD
  capacity recheck is what prevents overbooking until then; the full-proposal math
  `computeProposalReservation` already returns for a `NEW_BOOKING` snapshot makes
  wiring that later purely additive. A held modification is never written larger
  than the lodge's real headroom — the create path admission-checks under the
  lodge lock and refuses an over-capacity hold. (The reservation math is
  `computeProposalReservation`. Since #2525 the footprint is durable as
  `PolicyExceptionReservationNight` rows that the canonical per-lodge capacity
  calculation counts as occupancy — alongside capacity-holding bookings and
  custodian holds — so a pending request cannot be oversold; a held request never
  overbooks because its reservation is claimed under the same per-lodge capacity
  lock the occupancy read takes.)

### INV-EXCEPT-006

- **Drift is set algebra over the frozen and current violations of the SAME
  proposal.** At approval the frozen proposal is re-evaluated against today's
  policy configuration. A reviewed rule that no longer trips (policy switched off
  or relaxed) is executed WITHOUT an override and the resolution is recorded; a
  reviewed rule that still trips at a different revision or with different content
  (`violationFingerprint`), or any brand-new violation, is a materially different
  question the member must resubmit — it is never silently overridden. Only
  reviewed violations that still trip unchanged are overridable.

### INV-EXCEPT-007

- **The message is required.** `memberMessage` is trimmed, non-empty and at most
  1000 characters, normalised once at the request boundary so every later surface
  renders exactly the stored value.

### INV-EXCEPT-008

- **Every transition is guarded and single.** Only a `REQUESTED` request may move,
  and only to `APPROVED`/`REJECTED`/`CANCELLED`/`SUPERSEDED`/`EXPIRED`; the guarded
  `updateMany` plus the integer `version` token make a lost claim run no side
  effect (the `BookingRequest.version` discipline, #1923). `REJECTED`,
  `CANCELLED`, `SUPERSEDED` and `EXPIRED` release the provisional reservation;
  `APPROVED` turns it into the executed booking's own beds inside the same
  transaction.

### INV-EXCEPT-009

- **Every held bed is on a deadline, and only a held bed is (#2553).** A
  request that actually reserves beds is stamped at creation with an immutable
  `holdExpiresAt` — `POLICY_EXCEPTION_HOLD_TTL_DAYS` (7) from creation, capped at
  the start of the first night it holds, floored at
  `POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS` (24) so a late request still gets a real
  review window. It is written once and never rewritten, so a member's expiry
  cannot move under them and the reaper's clock is an auditable fact of the
  request rather than a live setting. The `policy-exception-hold-reaper` cron then
  moves each past-deadline request `REQUESTED -> EXPIRED` through
  `resolvePolicyExceptionRequestTerminal`, the SAME guarded-claim-plus-atomic-
  release path the other terminal outcomes take, so beds are returned under the
  global -> per-lodge locks exactly once and no forked release exists to drift.
  The converse holds for every row the current code STAMPS: `holdExpiresAt` is
  NULL, and the reaper's scan never sees the row, whenever no capacity is at stake
  — a `LOCKED_PERIOD` row, a `NO_HOLD` aggregate, or a HOLD aggregate whose
  incremental footprint came out empty (a pure shrink). A cron may release stranded
  beds; it may never close a live request that costs the club nothing to leave open.
  **The one stated exception, because the #2553 migration deliberately does not
  backfill:** a row written before that migration (or by a draining old colour) can
  be holding beds *with* `holdExpiresAt` NULL, and the reaper ages that row out from
  `createdAt` plus its own earliest held night under the identical rule. So NULL is
  never a safe proxy for "this request holds no capacity" — a scan or predicate that
  tests `holdExpiresAt IS NOT NULL` would silently skip exactly the stranded holds
  this invariant exists to catch. The live `PolicyExceptionReservationNight` rows are
  the only reliable test, which is why the reaper's scan filters on them.
  Concurrency safety comes from the `version` CAS rather than a job-level lock: a
  decision landing between the scan and the claim wins, and overlapping cron cycles
  produce exactly one expiry and one release. A lost claim is silent; a past-deadline
  row the shared transition REFUSES outright (not a policy-exception row, or an
  unparsable `proposalSnapshot`) can never self-heal, so it is counted as
  `unresolvable` in `CronJobRun.resultSummary` and logged at warn rather than
  reported as a clean run. **An expiry is never silent, and never inside the release
  transaction (owner decision, 2 Aug 2026).** Three records, in this order: the
  `EXPIRED` status the member already sees on their booking's Change Requests card;
  a `booking-policy-exception-request.expired` AuditLog row, so the request's audit
  timeline reads created -> expired; and a `policy-exception-request-expired`
  courtesy email to the member who raised it, telling them the request lapsed and
  its held beds were released. The audit write and the send both happen AFTER
  `resolvePolicyExceptionRequestTerminal` returns a claimed outcome, and both are
  logged-and-swallowed on failure: a bounced notice can neither roll back a
  capacity release, nor cause one to be re-run, nor stop the reaper closing the
  run's other stranded holds. The one-open-request slot is freed too, so a lapse
  never locks the member out of resubmitting.

### INV-EXCEPT-010

- **Approval is atomic with execution (#2525).** `approveAndExecutePolicyExceptionRequest`
  reauthorizes from fresh DB roles, re-reads under global -> per-lodge locks,
  applies the drift rules above, claims `REQUESTED -> APPROVED` with the `version`
  CAS, releases the reservation, and invokes the transaction-aware canonical
  booking service (`createConfirmedBooking` / `modifyBookingBatch`, made
  tx-accepting in #2525) — all in ONE transaction, so there is never a window in
  which a request is `APPROVED` but its booking does not yet exist. A NO_HOLD
  aggregate (nothing was reserved) re-checks capacity at approval and keeps the
  request `REQUESTED` with a recorded reason on a conflict, rather than failing it.
  Provider calls and the member approval/rejection notice run after commit.

## Member request surfaces for policy exceptions (#2524)

### INV-EXCEPT-002

The request-CREATION half of the flow above (`booking-exception-request-service.ts`
and its routes). Reservation, approval and execution are the #2525 seam
(`booking-exception-execution.ts`); nothing here crosses it. These invariants
hold in addition to every #2365 invariant above:

- **A new booking has its own store.** A `BookingChangeRequest.bookingId` is a
  required FK, so a NEW-booking proposal cannot live there. New-booking requests
  are stored in the dedicated `NewBookingPolicyExceptionRequest` table; a
  MODIFICATION request stays on the `POLICY_EXCEPTION` `BookingChangeRequest`.
  Both freeze the identical immutable proposal + `proposalHash`, `frozenEvidence`
  + `aggregateCapacityMode`, required `memberMessage`, attempt/conflict metadata
  and integer `version` claim token.

### INV-EXCEPT-011

- **The violations are re-evaluated server-side, never trusted from the client.**
  A request stores exactly the violations `evaluateProposalPartyViolations`
  re-derives from current policy for the proposed party (minimum stay + adult
  member hosting); a proposal that trips none is refused (nothing to review), and
  a non-allowlisted code can never be stored (`freezePolicyExceptionEvidence`).

### INV-EXCEPT-012

- **At most one open request per subject, enforced by the database.** A
  `REQUESTED` row holds a deterministic `openStateKey`
  (`nbpe:{requestedByMemberId}:{proposalHash}` for a new booking,
  `pe:{bookingId}:{requestedByMemberId}` for a modification) under a NULL-distinct
  unique index; every terminal transition NULLs it. A concurrent duplicate races
  into a unique violation (409), never a second open row, and a `LOCKED_PERIOD`
  row (slot always NULL) is untouched.

### INV-EXCEPT-013

- **Creation never changes a live booking.** A new-booking request creates no
  booking; a modification request writes only its request row and leaves the live
  booking's dates, guests, pricing and payment exactly as they were. The live
  change is #2525's approve-and-execute.

### INV-EXCEPT-014

- **Cancel/supersede are guarded and side-effect-safe.** Member cancel and
  supersede are guarded single `updateMany` transitions on `status = REQUESTED`
  (scoped to the owner, and to `POLICY_EXCEPTION` on the shared table); a lost
  claim runs no side effect — no status change, no notification, no replacement
  request.

### INV-EXCEPT-015

- **The officer is notified after commit, never in-band.** The on-request Booking
  Officer alert is fire-and-forget after the request commits; an alert failure is
  logged and never fails the member's request.

## Officer decision on a policy exception (#2526)

### INV-EXCEPT-003

The DECISION half of the flow above: `src/lib/booking-exception-approval.ts` (the
real #2525 hooks) and `PATCH /api/admin/booking-exception-requests/[id]`. These
invariants hold in addition to every #2365/#2524/#2525 invariant above:

- **Approving executes; it is never a status flip.** The officer's approval hands
  #2525's engine the real hooks, and the engine claims the request AND runs the
  canonical booking service (`modifyBookingBatch` / `createConfirmedBooking`) in
  ONE transaction. There is no mark-approved-then-call-service gap, so a request
  can never end up APPROVED with nothing behind it.

### INV-EXCEPT-016

- **The capacity recheck checks the FULL proposed party and EXCLUDES the live
  booking.** For a modification this makes the full-party check exactly an
  incremental-headroom check against a capacity-holding base, and the correct
  full-footprint check against a non-holding one. Counting the live base and
  then checking only the delta would double-count it and FALSE-KEEP-PENDING an
  approval that should execute (safe direction, wrong answer). A new-booking
  proposal excludes nothing.

### INV-EXCEPT-017

- **The recheck window covers every frozen guest night.** The window is the union
  of the frozen party's envelope AND every night its guests hold, not the
  envelope alone. A stored snapshot is DATA: a guest night outside its own
  envelope would otherwise never be capacity-checked by the engine at all, even
  though `createConfirmedBooking` expands the envelope to cover it and books it —
  so the engine's "it asserts capacity itself rather than trusting the executor
  seam" would not be true for those nights. Widening can only make the check
  stricter. Freezing closes the same gap from the other end, expanding the
  proposed envelope to cover every guest night, so the officer's card and the
  engine's window describe the same stay.

### INV-EXCEPT-018

- **Capacity stays a hard refusal.** The approval never passes
  `confirmOverCapacity` and never sets `adminOverride`; an approving officer is
  not a capacity-override actor. `createConfirmedBooking`'s non-throwing
  `capacityExceeded` outcome is THROWN
  (`PolicyExceptionExecutionCapacityError`) so the whole approval rolls back.

### INV-EXCEPT-019

- **Never a false keep-pending.** Every "still pending" answer the route gives is
  true at the moment it is given: the engine's kept-pending outcomes are returned
  before the claim (NO_HOLD) or via a rollback signal (HOLD), and an execution
  refusal aborts the transaction — undoing the claim, the reservation release and
  every row the canonical service wrote. Equally, once execution has committed
  the request is reported APPROVED and never as pending. **The post-commit phase
  cannot contradict that.** The canonical services' deferred thunks run AFTER the
  commit and await unguarded provider, audit and notification work; the engine
  contains a throw there and returns `executed` with `followUpFailed: true`, so
  the officer reads "approved, but some follow-up work failed" instead of being
  told nothing happened about a booking that now exists — which sent them either
  to a 409 blaming a third party, or to creating the booking a second time by
  hand. A failure in one deferred phase never skips the other.

### INV-EXCEPT-020

- **A kept-pending capacity conflict is always recorded.** `conflictCount`,
  `lastConflictAt` and `lastConflictReason` are what the officer's card and the
  member's own request list read to tell "the lodge is full" apart from "nobody
  has looked yet", so the record must survive the rollback that carries the HOLD
  signal. A store whose held requests reserve nothing (`holdsReservation: false`
  — the new-booking store, whose reservation ledger is keyed to an existing
  booking) is rechecked BEFORE the claim, so its conflict commits in the one
  transaction that commits. A store that genuinely holds beds is still rechecked
  after the release, and its conflict is written in its own transaction after the
  rollback.

### INV-EXCEPT-021

- **The live proposal is verified by replay, not by trust.** A modification
  request freezes the raw member delta beside the proposal
  (`requestedChanges.delta`). `verifyLiveProposalIntegrity` replays that delta
  against the LIVE booking and requires the resulting base+proposed pair to hash
  to the frozen `proposalHash`. One equality proves both halves: the live booking
  has not drifted, and the delta still produces the proposal that was reviewed. A
  missing, malformed or tampered delta fails closed — but not with the same
  explanation. Drift and tampering are reported as proposal drift; a row carrying
  no replayable delta at all (one created before the delta was frozen) gets its
  OWN message, because it is unexecutable while nothing about the booking has
  moved, and blaming a live edit sends the officer and the member looking for an
  edit that never happened.

  Added #3089: the drift message no longer blames a live edit either, because the
  replay proves an inequality and not its reason (`INV-EXCEPT-035`). The
  unreplayable message stays distinct precisely because that cause IS established.

### INV-EXCEPT-035

- **A refusal names only what was established.** Each refusal path observes ONE
  thing — a replayed hash that no longer matches the frozen `proposalHash`, or a
  violation fingerprint that moved — and each of those has more than one possible
  cause. The engine holds no record of which reader produced the stored snapshot,
  so it cannot tell a live edit from corrected code re-deriving the same evidence
  (#3087); and `violationFingerprint` covers the affected NIGHTS, so a re-derived
  night set moves it while every policy stands exactly as reviewed. A refusal
  message therefore names no cause the engine cannot distinguish, and still names
  the next step — the member resubmits, the officer reviews what stands now — so
  it is true without being useless. A cause the engine really did observe keeps
  its own words (`INV-EXCEPT-021`). Pinned by
  `src/lib/__tests__/booking-exception-execution.test.ts` → "refusal messages name
  only what the engine established (#3089)".

### INV-EXCEPT-022

- **"What the delta produces" is computed by ONE implementation.** The replay is
  proof only while the frozen party is what the canonical planner will really
  build, so the two are the same arithmetic rather than two that agree by
  inspection: `resolveModificationStayRanges`
  (`src/lib/booking-modification-stay-ranges.ts`) is called by
  `resolveTargetDates`, by `prepareGuestPlan`, by the freeze, and — since #2563 —
  by the modification PREVIEW (`POST /api/bookings/[id]/modify-quote`), which
  until then assembled its own copy of the same rules. Four surfaces, one
  implementation: the price a member is quoted, the party an officer approves and
  the party the save writes are the same arithmetic, and the route keeps only the
  presentation half (mapping the resolver's structured range error onto its 400
  body, with the resolver's own wording so preview and save refuse identically).
  It owns the
  planner's real semantics — the range-input flag is GLOBAL (ANY range anywhere
  switches the whole request into a mode where every guest without their own
  entry keeps their STORED range and night set, and the dates-moved reset never
  runs), and a stored sparse night set (#713) survives instead of being flattened
  to its envelope. A per-guest lookalike of that rule froze, hashed and
  capacity-checked a party the execution never created: a date change plus a
  partial `guestStayRanges` had an officer review three guests on three nights
  and committed 3 + 2 + 2 — a different party, a different price, and a
  minimum-stay/hosting judgement made on a party that never existed.

### INV-EXCEPT-023

- **Only the reviewed rules are overridden, and ADMIN is not borrowed for
  anything else.** Minimum stay is overridden by running the canonical
  modification as an ADMIN actor (the service enforces the rule only for
  non-admins), which is safe ONLY because #2525's drift gate has already proved
  the frozen proposal trips exactly the reviewed violations — a newly-tripping
  rule is `newViolations` and never reaches execution. A reviewed rule that has
  since CLEARED is not overridden at all; the resolution is recorded instead.

  But `role === "ADMIN"` is overloaded. The same condition also grants
  `skipAuthorization` (dropping the beyond-family member-guest refusal), makes a
  member-guest add consent-free and always-notify, skips the D-8
  profile/bookability gate, skips the cross-family marker, skips the member-guest
  unpaid-subscription check, and auto-approves the adult-supervision review. The
  drift gate cannot cover any of them: `evaluateProposalPartyViolations` evaluates
  minimum stay and adult-member hosting only, so those rules sit outside the
  "exactly the reviewed violations" proof entirely. Borrowing ADMIN for them would
  let a member attach an unrelated member to a booking, consent-free, on a card
  that only ever said "minimum stay".

  So the approval passes `reviewedMemberProposal: true`, and every
  guest-authorisation question in `prepareGuestPlan` is decided from ONE derived
  flag (`guestAuthorizationIsAdmin`) that the input turns off — the plan and the
  pricing pass read the same answer, so they can never disagree about whether the
  family boundary applied. The reviewed minimum-stay override still keys on
  `role`, so it is untouched. The flag can only ever make the guest rules
  STRICTER, and an ordinary admin edit leaves it unset and behaves exactly as
  before.

### INV-EXCEPT-024

- **An approved hosting exception is recorded as decided.** The canonical
  modification reconciles the hosting hazard from the rows it just wrote and
  deliberately opens it PENDING (an unrelated edit must never auto-approve one).
  When the approval reviewed that rule and it still trips, the officer's decision
  is written in the same transaction (`recordAdultMemberHostingReviewDecision`,
  guarded PENDING → APPROVED with an attributable reason, D-R4) so an approved
  request never leaves a pending hosting review nobody will action. The
  reason-agnostic check-in block (#1422) [INV-ADDPAY-004] is untouched: any pending admin review
  still gates check-in, and this workflow adds no exemption to it.

### INV-EXCEPT-025

- **The adult-supervision review is never decided by proxy.** A party with a minor
  and no adult (#1372, `requiresAdultSupervisionReview`) is a different rule from
  either policy-exception reason code: the drift gate cannot evaluate it, the
  officer's card never mentions it, and a minimum-stay-only approval requires no
  written reason at all. An approval therefore opens it PENDING and BLOCKED, with
  the MEMBER's own words as the justification — exact member parity — rather than
  stamping it APPROVED in the name of an officer who was never shown the hazard.
  The child-safety check-in block stays armed until a human looks.

### INV-EXCEPT-026

- **Reauthorization is from fresh database roles.** The session guard decides
  whether the officer may open the screen; the engine re-reads the officer's
  CURRENT roles inside the approval transaction and requires `bookings: edit`,
  an active login-capable account, and no forced password change. Access revoked
  between opening the queue and clicking Approve refuses with no write.

### INV-EXCEPT-027

- **A decision is explicit, attributable and single-flight.** Approve requires
  `confirm: true`; overriding adult-member hosting and every refusal require a
  written reason; both carry the `expectedVersion` the officer's screen showed,
  so a decision made against a stale queue loses the guarded CAS instead of
  deciding a request that changed underneath it. A failed attempt of the officer's
  own can move that version (a NO_HOLD conflict bumps it), so the queue re-reads
  itself on every failure — otherwise their next click lost the CAS and they were
  told the request "changed while you were reviewing it", which blamed a third
  party for their own previous attempt and made "approve it again once beds free
  up" unreachable without a manual reload.

### INV-EXCEPT-028

- **The officer decides a party they were shown.** Approving executes the frozen
  party for real, so `GET /api/admin/booking-exception-requests/[id]` describes
  it — each guest's name, age tier, whether they are a member guest, whether they
  are outside the requester's family (resolved from the LIVE boundary), and how
  many nights they hold — and the queue card loads it on demand before the
  decision. A guest count cannot show an unrelated member being attached to
  somebody else's stay, or a party of minors with no adult, and without the party
  on screen the audit record attributes to the officer a decision they had no way
  to make.

### INV-EXCEPT-029

- **The money question is asked, not discovered.** A change that reduces a settled
  booking's price makes the canonical service demand a card-or-credit choice. That
  choice is not part of the reviewed proposal (the proposal decides WHAT changes;
  this decides how the money moves), so it lives on the decision form, and the
  route answers a missing one with `needsSettlementMethod` and its own actionable
  message. It is never reported as "still pending": that named no action, the
  screen offered none, and it made the archetypal shorten-my-paid-stay
  minimum-stay exception permanently un-approvable through the queue.

### INV-EXCEPT-030

- **The member can read the decision.** Their own request list returns the
  officer's note (so a refusal comes with its reason rather than a bare
  `REJECTED`), the last capacity conflict (so a request still sitting at
  `REQUESTED` can be told apart from one nobody has looked at), and the booking
  an approval created. The note is returned on EVERY status, not only refusals,
  and the officer's own field says so — the same text is reused as the audit-grade
  override reason on the booking, so it must never be written believing it is an
  internal aside.

### INV-EXCEPT-031

- **An approved request is announced.** A MODIFICATION is announced by the
  canonical service's own change notice. A NEW booking is not: a members-only
  party resolves to `PAYMENT_PENDING` on the default payment method, for which
  `createConfirmedBooking` deliberately sends nothing — a member normally learns
  what to pay because they are standing in the wizard being redirected to
  checkout, and an approved exception request happens while they are elsewhere.
  `PAYMENT_PENDING` holds no beds, so silence meant the lodge could fill, or the
  booking be reaped, with the member none the wiser that they had one. The
  new-booking executor therefore sends a dedicated approval email after commit
  (`sendBookingPolicyExceptionApprovedEmail`) naming the stay, what is owed, and
  the officer's note. The two never double up — only the new-booking flavour uses
  it.

### INV-EXCEPT-032

- **Both request tables are decided by the same algorithm.** The engine takes a
  `PolicyExceptionRequestStore` (modification = `POLICY_EXCEPTION`
  `BookingChangeRequest`, new booking = `NewBookingPolicyExceptionRequest`);
  the lock order, reauthorization, guarded CAS, drift gate, capacity recheck and
  post-commit ordering are shared, so the two flavours cannot drift apart. A
  new-booking request holds no provisional reservation, so its release is a
  no-op — its safety comes from the approval's own capacity recheck plus the
  canonical create's hard refusal.

### INV-EXCEPT-033

- **A new booking is authorised, not merely created.** `createConfirmedBooking`
  validates guest member links not at all: every other caller runs
  `resolveLinkedBookingMembersWithBoundary` →
  `assertLinkedBookingMembersCanBeBooked` → `normalizeBookingGuestInputs` →
  `planMemberGuestConsentWrites` itself, first. The new-booking executor runs that
  same sequence — as the REQUESTING MEMBER, per the reviewed-rules invariant above
  — and dispatches the consent and family-add notices after its commit. Without it
  a member could name any active member's id in an exception request and have an
  approval attach them: no beyond-family refusal, no consent row and no
  notification (on any club, module on or off), no profile/bookability gate, and a
  guest row keeping the REQUESTER's declared age tier and membership, which also
  priced them at the member rate.

  Request CREATION runs the boundary resolution too, so a party naming a member
  the requester may not book is refused at submission and no officer ever reviews
  a party that cannot be executed. That is a usability gate, not the security
  boundary: the approval's own pass is judged against the LIVE boundary at
  approval time and fails the whole approval closed.

### INV-EXCEPT-034

- **Attempts count.** A supersede carries the predecessor's `attemptCount` forward
  + 1, so the card's "Attempts" is the number of times the member has actually
  asked. Every replacement starting again at 1 told an officer that a request
  resubmitted three times was a first ask.
