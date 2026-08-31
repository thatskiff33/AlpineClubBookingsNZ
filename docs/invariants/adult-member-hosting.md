# Adult-Member Hosting

Audience: Developer, Agent.

Prefix defined in this file: **`INV-HOST`** — whether a non-member guest-night
must overlap an adult member who is actually staying, who counts as such a host,
what happens when cover is taken away, and how the resulting review or refusal
is recorded.

Read this file when you are changing who may host whom, and what strands cover.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added, and one relative link path was re-pointed
(`CONCURRENCY_AND_LOCKING.md` → `../CONCURRENCY_AND_LOCKING.md`).

## Adult-member hosting (#2364, epic decisions D-R3 / D-R4)

### INV-HOST-001

A club may optionally ask that every non-member guest-night overlaps an adult
member who is actually staying on the same booking. It is the second consumer of
the #2363 exception foundation and the second allowlisted reason code,
`ADULT_MEMBER_HOSTING_REQUIRED`.

### INV-HOST-002

**Configuration.** One `AdultMemberHostingPolicy` row per scope: a club-wide row
(`Disabled` / `Admin review required`) plus, per lodge, an override that may also
say `Inherit`. Scope identity is pinned in the database — `scopeKey` is held to
`COALESCE(lodgeId, 'club-wide')` by a CHECK and carries a unique index, so a
second club-wide row cannot exist and resolution is deterministic. A club-wide
`INHERIT` is refused by a second CHECK, because it would have nothing to inherit
from. `capacityMode` has **no** database default (D-R6): the table is created
empty and every API and UI write states it. Every write is versioned and
compare-and-swaps on the revision the editor loaded, under the
`adult-member-hosting-policy-set` advisory key.

### INV-HOST-003

**Resolution.** A lodge row whose mode is not `INHERIT` replaces the club default
for that lodge; an `INHERIT` row, or no row at all, falls through to the club
row; a club with no row resolves `DISABLED`. A scope that cannot be identified is
REFUSED (`UnknownAdultMemberHostingScopeError`), never quietly answered
"disabled" — the caller must not be able to confuse "the club has not turned this
on" with "we could not tell which lodge this is".

### INV-HOST-004

**Who may host.** An active, uncancelled, unarchived **ADULT** `Member` who is
linked to a guest row on that exact night. Three consequences, each deliberate:

- **Booking ownership never proves attendance.** The owner counts only through a
  participant row linked to them, and only on the nights that row covers. The
  evaluator is never given `Booking.memberId`, so it cannot be credited by
  accident.
- **The member LINK is authoritative, not the guest row's `isMember` flag**,
  which is a pricing-time snapshot. A row whose member cannot be resolved is
  treated as a non-member guest — the safe direction, since that means it needs
  hosting rather than provides it.
- **Child, youth, infant and NOT_APPLICABLE (organisation) members cannot
  host.** They are still members in good standing, so their OWN nights never
  need covering: the minors rule (`requiresAdminReview`) owns children, and this
  rule is about non-member guest-nights only.
- **A membership that has lapsed is not a membership.** An inactive, cancelled
  or archived member cannot host AND their own nights need hosting: the safe
  direction above is applied to a member who is resolvable but no longer in good
  standing, because for this rule they are functionally a non-member (D-R3). The
  standing test is the single predicate both sides are built from, so a
  participant cannot fall between them and escape the rule entirely — which is
  what happened before the #2364 review. It is keyed off standing only, never
  `ageTier`, so an active organisation member is unchanged.
- **An unaccepted member-guest invite cannot host.** `consentStatus: PENDING` is
  not operationally present (D-12) — the kiosk, the arrival roster, bed
  allocation and the arrival emails all leave that row out — so counting it as a
  host would let a member suppress the review with an adult who never agreed to
  come, and the lodge would then receive the non-member guests unaccompanied.
  The review clears by itself the moment the invite is accepted.

### INV-HOST-005

Nights come from the sparse `BookingGuestNight` rows (#713), so a non-contiguous
stay is judged night by night. Rows predating #713 fall back to the GUEST's own
`stayStart..stayEnd` envelope, never the booking's.

### INV-HOST-006

**Split bookings (#738).** A mixed party awaiting payment is stored as a member
booking plus a linked non-member child. Judged alone the child contains no member
at all, so the evaluation borrows the direct parent's (or child's) adults as
host-only participants whenever that sibling belongs to the SAME member and is
live. Uncovered guest-nights still come only from the booking's own rows, so one
party yields one hazard rather than two. Group bookings are explicitly NOT
affected: a joiner's booking belongs to a different member, so an organiser's
adults never host somebody else's guests and "the same booking" keeps meaning
what it says.

### INV-HOST-007

That borrowing makes the dependency **symmetric**, and reconciliation has to
match it: shortening the member's own stay on the parent takes a host away from
the child, and extending it gives one back, without a single row on the child
changing. Every mutation path therefore reconciles the mutated booking AND the
live same-member siblings the borrow reads, inside the same transaction
(`reconcileAdultMemberHostingReviewWithSiblings`). The fan-out is one level and
that is exact rather than a safety margin — the relation is direct-parent /
direct-child, so expanding from a sibling could only lead back. A sibling always
opens PENDING: an admin's on-behalf reason belongs to the booking they were
making, never to a row reached through it.

### INV-HOST-008

**Consequence.** Hosting is a REVIEW, not a refusal — the club chose "admin
review required", and D-R4 makes it always administratively overridable. A
member's booking is made and an admin decides afterwards. The hosting review
lives in its OWN `Booking` columns (`adultMemberHostingReview*`) rather than the
shared `requiresAdminReview` / `adminReviewStatus` pair, because several booking
paths wipe those the moment the minors-only rule stops applying, and an unrelated
guest edit must not silently discard an admin's hosting decision. The two hazards
are reported together as structured codes at read time
(`bookingReviewReasonCodes`), which is what "without overloading the legacy single
review string" means here. A pending hosting review deliberately does NOT block
lodge check-in: the minors gate is a child-safety stop, whereas the fix for a
hosting hazard — an adult member joining the booking — is not something anybody at
the door can do.

### INV-HOST-009

**Admin exemption.** Stated per path, like minimum stay's:

- **Booking create** refuses an authorised **on-behalf** booking that trips the
  rule with HTTP 409 `ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED` until the admin
  supplies a reason, which is then persisted with their id against an APPROVED
  review. Role alone buys nothing: a dual-hat admin booking for themselves is a
  member here, exactly as #1442 decided for minimum stay. `/admin/book` answers
  that 409 with a reason panel on both submit paths — confirm and save-as-draft,
  since the check runs before the draft fork — mirroring the over-capacity
  warn-and-confirm beside it. A `*_CONFIRM_REQUIRED` refusal no surface can
  satisfy is a permanent block, so the contract test pins that every such code
  the create route can return has a client that branches on it.
- **The reviewer is a real foreign key.** `adultMemberHostingReviewedById`
  carries a `SetNull` relation to `Member` and a `member-merge-relations.ts`
  spec, like
  every other actor-attribution column on `Booking`. Member merge repoints it and
  member deletion nulls it; a bare id would be invisible to the DMMF
  completeness guard and D-R4's "who let this through" would rot into a dangling
  id the database never surfaces.
- **Every other path opens the review PENDING for everybody, admin included.**
  Accepting a hosting exception is a deliberate act with a reason attached, not a
  side effect of an unrelated edit, so a modification, a guest change or a
  waitlist confirm never auto-approves a hazard it just created.

### INV-HOST-010

**Re-evaluation.** The reconciler derives everything from live rows and is
idempotent, so it runs at the end of every booking path that can change the
party: create (draft, confirmed, waitlisted, and the split child), batch modify,
date modify, admin date shift, guest add, guest removal and waitlist confirm —
each inside its own transaction, with the caller's `tx`. It also runs on every
path that CREATES a whole party without going through `booking-create.ts`: the
public booking-request approval and its held-booking conversion, the
quote-time hold, both school/member whole-lodge approvals, and the verified
non-member group joiner. Those are the parties the rule most obviously targets —
every guest a non-member, the owner a non-login contact — and leaving them
unrecorded meant the hazard was present but invisible until some unrelated later
edit materialised it months on. They all open PENDING and none of them is
blocked: approving a REQUEST is not the reasoned acceptance of a hosting
exception that D-R4 asks for. `adult-member-hosting-review.test.ts` enforces this
structurally — every module in `src/` containing a `booking.create(` must reach a
hosting recorder, and no module outside the review service may call the
single-booking reconciler. A hazard **clears**
whenever current facts cover every night, for any reason: an adult member was
added, a guest left, the nights moved, the member was reinstated, the policy was
switched off, or the booking moved to a lodge that never had the rule. It
**reopens** as PENDING, dropping the previous decision, only when the uncovered
guest-night set or the policy revision materially differs — a renamed guest or an
extra host on an already-covered night does not re-prompt an admin who has
already decided.

### INV-HOST-011

**Scope boundary.** #2364 stops at configuration, the evaluator and these
integration seams. The member request surface, the admin execution UI, durable
proposal state and capacity reservation from `HOLD` all belong to #2365; the
capacity mode is frozen onto the snapshot and aggregated here, and reserves
nothing.

### INV-HOST-012

**Owner decision (3 Aug 2026), #2569: two independent dimensions.** The policy is
no longer one setting. A club configures a CONSEQUENCE and a HOST-QUALIFICATION
scope set, each with a club-wide default and a per-lodge override that carries an
explicit inherit option, and the two are resolved SEPARATELY — a lodge may
override one while inheriting the other, so `ResolvedAdultMemberHostingPolicy`
reports where each came from.

### INV-HOST-013

- **Three consequences.** `DISABLED`, `ADMIN_REVIEW_REQUIRED` (unchanged: the
  booking is made and an officer is asked to look) and `ENFORCED` (the booking is
  refused). `ENFORCED` raises `AdultMemberHostingRequiredError` — HTTP 409,
  `exceptionEligible`, carrying the SAME frozen violation the review mode records,
  aggregated by the same `aggregatePolicyExceptionViolations` and re-derived
  server-side when the member walks through the #2365 door. There is no second
  refusal path and no second reason code; only whether the booking is allowed to
  exist while it waits differs. The refusal is thrown from inside the mutation
  transaction, so a modification that would break the rule rolls back.

### INV-HOST-014

- **`INHERIT` remains lodge-only for the consequence**, and the second dimension
  inherits by a different mechanism: both host-scope columns NULL TOGETHER
  means "this row did not decide". The database CHECK holds them to all-null or
  all-set, so a half-configured scope set cannot exist for the resolver to guess
  at, and a NULL set on the club row resolves to the built-in default.

### INV-HOST-015

- **Two scopes, and these two** (owner decisions, 3 Aug 2026). `SAME_BOOKING` is
  the pre-#2569 rule kept verbatim. `SAME_BOOKING_OWNER` counts a qualifying adult
  member attending another eligible booking with the EXACT same `Booking.memberId`,
  at the same lodge on the same night (#2576) — one account's own bookings covering
  each other, never `createdById`, a shared email, a Family Group link or
  `parentBookingId` alone. The spec's third scope, `ANY_MEMBER_AT_LODGE`, is
  REMOVED (#2575): a booking must not become compliant because an unrelated member
  happens to be at the lodge. The originally planned `NOMINATED_HOST` workflow is
  REMOVED with it (#2576) — no nomination, invitation, acceptance or host-search
  machinery exists or is planned. Both are removals rather than deferrals, so there
  is deliberately no hidden, reserved or refused value for either in the database
  or the application; bringing one back means re-deciding it.

### INV-HOST-016

- **The built-in default is same-booking only, and that is what makes the upgrade
  a no-op.** Every pre-#2569 row carries NULL scope columns, so every existing
  club keeps judging exactly the coverage it judged before. Nothing is broadened
  to same-owner coverage, no club is moved onto `ENFORCED`, and the
  member-facing review sentence is byte-identical for a club on the default set.

### INV-HOST-017

- **OR across enabled scopes, decided per night.** A non-member guest-night is
  compliant where AT LEAST ONE enabled scope supplies eligible adult-member cover
  for that exact night; different nights may be covered by different scopes and
  different members, and EVERY such night must be covered. The seam is
  `HostingParticipant.hostScope` (absent means `SAME_BOOKING`): the evaluator
  counts a host only where the club has that host's scope switched on, so a wider
  scope is added by stamping its participants rather than by changing the rule. A
  #738 split sibling is deliberately `SAME_BOOKING` — a split pair is one party
  the database stores as two rows, not a second booking at the lodge.

### INV-HOST-018

- **An active policy with no scope enabled is refused, not interpreted.** The
  admin route and config transfer both refuse it, and the evaluator throws
  `EmptyAdultMemberHostScopeSetError` rather than treating it as permissive
  (which would drop the club's rule) or as universal (which would flag or refuse
  every booking).

### INV-HOST-019

- **Host identities are never disclosed to the booking owner.** Member-facing
  refusal bodies are built by `buildAdultMemberHostingRefusalBody`, which strips
  `qualifyingHostsByNight[].memberIds` while keeping the nights and the scopes
  that covered them. The frozen snapshot an officer reviews keeps the ids in full
  for validation and audit. Applied under every scope, not only the wider one: a
  redaction that fires under one setting is a redaction nobody tests. Under
  `SAME_BOOKING_OWNER` the covering stay is on the member's own account, so the
  member may be told that another of their bookings supplies or depends on cover
  (#2576 §11) — what is withheld is the internal member id, not the fact.

### INV-HOST-020

- **School and organisation workflows are excluded** (§13), and only they. The one
  approval that covers them — `approveSchoolBookingRequest`, since
  `BookingRequestType.SCHOOL` carries school groups and organisations alike —
  passes `enforcement: "REVIEW_ONLY"`, which evaluates and records the hazard
  exactly as the review consequence does and never refuses, and the choice travels
  to their split siblings so one half of a #738 pair cannot be exempt while the
  other is refused. The MEMBER whole-lodge approval is deliberately NOT exempt: it
  is a member-owned booking flow, which the first release covers (§2), and the §13
  reasoning is about teachers, organisation leaders and custodians. An enforcing
  lodge therefore refuses that approval, rolling it back untouched, and the officer
  is told the rule with no exception door — they are the authority it leads to.
  `adult-member-hosting-call-sites.test.ts` pins the exemption to that one site
  tree-wide.

### INV-HOST-021

- **An explicit admin decision is an approval.** D-R4's on-behalf reason still
  lets an officer make a non-compliant booking under `ENFORCED`: the reason is
  attributable and is recorded against the approved review, which is the same
  authority the exception door leads to.

### INV-HOST-022

- **The officer queue says which consequence produced the request.** The reason
  label is the same under both, and the situations are opposite: under `ENFORCED`
  there is no booking (or no change) until the officer approves, under
  `ADMIN_REVIEW_REQUIRED` there already is one and the officer is recording a view
  of it. The queue reads the consequence off the FROZEN violation, never the live
  policy row — the club may have changed the setting since, and the decision is
  about what happened at the time — and says nothing about beds, because the card's
  own badge derives the hold and two derivations of one fact drift.

### INV-HOST-023

**Same-owner coverage (#2576).** `SAME_BOOKING_OWNER` reuses every definition
`SAME_BOOKING` already has — qualifying adult member, exact guest-night, membership
standing, age, member-guest consent, exceptions, reason and evidence structures —
and adds only WHERE the host may be. Its rules:

- **The relationship is the exact `Booking.memberId`.** An administrator entering
  bookings on behalf of different members never links them.
- **Only genuinely confirmed active attendance counts.** Drafts, holds,
  payment-pending, waitlist entries and offers, bookings awaiting review or an
  exception, bumped, cancelled, archived and expired bookings supply nothing, read
  through the canonical lifecycle helpers rather than a second status list.
- **Exact lodge and exact NZ lodge-night.** Lodge A on Friday covers neither Lodge
  B on Friday nor Lodge A on Saturday, so a stay may be partly covered.
- **Coverage is existential, not an assignment.** Evidence records the source
  booking observed at evaluation time; it never becomes a stored authorisation, so
  another eligible source keeps the dependent booking compliant with no incident
  and no loss-of-coverage message.
- **Ownership is never attendance.** A booking owned by an adult member supplies
  nothing unless a qualifying adult member is actually recorded as attending the
  relevant lodge-night. Any qualifying adult member participant may cover, not only
  the account holder.
- **No capacity is consumed twice** (§15). The covering adult arrives as a
  `hostOnly` participant: their real attendance on their own booking is evidence
  for the dependent booking, and they are never duplicated as a guest on it. The
  source booking's own guests remain that booking's question.
- **Re-evaluation stays bounded** to the same `memberId`, lodge and nights. The
  lodge-wide sweep #2575 rejected is not built. A queue item names one owner, one
  lodge and an explicit night list, so no shape of item can express a wider sweep,
  and a malformed night list yields no work rather than an unbounded read.
- **Coverage is existential, not an assignment.** Stated again because it is the
  invariant most easily broken by an optimisation: nothing stores a permanent
  dependency on a particular person or booking, both `where` builders are re-derived
  from live rows at every evaluation, and evidence naming the source observed once
  never becomes an authorisation.

### INV-HOST-024

**Changes that would take cover away (#2576 §6 to §9).** `SAME_BOOKING_OWNER` is
the hard precondition only for CROSS-BOOKING strand checks: without it, one booking
cannot depend on another and there are no dependents to refuse or fan out to. It is
not a licence to skip the booking being changed. Under `SAME_BOOKING` alone, a
confirmation or a change to an attending member's active/age/consent/subscription
qualification can still open or resolve that booking's incident, so own-booking and
member-qualification seams always queue under `ENFORCED`; they take the owner lock
only when cross-booking scope is enabled. The CONSEQUENCE then decides what happens.
Under `ENFORCED`, the full behaviour below.
Under `ADMIN_REVIEW_REQUIRED` nothing is ever refused and no incident is ever
opened — an uncovered booking is a permitted state there and the pending review is
already the officer's signal — but the dependents are STILL re-read. That is the one
staleness this scope introduces which the review consequence cannot catch by itself:
with `SAME_BOOKING` alone a booking's cover can only move through its own rows or its
split siblings, both reconciled on every write, whereas here a change to a DIFFERENT
booking can strand it and nothing else would ever look, leaving it recorded as
compliant indefinitely.

### INV-HOST-025

- **An ordinary member's self-service change to their OWN booking is REFUSED** when
  it would leave another booking on the same account uncovered — cancelling, a lodge
  or date change, a participant-night change, removing the qualifying adult member,
  or losing member-guest consent. `SameOwnerCoverageWouldBreakError` is a 409 raised
  from inside the mutation transaction, so the change rolls back, and it names the
  affected booking reference, its lodge and the uncovered nights.

### INV-HOST-026

- **The ACTOR is not the owner, and the refusal is gated on the actor** (§6, §11).
  Every booking in the stranded list has the changed booking's `memberId`, which
  makes it the OWNER's booking — it does not make it safe to show whoever made the
  change. The guest DELETE route deliberately admits a member from another account (a
  member-linked guest taking their own row off a CONFIRMED or PAID booking), so the
  refusal is reachable by an actor with no right to see it. `resolveDependentDisposition`
  therefore raises `BLOCK` only when the acting member IS the booking owner, and
  escalates for anybody else: the change is allowed, the owner is emailed, the
  incident is raised, and the actor is told nothing about the other booking. That is
  also the only humane answer — every remedy the message offers belongs to the owner,
  so a refused guest could not have complied by any means available to them. A call
  site that forgets to pass the actor fails towards escalation, never towards
  disclosure.

### INV-HOST-027

- **"Newly" uncovered is the test, not "uncovered".** A booking already carrying an
  uncovered state cannot be fixed by abandoning today's unrelated edit, so refusing
  over it would trap the member. The comparison is the shared material-identity key
  (`adultMemberHostingStateKey`) against the dependent's own stored review snapshot
  or its open incident — the same definition that decides whether an officer's
  review decision still applies.

### INV-HOST-028

- **An authorised officer is ASKED TO CONFIRM, then ALLOWED and ESCALATED** (§7).
  §7 requires the override to carry the permission, an explicit confirmation, a
  mandatory reason, the affected bookings and nights, and an audit event — and an
  override that is never asked for cannot carry a confirmation or a reason. So an
  officer change that would strand a dependent raises
  `SameOwnerCoverageOverrideRequiredError` (409, `requiresOverrideReason: true`)
  naming what would be stranded. That is a block on the UNCONFIRMED change, not on
  the officer: they re-submit with `hostingCoverageOverride`
  (`{ acknowledged: true, reason, strandedStateKey }`, minimum 10 characters) and
  it proceeds as `OFFICER_OVERRIDE` recorded against their member id with their
  reason on the incident. `strandedStateKey` is the versioned digest of the changed
  source booking plus the sorted dependent-booking/exact-night set the officer was
  shown. The retry re-derives it from authoritative rows under the per-owner lock; a
  changed non-empty set rolls the whole mutation back and returns a fresh prompt,
  so confirmation of one set is never authority over a new booking or night. If
  coverage improved to no stranded bookings while the prompt was open, the change
  proceeds without manufacturing an override audit or an empty confirmation prompt.
  Unknown nested override fields are rejected. Where nothing would be stranded they
  are asked nothing. The affected
  booking keeps its status, its beds and its payments and gets an urgent compliance
  incident; nothing in the coverage machinery writes `Booking.status`, so automatic
  cancellation is forbidden in as many words. Nothing automated can ever be gated by
  this: only surfaces going through `hostingCoverageActorOptions` with a live officer
  session can raise it, and every cron, webhook and lifecycle path passes `ESCALATE`.
  Approving a pending modification-policy exception uses this same two-step path:
  the first attempt stays pending and returns the exact affected bookings and
  nights, while the retry carries its own private `hostingCoverageOverride` reason.
  The member-facing approval explanation is never reused as that authority. The
  booking detail's officer edit and cancellation controls consume the same strict
  client-only prompt contract. They bind the prompt to the complete rejected
  mutation — including shift pricing mode, refund method and the explicit email
  choice — and retire it permanently if any proposal field changes. A retry reuses
  that exact proposal without asking the email question again; a refreshed 409
  replaces the key/list and clears only the private reason and confirmation. The
  affected booking details render only for `viewerAuthorizationRole === "ADMIN"`;
  member self-removal and ordinary draft confirmation never gain this override UI.

### INV-HOST-029

- **A change to one PERSON's standing records the check it owes** (§8). "Membership
  becoming inactive, lapsed, cancelled or archived" heads §8's list, and only the
  evaluator half of it is automatic (an archived or cancelled member stops
  qualifying). `enqueueHostingCoverageReevaluationForMember` is the other half, called
  in the same transaction as the archive, account-deletion anonymisation (before
  deactivation and guest unlink remove the attendance evidence), membership
  cancellation, single or bulk active/age-tier changes, consent approval,
  subscription settlement/reversal and member merge repoints. It fans out over the
  bookings that person ATTENDS — not owns (§2)
  — on live current-or-future stays, one bounded item per booking naming THAT
  booking's owner, lodge and nights, so the drain can never widen it into the
  lodge-wide sweep #2575 rejected. Gated on `ENFORCED` and deliberately NOT on the
  scope: a lapse removes cover under `SAME_BOOKING` just as surely, and the drain
  reconciles through the shared evaluator, which honours whichever scopes the lodge
  has on. Member-guest consent loss reaches the same place through the shared removal
  path, which reconciles inside the caller's transaction. Each high-level enqueue
  invocation first proves its exact source owners and non-null actor under one sorted,
  de-duplicated `Member FOR KEY SHARE NOWAIT` statement. A missing member, contended
  row, changed source owner/lodge, or final attribution outside that private proof
  rejects the complete outer mutation with the fixed safe 409; a later call in one
  bulk transaction also fails fast and rolls back the earlier work rather than
  waiting while it holds a different participant set (#2597).
  Before even its first attendance read or empty return, the shared standing
  fan-out locks its subject member `FOR UPDATE NOWAIT`. That exact strength fences
  the lodge-only booking-request hold's linked-member `KEY SHARE`; `FOR NO KEY
  UPDATE` would not conflict and is forbidden. The hold takes its lodge key,
  re-reads the transaction-current request links, locks their exact sorted member
  ids, and re-reads every row as existing, active and unarchived before its
  versioned request claim or any guest creation. Hold-first makes the standing
  mutation retry so its next attempt includes the committed guest. Standing-first
  makes the hold wait and then refuse the inactive/archive row before creation in
  every consequence mode, including `DISABLED` and review-required. Account
  deletion inherits the same central fence after its existing global → affected
  lodge → member-lifecycle prefix; it carries no route-only duplicate.
  Under its target `Member FOR UPDATE`, deletion also re-checks the complete Xero
  contact-create reservation/recovery blocker plus every RUNNING member CONTACT
  UPDATE before anonymising. A member UPDATE first commits a short `FOR KEY
  SHARE` reservation, calls Xero outside transactions, then completes its
  operation and canonical link together under that Member `FOR UPDATE`. Retries
  rebuild from the current Member only; a missing/deleted member never falls
  back to stored pre-deletion PII. The symmetric create reservation, manual Link
  and provider-returned local-link paths re-read
  the canonical deleted-member marker under their own Member lock before any
  provider call or attribution. A deleted account can therefore neither send its
  pre-deletion profile to Xero nor regain a contact link. Manual Link commits the
  Member pointer and FK-less canonical CONTACT ledger row in the same transaction,
  so member merge cannot leave a ledger row naming a deleted losing identity.
  Account deletion deactivates that CONTACT ledger in the same anonymisation
  transaction that clears the Member pointer.
  A canonical link commit also CLOSES the provider-created create it just
  completed, in that same transaction: a `FAILED` member CONTACT create that
  proves Xero made contact X, where X is now the member's link, becomes
  `SUCCEEDED` through a status-guarded claim. Nothing else is touched — a
  `RUNNING` reservation is live provider work, and a create that made a
  *different* contact stays open because Xero then holds a duplicate for this
  member that an operator must adjudicate. Without this the blocker predicates,
  which never consult `Member.xeroContactId`, kept refusing member merge and
  account deletion for a member who had already been recovered. Merge, deletion
  and the member detail display read that blocker through one predicate, so a
  refused member can never render as reconciled, and each refusal names the
  blocking operation and the Admin → Xero → Operations screen that clears it.
  Only an explicit `repairExistingLink` may reserve a CREATE for an
  already-linked member, and repair re-resolves by exact non-archived name
  before creating, so a live same-named contact is re-linked rather than
  duplicated.

### INV-HOST-030

- **Every confirming path re-reads the facts at confirmation, and the census proves
  it two ways** (§9). Most reconcile inside their own transaction, which REFUSES an
  uncovered booking at an enforcing club. Those that cannot — capacity claimed, money
  in flight or settled — record the bounded re-evaluation inside the confirming
  transaction and escalate after commit, which is §8's treatment of payment lifecycle
  and automated status transitions. The set includes the single payment settle door
  (whose payable set includes DRAFT), the fully-credit-covered settlement, inbound
  Xero PAID, the admin waitlist force-confirm, the member's zero-dollar waitlist
  confirmation, the draft confirmation, the
  saved-card auto-charge cron, the officer "confirm pending guests" claim, the
  Internet Banking switch, group-settlement child confirmation, and the
  group-settlement reaper's `CONFIRMED -> PAYMENT_PENDING` revert, which de-confirms
  a coverage SOURCE. `adult-member-hosting-call-sites.test.ts` asserts both who USES
  each seam and — separately — that no confirming write uses NEITHER, because the
  first assertion alone cannot see a path that skips the rule entirely. That
  distinction is load-bearing: DRAFT, WAITLISTED and WAITLIST_OFFERED are all outside
  `ACTIVE_BOOKING_STATUSES` and so invisible to the strand check, making those gaps
  deterministic rather than races.

### INV-HOST-031

- **The coverage race and the member-merge attribution race have one ordered
  handshake** (#2576, #2597). The coverage decision is closed by a per-OWNER
  advisory lock (`hosting-coverage-owner`).
  An earlier design argued no new lock was needed because coverage is same-lodge by
  definition, so the per-lodge capacity lock already serialised both sides. That was
  false in both directions at the time: cancellation and booking writers did not all
  share one key. The direct guest-add route now composes global → lodge, but the
  booking-request capacity hold remains a lodge-only active linked-guest writer; the
  shared subject/linked-member row protocol above closes every standing-change edge.
  The invariant itself is per-owner, so the key is the owner (the
  same reasoning behind `lockBookingMemberNights`); it is taken by the evaluator, the
  settle step, the enqueue-only seam and the member fan-out, always LAST after the
  existing global → sorted lodge → roster-date → applicable member tiers and the
  queue-participant Member rows, and only where the scope is enabled. Ordinary seams
  try sorted owner keys before their re-entrant blocking acquisition, so a repeated
  bulk call cannot wait while holding an earlier key.

  Member merge takes the counterpart direction without losing an obligation. After
  its relation moves it plans the bounded survivor-attendance and captured
  loser-owned booking union, locks master, loser and every ancillary owner in one
  sorted `Member FOR UPDATE`, and re-plans under those rows. Drift returns 409; no
  participant is added late. It then takes sorted coverage-owner keys, re-points both
  queue owner and FK-less actor rows that landed after the ordinary relation sweep,
  folds the actual counts into the critical merge audit, creates actorless
  `SYSTEM_CHANGE` work, and only then deletes the loser. Ordinary-first therefore
  commits before the merge sweep, while merge-first makes ordinary `NOWAIT` and roll
  back. Policy CRUD/config-transfer retain their earlier policy-set serialization,
  and notification providers retain #2596's exact-token, post-transaction boundary.
  See [`CONCURRENCY_AND_LOCKING.md`](../CONCURRENCY_AND_LOCKING.md).

### INV-HOST-032

- **An incident is only ever opened for a booking the club has accepted.** §7 and
  §16 are about a booking that becomes uncovered AFTER confirmation, so the opener
  requires confirmed active attendance. This is load-bearing rather than tidy: the
  auto-charge claims PENDING → CONFIRMED, queues the work, and releases the claim
  back to PENDING if the charge fails — without the test the drain would put a stay
  nobody confirmed in front of an officer as an emergency. It does not RESOLVE a
  standing incident on a regressed booking either, because that booking still holds
  its beds and reporting `COVERAGE_RESTORED` would be untrue.

### INV-HOST-033

- **One active incident per booking; owner notification is fenced, at-least-once delivery** (§16). The partial
  unique index `HostingCoverageIncident_active_booking_unique` makes the first an
  invariant against a concurrent second opener rather than a hope; the loser folds
  into the winner instead of surfacing a constraint violation. The stored `stateKey`
  is a fixed-width digest of the material-identity key, so a large party cannot
  outrun the column and make two different problems compare equal. The owner's
  notification takes a short delivery lease with an opaque claimant token before
  the send, but `notifiedStateKey` is stamped only after transport reports success.
  Immediately before provider input is read, a guarded update renews the lease only
  while the incident is unresolved, unnotified, and that exact state/token is still
  current. An expired-but-unreclaimed claimant can therefore continue, while a
  successor token and the old worker race on the row and only one wins. A final exact
  read then freezes recipient data and the incident's own evidence at the renewed
  timestamp; a stale or reclaimed worker calls no provider and never substitutes a
  later live booking review into an older claim. Completion and release match the
  same token, so a stale sender cannot complete or clear a successor's lease. Missing email,
  placeholder/bounce suppression and a deliberate per-booking `noEmails` switch are
  terminal while the incident stays visible to officers. An unreadable `noEmails`
  flag is transient: the notification lease is released and the exact queue claim
  fails, because `hosting-coverage-lost` deliberately has no independent EmailLog
  retry authority. The provider stays outside transactions, leaving only the narrow
  race after the final token read rather than holding a transaction across delivery.
  At most one exact claimant is active for each renewed lease. There is still one
  unavoidable post-provider ambiguity: if the provider accepts the message and the
  process dies before `notifiedStateKey` is stamped, the next lease may send the same
  transition again. The provider has no idempotency-key contract; stamping before
  transport would trade that rare duplicate for a permanently lost notice. This is
  therefore at-least-once delivery with one durable success stamp, not an
  exactly-once email guarantee. A crashed sender's lease expires after 15 minutes.
  The re-evaluation queue uses the
  same 15-minute token fencing for completion and failure, claims serial work one row
  at a time, and excludes ids already attempted by that drain: a slow later item is
  not pre-leased and a released failure cannot burn several attempts in one pass.

### INV-HOST-034

- **Resolution is recorded, not inferred**, as one of `COVERAGE_RESTORED`,
  `BOOKING_AMENDED`, `EXCEPTION_APPROVED` or `BOOKING_CANCELLED` — inferring it from
  the absence of a hazard would report restored cover for a booking somebody
  cancelled. Resolution is idempotent (a guarded `updateMany` on `resolvedAt: null`)
  and a club that turns enforcement off has its incidents closed rather than left as
  rows nobody can act on.

### INV-HOST-035

- **Three of the four resolutions fire from a change to the AFFECTED booking, and
  that needed its own seam.** The re-evaluation fan-out is built on
  `sameOwnerCoverageDependentWhere`, which excludes the booking being changed
  (`id: { not: booking.id }`), so every list the settle step computes is a list of
  OTHER bookings and nothing done TO an affected booking could reach its own
  incident. `resolveOwnCoverageIncidentAfterChange` closes it, from facts the same
  transaction has just written: the booking is no longer happening →
  `BOOKING_CANCELLED`; an officer has APPROVED its hosting review →
  `EXCEPTION_APPROVED`; the reconciliation that just ran CLEARED the review, so its
  own facts no longer carry the hazard → `BOOKING_AMENDED`. `COVERAGE_RESTORED` is
  deliberately not decided there — it is a fact about ANOTHER booking supplying
  cover, which only the post-commit drain can establish against committed rows.
  `booking-exception-approval.ts` closes the incident in the same transaction as the
  officer's decision for the same reason: an approved exception AUTHORISES the hazard
  rather than removing it, so the drain's "is the violation gone" test can never see
  it, and the next pass would otherwise re-affirm a `critical` incident against the
  officer's own decision. Approval means approval for THIS hazard: a materially
  different uncovered state reopens the review as PENDING and drops the decision, so a
  stale approval cannot suppress a new problem.

### INV-HOST-036

- **The queue is at-least-once; database effects are idempotent and provider delivery
  has an explicit ambiguity.** Work is recorded in
  the transaction that caused it, drained inline immediately after that commit
  (best-effort, since the authoritative change must not be undone by a follow-up
  problem) and again by the `hosting-coverage-reevaluation` general-cron job, which
  is the authority on completion. `attempts` increments at CLAIM time, so a process
  that dies mid-item still counts up and a poison item retires. Incident/review and
  queue completion effects are guarded and idempotent; email is the stated
  at-least-once exception when a crash lands after provider acceptance but before
  the durable success stamp.

### INV-HOST-037

- **The Booking Officer queue is in the bookings area.** Every unresolved incident
  appears prominently above the ordinary `/admin/bookings` list, with booking
  reference, owner, lodge, dates, uncovered guest-night count, cause and direct
  navigation. The support Stuck States dashboard mirrors the count and oldest 50
  direct rows, but is not the only way to discover or act on the incident. Resolving
  the underlying condition clears the row automatically; there is no separate
  acknowledgement that could hide a still-uncovered booking.

### INV-HOST-038

- **The inline drain is scoped to the booking that was just written; the cron drains
  everything.** A member's request passes `{ bookingId }`, which resolves that
  booking's owner and lodge and claims only their items with a small limit. An
  unfiltered inline claim meant that after an officer's bulk cancellation or a
  membership sweep left a backlog, the next unrelated member's guest edit would run up
  to 25 OTHER owners' reconciliations — each fanning out to as many as 25 dependents,
  each able to send a synchronous loss-of-cover email — inside their request before it
  answered. Correctness survived (failures are swallowed and the cron re-runs the
  items) but the route could hang. The job-shaped callers that genuinely span owners —
  a bulk deactivate, a membership archive, the group-settlement reaper and settle, the
  confirm-pending cron — pass a limit instead of a booking, because a group's children
  belong to different joiners and one person can attend bookings owned by several
  accounts.

### INV-HOST-039

- **Every path that can ENQUEUE must also DRAIN**, and the census asserts it
  tree-wide rather than against a hardcoded list: any file naming one of the three
  enqueue seams must also name `settleHostingCoverageAfterCommit(`. The
  transaction-scoped helpers are exempt because they run inside somebody else's `tx`
  and have no commit of their own — and a second assertion now PROVES that exemption's
  premise by checking their callers, which is how the member-guest consent decline and
  expiry path was caught reconciling through the shared removal service and committing
  without draining.

### INV-HOST-040

- **The dependent reads have their own ceiling, ordered and logged.** The
  safe-failure argument for the SOURCE read inverts for them: a truncated source read
  sees fewer hosts and errs towards flagging, while a dependent dropped by the ceiling
  is neither refused under `BLOCK` nor enqueued, and the drain silently skips it. So
  `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT` is a separate constant that cannot be tuned by
  somebody reasoning about the other one, both reads order by `checkIn` then `id` so
  the truncation is reproducible rather than whatever 25 rows Postgres returned, and
  `warnIfCoverageDependentCeilingBound` logs owner and lodge when it binds.

### INV-HOST-041

- **A cancellation NOBODY ASKED FOR re-checks supervision too, and can never be
  refused for it** (#3209, §8). The confirming half above has a mirror: a booking
  stops supplying cover the moment it leaves CONFIRMED or PAID, so a writer that
  flips one to a terminal status owes the same re-read a confirming writer owes.
  Four did not do it — the group organiser cancel, the Internet Banking hold
  expiry, the Stripe capacity-failed void and the cross-lodge price-drift unwind —
  and the first two freed the beds correctly, so the cancellation read as fully
  reconciled while the qualifying adult vanished from another booking of the same
  owner with no incident, no owner email and nothing in the officer queue. All four
  now reconcile inside their own cancelling transaction, so the obligation commits
  with the cancellation, and drain afterwards scoped to the booking that was
  cancelled — per child on a group cancel, because every joiner is a different
  owner and the organiser's own drain cannot reach them.

  They reconcile through `reconcileHostingReviewForSystemCancellation`, and that is
  the second half of the rule. These transitions have no actor to ask and no caller
  to answer. `HostingDependentCoverageDisposition` in
  `adult-member-hosting-review.ts` states the rule in as many words — "§8's list of
  changes that cannot reasonably be blocked includes every automated path" — and
  the seam is what makes it hold as code rather than only as intent. (`INV-HOST-028`
  is a different rule and does not cover this: it is about
  `SameOwnerCoverageOverrideRequiredError` and an authorised officer, not about
  `AdultMemberHostingRequiredError`.)

  **The seam REMOVES the refusal rather than catching it**, by passing
  `enforcement: "REVIEW_ONLY"`, and the distinction is load-bearing. The dependent
  disposition is the default `ESCALATE`; the booking itself is already terminal and
  so has no hazard of its own; what remains is the sibling loop, where a #738 split
  sibling left uncovered by this very cancellation would otherwise raise
  `AdultMemberHostingRequiredError` at an ENFORCED lodge and roll the cancellation
  back — wedging an expired Internet Banking hold, because the next run re-reads the
  same rows and refuses again, deterministically, every fifteen minutes. `REVIEW_ONLY`
  travels into the sibling loop by design, so the sibling RECORDS its hazard in the
  same transaction instead. Catching the refusal was tried first and was wrong: the
  refusal is raised by the SIBLING while the fallback enqueued for the cancelled
  SOURCE, and at the default host scope (`sameBookingOwner: false`) a terminal source
  yields an empty dependent list — so at the configuration most clubs run, the catch
  recorded nothing at all. This is the second position in the tree that reaches for
  `REVIEW_ONLY` for that reason rather than for §13's school carve-out; the other is
  the post-commit incident drain, where refusing would roll back the incident that is
  the point of the call. `INV-HOST-020`'s census names all three and makes a fourth
  state which it is. Nothing is caught: a participant retry and a database failure
  propagate to the callers' existing re-drive boundaries.

  `adult-member-hosting-call-sites.test.ts` holds both halves. It finds terminal
  status flips **by the write itself** — a `data:` object assigning CANCELLED,
  EXPIRED or BUMPED inside a `booking.update`/`updateMany` — and requires a seam
  within the **enclosing function**, not merely somewhere in the file. Both
  refinements were paid for by real misses: keying on
  `RELEASE_WHOLE_LODGE_HOLD_UPDATE`, which `booking-status.ts` claimed was "spread
  into every terminal status flip", left ten cancelling writers invisible, and a
  whole-file search passed `payment-reconciliation.ts` while its capacity-failed
  void reached no seam at all. The constant is kept as a secondary signal: a file
  that spreads it but shows no detected flip has to say why, so a flip written in a
  shape the reader misses cannot make the sweep quietly vacuous. Exemptions are
  keyed `file::function` and each names the status the writer really flips FROM.
  What the sweep cannot do is prove the seam sits on the same control-flow branch as
  the flip; that needs reachability analysis rather than text, so it is a floor and a
  reviewer still decides.

  **A re-drive DOES exist for the group case, and the argument above does not rest
  on its absence.** `cron-group-settlement-reaper.ts` →
  `resumeInterruptedOrganiserCancels` (#1236) selects `ORGANISER_PAYS` groups whose
  ORGANISER BOOKING is CANCELLED, older than a short grace, still holding
  `organiserSettled` children in the active set, and re-invokes the same idempotent
  cleanup. `GroupBooking.status` is not in that query, so a group already fenced
  CANCELLED is re-driven like any other, and the child status set it looks for is
  the same `ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES` the cancel loop claims — one
  declaration in `booking-status.ts` since #3209 rather than the identical copy in
  each module (`INV-SSOT`), so the two can never drift. The reason a refusal still must not reach
  these paths is that it is DETERMINISTIC: a re-drive re-reads the same rows and
  refuses again, forever, which is a wedge rather than a recovery.
