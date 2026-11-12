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

- **Host identities are never disclosed to the booking owner; the CATEGORY of
  cover is disclosed deliberately.** Member-facing refusal bodies are built by
  `buildAdultMemberHostingRefusalBody`, which strips
  `qualifyingHostsByNight[].memberIds` while keeping the nights and the scopes
  that covered them. The frozen snapshot an officer reviews keeps the ids in full
  for validation and audit. Applied under every scope, not only the wider one: a
  redaction that fires under one setting is a redaction nobody tests.

  **What is withheld is WHO, and only who.** Under `SAME_BOOKING_OWNER` that was
  easy to justify — the covering stay is on the member's own account, so telling
  them another of their bookings supplies or depends on cover (#2576 §11)
  disclosed nothing they did not already know. **`SAME_GROUP_TRIP` (#3038) breaks
  that premise and keeps the behaviour**, on an owner decision of 31 August 2026:
  a member refused on a Group Trip booking learns, per night, that *another
  account's* booking in their trip carried a qualifying adult. That is disclosed
  on purpose. People travelling together on one trip already know roughly who is
  present, and the member has a problem to fix — being told which night is short,
  and that the trip is where cover comes from, is the kinder and more actionable
  answer. The identity itself is still withheld, under this scope exactly as
  under the others, and no message names a booking, a member or a household.

  The rationale matters as much as the rule here: an invariant that justified the
  disclosure on "it is their own account" would be asserting something false the
  moment a third scope existed, and a wrong reason is how a later change deletes
  the right behaviour.

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
  The invariant itself is per-owner, so the key is the owner; it is taken by the evaluator, the
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
### INV-HOST-042

- **WHICH LODGE decides that no supervision work is owed is a question about the
  RELATED bookings, not only the changed one** (#3209). Clubs configure adult-member
  hosting per lodge — a lodge row overrides the club-wide row — so one member can
  hold a booking at a lodge that has the rule off and another, related to it, at a
  lodge that enforces it. The #738 split-sibling relation the engine fans out over
  (`hostingSiblingWhere`: direct parent or direct child, same member) carries no
  lodge clause at all, so "the booking that just changed is at a lodge with the rule
  off" says nothing about the booking whose answer depends on it.

  `reconcileAdultMemberHostingReviewWithSiblings` used to return on exactly that
  half-question, before the sibling fan-out ran, so the related booking at the
  enforcing lodge was never re-read when this change took its cover away: no review
  recorded on it, nothing in the officer queue, and the member never told. All eleven
  writers that reach the engine through that entry point inherited the gap, which is
  why the fix is in the entry point and in no writer. The gate now skips only when
  this booking's lodge is inactive **and** no related booking sits at an active one.

  **The same-owner half needs no such widening, and that is a property of the query
  rather than an assumption.** `sameOwnerCoverageDependentWhere` pins `lodgeId` to
  the changed booking's own lodge, so a same-owner dependent is always at this lodge,
  and `settleSameOwnerDependentCoverage` re-reads this lodge's mode and returns on
  the same test — skipping it under an inactive lodge can therefore miss nothing.
  "keeps the dependent cohort at the changed booking's own lodge" in
  `adult-member-hosting-same-owner.test.ts` pins the clause so that sentence cannot
  quietly stop being true.

  **Reachable today?** No, and the honest answer matters more than a scary one. Every
  parent/child pair the product can currently create is written at one lodge —
  `booking-create.ts` sets the split child's `lodgeId` to its parent's, and a group
  joiner's booking belongs to a different member and so is not a sibling at all — and
  `Booking.lodgeId` is never written after create, which
  `bed-allocation-lock-topology-contract.test.ts` -> "no writer moves a Booking
  between lodges" fails the build over. So this was latent: a wrong rule that the
  current data shape happened not to exercise, found while fixing `INV-HOST-041` and
  fixed in the same pull request rather than filed, because the next feature that
  relates two bookings across lodges would have shipped the silent failure.

  **`INV-LOCK-002` and #2623 T5 both survive it, deliberately.** The gate must not
  start charging a club that owes nothing the `Member FOR KEY SHARE NOWAIT`
  participant proof — that is the whole of T5, and paying it would put the fixed
  `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409, which tells a member to check their
  payment status, back in front of ordinary booking writes at every non-participating
  lodge. So the widened question is answered with reads that take no lock: one
  indexed read of this booking's parent and children over `Booking(parentBookingId)`,
  and a policy read only for lodges that are **not** this booking's own — which is
  none at all for a pair at one lodge. When the answer is yes the fenced body runs
  whole, so the Member rows are still acquired before any coverage-owner advisory key
  (including the one the sibling's own evaluation takes under the sibling's lodge
  policy), and deciding to skip acquires nothing and so can leave nothing held out of
  order. Both halves are pinned behaviourally in
  `adult-member-hosting-same-owner.test.ts` -> "the mode gate reads the RELATED
  bookings' lodges too", and the skip's `failFastCoverageOwner` flag structurally in
  `adult-member-hosting-call-sites.test.ts` -> "keeps the un-fenced return fail-fast
  on the coverage-owner key".

## Optional Group Trip cover (#3037, epic #2943)

### INV-HOST-047

- **`SAME_GROUP_TRIP` is a third, optional host scope, and it is OFF unless a
  club turns it on.** It is APPENDED to `ADULT_MEMBER_HOST_SCOPES` and never
  inserted ahead of an existing value: `enabledHostScopeList` iterates that
  constant to sort `coveredByScopes` and `enabledHostScopes` onto frozen
  violation snapshots, so a reordering would rewrite the bytes of snapshots
  nobody edited and reopen decided reviews. The built-in default is unchanged —
  same-booking only — so a club that upgrades and changes nothing gets
  byte-identical answers, including the member-facing sentence and the material
  identity key. Enforced by `src/lib/__tests__/group-trip-identity.test.ts`,
  whose failure messages carry this id.

### INV-HOST-048

- **The Group Trip column is deliberately NOT part of the all-or-none scope
  CHECK, and NULL on a decided row means OFF rather than inherit.**
  `INV-HOST-014` binds `hostScopeSameBooking` and `hostScopeSameBookingOwner` to
  all-null or all-set; `hostScopeSameGroupTrip` is bound only to "never set on a
  row that did not decide the pair". Widening the all-or-none rule to three
  columns would refuse a draining previous colour's policy INSERT, which names
  only the two columns it knows, and a backfill cannot help because it fixes the
  rows that exist rather than the ones the old colour is still writing. So
  `rowHasHostScopes` tests the pair alone and `rowHostScopes` reads the third
  column with `=== true`: a row written before this migration, or by the previous
  colour during a deploy, keeps the scope set it decided with Group Trip cover
  simply off. The weaker CHECK is the best rule available, not a complete one:
  an old-colour UPDATE that returns a row the new colour had decided to
  "inherit" nulls only the pair, leaves the Group Trip column set beneath it and
  is refused with 23514. No constraint tying the column to the pair can avoid
  that, it fails closed on one row rather than half-writing a policy, and the
  only UPDATE-safe alternative — no constraint at all — readmits the shape that
  has no reading. Enforced by `src/lib/__tests__/group-trip-identity.test.ts`
  (the decided-row-with-NULL case) and by the config-transfer suite, which pins
  that a legacy decided row does not round-trip as a spurious change.

### INV-HOST-043

- **Group Trip identity is `GroupBooking.organiserBookingId` and
  `GroupBookingJoin.bookingId`, resolved in one module, and the container's own
  status governs joining rather than cover.** `src/lib/group-trip-identity.ts` is
  the single home, and `Booking.parentBookingId` is forbidden as an identity
  source: it is the #738 split-booking relationship, neither necessary nor
  sufficient for Group Trip membership, so reading grouping off it produces a
  sibling set that is wrong in both directions.

  **ONE CARVE-OUT, WITH ITS FENCE NAMED: the second half of a #738 split pair
  inherits the first half's Group Trip** (owner decision, 31 August 2026). A
  member joining a Group Trip with a mixed party becomes two `Booking` rows —
  `createConfirmedBooking` writes the member half, hangs the non-member half off
  it by `parentBookingId`, and writes the `GroupBookingJoin` row against the
  member half only, because one party is one joiner on the roster and the
  `(groupBookingId, joinerMemberId)` unique pair says so. Without the carve-out
  the half carrying the NON-MEMBER GUESTS, the rows this rule exists to judge,
  belonged to no Group Trip and received no cover: the join preflight judged the
  undivided party and said yes, and the reconciler judged the child and said no,
  seconds apart. A split pair is one party, so its two halves share one trip.

  **The fence, which is the whole safety of it.** `parentBookingId` is still
  categorically not a Group Trip identity source, and a booking still never
  borrows identity from an unrelated parent. Inheritance happens only from a row
  that is already a `SAME_BOOKING` split sibling — `booking.parentBookingId`,
  owned by the SAME member, not cancelled, not bumped, not soft-deleted — and is
  followed ONE WAY, so a parent never inherits from a child. A #796 group
  joiner, which hangs off the organiser's booking by the same column while
  belonging to a different member, therefore inherits nothing and needs nothing:
  it carries its own roster row. Inheriting also governs only what a booking
  RECEIVES: the source and dependent sets are relation-based, so an inheriting
  child supplies nothing and is not itself a Group Trip source — the right answer
  as well as the safe one, since it carries only non-member guests. **What it
  obliges of #3039:** the dependent set is relation-based too, so a Group Trip
  fan-out finds the split PARENT and not the inheriting CHILD — the child is
  reached only through the existing `SAME_BOOKING` sibling fan-out
  (`loadHostingSiblingIds`, which `reconcileAdultMemberHostingReviewWithSiblings`
  already walks), so the group fan-out must reconcile each dependent through
  THAT entry point rather than reconciling the row directly, or the half carrying
  the non-member guests is never re-evaluated.
  `inheritedSplitPairGroupTrip` is the one
  implementation, and `adult-member-hosting-group-trip-cover.test.ts` pins every
  clause of this paragraph, including that a booking related by
  `parentBookingId` in any OTHER configuration supplies and receives nothing.

  **Two guards hold the fence, and the stronger one is the type.**
  `inheritedSplitPairGroupTrip` takes its subject as
  `Pick<LoadedHostingBooking, "parentBookingId">` — it is never handed the
  evaluated booking's own `id`, so it cannot be widened to follow children
  without someone changing the signature, which no accidental tidy does. The
  behavioural fence is the second guard and catches what the type cannot: a
  widening of the choice WITHIN the sibling set, such as taking the first sibling
  rather than the parent, or the first sibling that happens to be in a trip.
  Both of those shapes are pinned by fixtures that put a decoy sibling in a trip
  beside a parent that is in none.

  **EVERY evaluator applies the carve-out, or two of them disagree about the one
  booking it exists for.** A split child is modifiable like any other booking, so
  the persisted reconciler is not the only path that asks the hosting rule about
  it: `evaluateProposalPartyViolations` re-judges a proposed party server-side
  and FREEZES the answer into a policy-exception request, which an officer
  reviews and which reserves beds under `HOLD`. An evaluator that resolves
  identity from the two canonical relations alone answers "no Group Trip" for
  precisely the split child — so it would invent a hosting violation on the one
  shape the rule was taught to get right, and approval reproduces the same
  evaluation, so the #2525 drift gate compares the phantom with itself. The
  shared reader `readInheritedSplitPairGroupTrip` exists so the second path
  applies the SAME fence rather than a second copy of it, and
  `adult-member-hosting-call-sites.test.ts` pins that the exception path calls
  it and that `inheritedSplitPairGroupTrip` has exactly one definition tree-wide.

  The two write paths keep their roster row ahead of the rule for the same
  reason: `createConfirmedBooking` claims the `GroupBookingJoin` row BEFORE it
  creates and reconciles the split child, and `verifyAndCreateNonMemberJoin`
  claims its row before it reconciles at all. A reconciliation that ran first
  would read a brand-new booking as belonging to no Group Trip.

  `GroupBooking.status`
  (`OPEN`/`CLOSED`/`CANCELLED`) decides whether new bookings may join; a CLOSED
  container is the normal state of a settled party and a cancelled container does
  not cancel the joiners' own bookings, so filtering the source or dependent set
  on it would strip cover from live compliant bookings and drop bookings that
  still need reconciling. Whether a booking is really happening stays a question
  about `Booking.status`. Identity is also available PRE-PERSIST for a join —
  `groupTripIdentityForJoin` takes it from the container the joiner redeemed a
  code for — because both join paths must answer the hosting rule before the
  `Booking` row exists. The separate paid-up-adult lockout
  (`PAID_UP_ADULT_MEMBER_REQUIRED`) remains per-booking and is not widened across
  a Group Trip. Enforced structurally by
  `src/lib/__tests__/adult-member-hosting-call-sites.test.ts` and
  `src/lib/__tests__/group-trip-identity.test.ts`, and behaviourally by
  `src/lib/__tests__/adult-member-hosting-group-trip-cover.test.ts`, which also
  pins two of the write orderings the pre-persist half depends on: the non-member
  verify claims its `GroupBookingJoin` row before it reconciles hosting, and the
  member join hands its preflight the container id it already holds. The third —
  `createConfirmedBooking` writing the roster row before it creates and
  reconciles the split child — is pinned structurally in
  `adult-member-hosting-call-sites.test.ts`, because both orders typecheck and
  every behavioural suite passes either way, so a later tidy moving the block
  back would otherwise be green everywhere.

### INV-HOST-044

- **A Group Trip host is HOST-ONLY, counted ONCE, and read under a bound of its
  own.** Where a club has enabled `SAME_GROUP_TRIP`, qualifying adult members
  attending another live booking in the same Group Trip enter the evaluation as
  `hostScope: "SAME_GROUP_TRIP"`, `hostOnly: true` participants built by the
  canonical `toHostingParticipants`. Three consequences, and each is a rule
  rather than an implementation note.

  **Host-only means no bed, participant, price, payment or responsibility
  moves.** The adult's real attendance on their own booking is recognised as
  evidence; they are never duplicated as a guest here, and their own booking's
  uncovered guest-nights stay that booking's hazard, judged when it is
  reconciled. Two separately owned bookings keep two separate lifecycles.

  **Counted once means the source read excludes what a narrower scope already
  loaded.** `loadSameGroupTripHosts` is passed the split-sibling ids
  (`SAME_BOOKING`) and the same-owner source ids (`SAME_BOOKING_OWNER`) and
  excludes them in the query. Coverage itself would survive a duplicate — hosts
  are counted into a set of member ids — but the frozen snapshot would not:
  `coveredByScopes` would credit a scope that supplied nothing new, and that
  field is what the kiosk cover-source display reads. The exclusion is keyed on
  the rows actually read, so with the same-owner scope OFF the same booking is
  legitimately picked up as a Group Trip source instead; the union of cover is
  the same either way, and only the credited scope differs.

  **Bounded by `SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT`, which is deliberately
  NOT the same-owner number.** Twenty-five bookings on one account at one lodge
  is a data problem; twenty-five bookings in one Group Trip is a club trip, so
  borrowing that ceiling would truncate ordinary large parties. One booking needs
  at least one bed, so the population is bounded above by the lodge's capacity —
  the bound is argued from that shape and never from how big any particular
  club's lodge is, which `INV-CONFIG-001` forbids the codebase to encode. A
  writer truncates, which errs towards the rule; an evidence caller passes its
  own ceiling and is refused with
  `HostingGroupTripSourceCeilingExceededError` rather than handed a quietly short
  host list that would fabricate a live blocker. The diagnostic pack IMPORTS the
  writer's constant rather than restating the number beside a promise that the
  two agree.

  **Both cross-booking source reads are ONE read, ordered unconditionally.**
  `loadSameBookingOwnerHosts` and `loadSameGroupTripHosts` are
  `loadCoverageSourceHosts` with one relationship clause changed, so the guest
  narrowing, the ordered-truncation protocol, the defensive guest-relation
  filter and the `sourceIds` contract have one definition rather than two
  (`INV-SSOT-001`). `COVERAGE_READ_ORDER` applies to a writer as well as to an
  evidence caller: an unordered `take` lets the database return any N of the
  matching rows, which leaves the ANSWER safe (fewer hosts errs towards the
  rule) and the SNAPSHOT unstable — `adultMemberHostingStateKey` moves between
  two evaluations of an unchanged booking, reopening the incident and
  re-notifying an officer over nothing.

  **Member-owned and non-member-owned joins consume this cover on identical
  terms.** Nothing about who owns a source or a dependent booking is consulted —
  that is `SAME_BOOKING_OWNER`'s question, not this one. Enforced by
  `src/lib/__tests__/adult-member-hosting-group-trip-cover.test.ts`, whose
  failure messages carry this id.

### INV-HOST-045

- **The kiosk's adult-cover display is DERIVED from the canonical evaluation,
  and a stale, failed or unrecorded evaluation never renders as cover** (#3040,
  epic #2943). The privileged kiosk tier may show, on a Group Trip card, where a
  booking's adult supervision comes from. Every value it shows is read by
  `deriveKioskAdultCoverSource` (`src/lib/kiosk-adult-cover.ts`) out of the
  frozen violation snapshot (`Booking.adultMemberHostingReview`, parsed by
  `parseStoredHostingReview`); nothing about cover is recomputed for display.

  **A snapshot records a violation and nothing else.**
  `evaluateAdultMemberHostingWithPolicy` returns `null` when the party has no
  non-member guest-nights or all are covered, and
  `reconcileAdultMemberHostingReview` then writes `Prisma.DbNull` over any
  snapshot already there. So a stored snapshot always records at least one
  uncovered night, "fully covered" is the ABSENCE of a snapshot, and the display
  has no "all covered" wording. A named
  test in `kiosk-group-trip-privacy.test.ts` pins this against the real
  evaluator.

  **Four statuses; only `EVALUATED` carries night rows.** The DTO is a
  discriminated union whose other three members carry the empty tuple for
  `nights` and `scopes`.

  - `NOT_RECORDED` — no snapshot and no signal against it: the ordinary state,
    rendered as muted text, *"Adult cover: no issue recorded for this booking"*.
    Not a warning, and not a positive claim: it cannot tell "evaluated and
    clean" from "never evaluated".
  - `UNREADABLE` — not the canonical shape, or disagrees with itself. Amber.
  - `STALE` — what is recorded cannot be trusted as current. Amber.
  - `EVALUATED` — a recorded problem with per-night evidence: at least one
    night, at least one uncovered.

  **Four staleness signals, consulted in this order:**

  1. A queued `HostingCoverageReevaluation` for the booking's owner at this
     lodge, consulted before the snapshot is read, because it invalidates an
     absent snapshot as much as a present one. Its night list is not
     intersected.
  2. An open `HostingCoverageIncident` on a booking with NO snapshot. With a
     snapshot present the two agree and the snapshot stands. Nothing about the
     incident reaches any payload.
  3. A readable snapshot with nothing uncovered, which no writer produces.
  4. A covered night resting on `SAME_GROUP_TRIP` (below).

  **A partially readable snapshot is `UNREADABLE`, not a partial answer.** No
  malformed night row is skipped. The reader requires the per-night evidence and
  the snapshot's own `uncovered` list to name the same uncovered nights, and
  rejects duplicate nights, a covered night with no scope that supplied it, and
  a scope list naming nothing this deployment has; each guard is
  mutation-verified by a fixture that slips past every other one.

  **`SAME_GROUP_TRIP` cover is withheld until #3039 lands.** A sibling's account
  can invalidate it unseen, so a snapshot with any covered night resting on it
  reports `STALE` as a whole, never by marking the night uncovered. Before
  removing that refusal, #3039 must either enqueue a re-evaluation row for every
  DEPENDENT owner, so the own-owner read finds it, or extend
  `readStalenessSignals` to the owners of the whole group.

  **No requirement in force means no cover line, not `NOT_RECORDED`.** Where the
  club's resolved mode is not a consequence — `DISABLED`, no policy row, or a
  malformed set the resolver refuses — the kiosk omits the `adultCoverSource`
  key, as for a viewer without the capability, and issues no staleness read or
  anything else on that path. The gate is the MODE, never the scope set: with
  `SAME_GROUP_TRIP` off, the `SAME_BOOKING` evidence still shows. It is the one
  club setting the kiosk Group Trip surface consults, and governs the cover line
  alone; the linkage badge is gated on nothing (D1 on #3040, `INV-PRIV-016`).

  **The policy revision is NOT a staleness signal**; adding one would be a
  regression. A revision bump is immaterial to cover
  (`HOSTING_POLICY_RECONCILIATION_SELECT`; `incidentPolicyChanged` compares the
  mode and enabled scope set), and a material change reaches signal 1.

  **`EVALUATED` carries the officer's decision** — `PENDING`, `APPROVED`,
  `REJECTED` or `null` — and the screen says which, since an approved exception
  moves only `Booking.adultMemberHostingReviewStatus`, never the snapshot.

  **Cover is per night.** The per-night rows are the answer; the union of scopes
  is a heading, never a substitute. `coveredByScopes` ABSENT on a covered night
  reads as `SAME_BOOKING` (its documented meaning, `QualifyingHostsForNight`);
  an EMPTY list is `UNREADABLE`.

  **The categories travel; the people do not.** The kiosk drops the member ids
  in `qualifyingHostsByNight` (`INV-PRIV-016`).

  Enforced by `src/lib/__tests__/kiosk-group-trip-privacy.test.ts`,
  `src/app/api/lodge/guests/[date]/__tests__/group-trip-tiers.test.ts` and
  `src/app/(lodge)/lodge/kiosk/_components/__tests__/kiosk-group-trip-card.test.tsx`,
  whose failure messages carry this id. History, measurements and rejected
  alternatives: #3040.
### INV-HOST-046

- **When a change strands another account's Group Trip booking, the change
  proceeds, the sibling is escalated to officers, and the actor is told nothing
  about the other account** (owner contract, epic #2943; implemented by #3039).
  Whether the actor removes the qualifying adult, moves dates, changes lodge or
  cancels, the system does not refuse the valid change: it re-evaluates the
  affected sibling, raises it for officers through the existing incident and
  officer-queue machinery, and discloses nothing.

  **No new refusal exists.** There is no Group Trip counterpart to
  `SameOwnerCoverageWouldBreakError` or to the officer's override prompt, no new
  error body and no new member-facing sentence; a "your group is affected"
  message would be the disclosure this rule forbids, and a test asserts the
  absence. `settleGroupTripDependentCoverage` cannot throw: it records durable
  work and returns.

  **The rest of the cross-account path can return a transient 409.**
  `lockAndVerifyGroupTripCoverageDependents` throws the stable
  `HOSTING_COVERAGE_PARTICIPANT_RETRY` when its fail-fast trip-key acquisition
  loses to any other member's booking write in the same trip, or when the
  sibling set drifts between plan and key; both roll the actor's transaction
  back, and the "reload and try again" discloses nothing about the other
  account. So "the actor is never blocked because of somebody else's booking"
  holds of the OUTCOME, not of every attempt. The one exception is
  `xero-inbound/invoice-paid-effects.ts`, which reaches
  `enqueueOwnHostingCoverageReevaluation` inside a `PAID` claim for an invoice
  already paid and passes `GroupTripFanOutOptions.bestEffort`, so the
  cross-account half degrades instead of refusing. That is legal only where a
  transition cannot remove cover (`PAYMENT_PENDING -> PAID` only adds a source);
  the group-settlement reaper's de-confirming revert must never pass it.

  **The dependent set is the trip at this lodge, with no night-overlap clause.**
  Seams run after the write, so the changed booking's dates are the new ones;
  `groupTripCoverageDependentWhere` therefore composes
  `coverageDependentEnvelopeAcrossNightsWhere` — same lodge, not this booking,
  not soft-deleted, in the active-status cohort, in this trip — and the
  per-dependent re-evaluation decides the rest. The lodge clause and the
  self-exclusion stay. The SOURCE direction keeps its night clause.

  **The fan-out is one `HostingCoverageReevaluation` item per dependent
  booking**, capped by `GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT`, naming that
  booking as `sourceBookingId`, its own owner as `memberId`, the lodge, THAT
  DEPENDENT'S OWN nights (the drain's `loadSameOwnerCoverageDependentIds` reads
  the owner's bookings at that lodge over exactly those nights) and cause
  `SYSTEM_CHANGE` —
  even when the actor's change was an officer override, which is never a
  decision about a third party's booking.
  `assertHostingCoverageQueueParticipantsLocked` requires the runtime-issued
  proof to hold a source whose `bookingId` and `ownerMemberId` are the item's
  `sourceBookingId` and `memberId`, so an item naming the actor's booking as a
  sibling owner's source is refused.

  **The ceiling is its own constant, at the source ceiling's number.** When it
  binds it writes, alongside the log line and in the same transaction, an audit
  row from `reportGroupTripDependentCeilingBound`
  (`booking.hostingCoverage.groupTripFanoutTruncated`, keyed on the
  `GroupBooking`, `severity: "important"`), once per trip per transaction, from
  the fan-out rather than the dependent read. It says any booking in the trip
  beyond the bound was NOT re-evaluated and may be left without its required
  adult.

  **The split half is reached (`INV-HOST-043`).** On EVERY branch, the drain
  expands its dependent list with the booking's `SAME_BOOKING` split halves
  through the borrow's own `hostingSiblingWhere` predicate.

  **The fan-out lives in the three existing seams**, so every writer reaching
  the hosting rule participates (`INV-SSOT-001`):
  `reconcileAdultMemberHostingReviewWithSiblings` (reconcile, which can refuse),
  `enqueueOwnHostingCoverageReevaluation` (confirming paths that must not be
  refused) and `enqueueHostingCoverageReevaluationForMember` (membership
  lifecycle). The membership seam exists because a change in host standing
  (`participantQualifiesAsHost`: a lapse, deactivation, archive, membership
  cancellation, declined consent or Xero "unpaid") removes cover from every
  booking relying on that person, including other accounts' bookings in the
  trip. It plans the person's trips before its participant fence (one plan per
  trip, de-duplicated by `GroupBooking.id`), takes those trip keys before the
  owner keys, and records through `settleGroupTripDependentCoverage`. A fourth
  seam joins the seam list in `adult-member-hosting-call-sites.test.ts` before
  it joins the tree.

  **Closing, reopening and deleting need no hook.** `GroupBooking.status`
  governs joining, not cover (`INV-HOST-043`), so `closeGroupBooking` and
  `reopenGroupBooking` reach the hosting rule nowhere. `booking-delete.ts`
  hard-deletes only `DRAFT` and soft-deletes only `CANCELLED`, neither in
  `HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES`, so a deletion removes cover from
  nobody; the `GroupBookingJoin.bookingId` SetNull and `GroupBooking` cascade
  fire only on a hard delete, and `OPENABLE_ORGANISER_STATUSES` keeps an
  organiser's booking out of `DRAFT` when its group is created, so no cascade
  destroys a live trip's identity.

  Enforced by
  `src/lib/__tests__/adult-member-hosting-group-trip-reconciliation.test.ts`
  and, against real PostgreSQL,
  `src/lib/__tests__/adult-member-hosting-group-trip-races.realdb.test.ts`; the
  writer census is in
  `src/lib/__tests__/adult-member-hosting-call-sites.test.ts`. Their failure
  messages carry this id. History, measurements and rejected alternatives:
  #3039.

### INV-HOST-049

- **The same-owner dependent fan-out reads over the window the changed booking
  VACATED as well as the one it now holds, and each queue item carries the
  DEPENDENT's own nights** (#3232). Both halves, in one rule, because fixing
  either one alone still loses the booking — and the second failure is silent
  where the first is at least visible.

  **THE FIRST HALF.** Every dependent read runs after the write: the writer
  updates the booking and then calls the hosting seam. A single-window overlap
  test therefore compares against the NEW dates, so a booking that was relying on
  the OLD ones fails the test and is not in the set at all. No evaluation, no
  incident, no owner notice, nothing in the officer queue — the booking stays
  recorded as compliant while being uncovered, indefinitely, because nothing looks
  at it again until its owner touches it and its owner has no reason to.
  Concretely: booking A carries the only qualifying adult on nights 10-11, booking
  B is the same owner's at the same lodge on the same nights and is compliant only
  through A, and A moves to nights 20-21. B's checkout (night 12) is not after A's
  new arrival (night 20), so B fails the overlap test and is invisible. The set
  must therefore be the UNION of the vacated and the current window —
  `coverageDependentEnvelopeOverStayUnionWhere`, composed with §1's `memberId`
  relationship by `sameOwnerCoverageDependentOverStayUnionWhere`.

  **THE UNION, AND NOT THE DROPPED CLAUSE THE GROUP DIRECTION USES.**
  `coverageDependentEnvelopeAcrossNightsWhere` (#3039) removes the night
  comparison entirely, which is right there because that fan-out cannot refuse
  anybody: an extra row costs one idempotent re-evaluation that writes nothing.
  Here an extra row is a booking the member may be told they cannot move, so the
  set has to be RIGHT rather than merely not-narrowed. It is, because the fact the
  group direction lacks is available here: only a DATE MOVE makes the old and new
  stay differ, and the writers that perform one hold the previous window in the
  same function that calls the seam. The union is exact — a booking sharing a
  night with neither window cannot have been relying on this booking before the
  change and cannot be after it.

  **WHAT MAKES A WRITER SUPPLY THE VACATED WINDOW IS THE COMPILER, NOT THIS
  PAGE.** `hostingCoverageActorOptions` takes `vacatedRange` as a REQUIRED field,
  so every actor-driven site has to state whether its change moved the stay. Three
  say yes (`modifyBookingDates`, `adminShiftBookingDates`, `modifyBookingBatch`);
  the rest pass `null`, which collapses the union to one overlap test and is
  byte-identical to their previous behaviour. An optional field with a convenient
  default would have compiled every existing caller unchanged and left the three
  date writers exactly as wrong as they were.

  **THE SECOND HALF, WHICH IS THE ONE THAT LOOKS FIXED AND IS NOT.** A queue
  item's nights are what the drain turns back into bookings —
  `loadSameOwnerCoverageDependentIds` reads the owner's bookings at that lodge
  over exactly that window — so an item carrying the CHANGED booking's new nights
  resolves to a dependent list that does not contain the booking the change
  stranded. Widen the read and leave the item alone and the refusal path works
  while the escalation path drops the booking in the background, with nothing
  logged. So the settle step records one item per dependent the changed booking's
  own window cannot reach, naming that dependent's OWN nights
  (`enqueueSameOwnerDependentItems`, gated by `dependentNeedsOwnQueueItem`). In
  the ordinary edit every dependent overlaps and exactly one item is written,
  exactly as before; items appear only after a move, and are capped with the
  dependent set at `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT`.

  **THE TWO HALVES ARE MUTATION-VERIFIED SEPARATELY**, because #3039 measured that
  fixing one and not the other still loses the booking. A single test that only
  fails when both are broken would pass over a half-fix.

  **PER-DEPENDENT ITEMS NEED THE DEPENDENT IN THE PARTICIPANT FENCE**, so the
  dependent set is planned BEFORE the fence and re-verified under the per-owner
  coverage key — the same plan, lock, re-verify, retry protocol the Group Trip
  fan-out uses. No new lock and no new ordering: every same-owner dependent shares
  the changed booking's `memberId` by construction, so the `Member` row set the
  fence takes is unchanged and only the proof's source list grows.

  Enforced by `src/lib/__tests__/adult-member-hosting-same-owner.test.ts` and
  `src/lib/__tests__/adult-member-hosting-linked-move.test.ts`, whose failure
  messages carry this id.

### INV-HOST-050

- **A member is never refused a change they have no way to make; where moving
  one of their bookings would strand another of their own, they are OFFERED the
  linked move** (owner decision, 2 September 2026, #3232). The refusal never
  tells the member to update the affected booking first; every action it names
  is one they can take.

  **The three arms.** *Yes* — both bookings move together, atomically, on one
  combined figure accepted once. *No* — only the changed booking moves, the
  member is told plainly that the other will be left without adult supervision,
  the officer queue gets it and an incident opens whose recorded reason says a
  member was asked and answered. *Cannot* — where the beds are not there for
  both, that is said plainly and the warn-and-continue path is offered rather
  than a failure.

  **A refusal becomes the offer only when both conditions hold.** First, the
  dependent no longer shares a night with the changed booking (it MOVED AWAY); a
  stranding whose dependent still overlaps, from a guest change or a
  cancellation, keeps the ordinary refusal (`SameOwnerCoverageWouldBreakError`,
  unflagged). Second, shifting the dependent by the changed booking's ARRIVAL
  delta puts it back into a night the changed booking still holds
  (`linkedMoveWouldRestoreCover`). So a shortening with the arrival unmoved, or
  an arrival move too small to carry the dependent inside the new stay, keeps
  the ordinary refusal. The test is overlap, not containment, and only decides
  whether to raise the offer: the real supervision pass over the state that
  would commit remains the authority, so a mixed set (one dependent a shift can
  carry, another not) reaches the offer and is decided there. The hosting engine
  marks the refusal `linkedMoveWouldAnswer` and
  `modifyBookingWithLinkedMoveSupport` prices it into the offer; a path that
  fails to enrich it gives the bare refusal naming an officer, never a silent
  stranding.

  **The offer's price is the real price**: both moves applied through the
  ordinary modification service and rolled back, never a parallel estimator
  (`INV-SSOT-001`).

  **Two state keys.** Declining is bound by the stranded set alone
  (`strandedCoverageStateKey`, shared with the officer's override); accepting by
  `linkedMoveStateKey` — the stranded set, every booking's proposed window and
  the combined money, including the price delta. A stale key of either kind gets
  a fresh prompt, never a silent substitution, judged by the same delivery test
  at BOTH throw sites: a stale answer is a fresh first submission and cannot
  claim an arm the shift cannot deliver.

  **Both money directions are shown whenever both move.** The quote holds a due
  field and a refund field, never one signed number: they do not net off, as
  each booking refunds or charges on its own, and Stripe and Internet
  Banking/Xero settlement stay distinct per booking. Per booking exactly one is
  non-zero; across bookings both can be. Every surface composes the sentence
  from `hosting-coverage-linked-move-client.ts` (`INV-SSOT-001`), states both
  figures when both are non-zero, says they settle separately, and is
  count-driven throughout: the dependent cap is
  `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT`, the arm relied on for informed consent
  names every booking it will leave uncovered, and the both-directions sentence
  says which way the money goes without counting bookings. Every claim must hold
  for both directions: a payable figure's change fee is described as added and a
  refund's as taken off; no fee sentence naming a figure when the combined fee
  is zero; no "one change fee only" on the waiver branch when the primary's own
  fee is also nothing; no promise that the member "will be asked once" where the
  money goes when the request already carried that answer. The offer names
  `policyRetainedAmountCents` summed across every booking that moves.

  **The member cannot save without answering**: Save is disabled until an arm is
  chosen, as on the officer-override arm, and the bottom error slot is an
  announced live region. **No reason is demanded**, unlike §7's override; the
  state key is the proof they were shown the consequence.

  **Only the booking's own member may answer, on either arm.** Declining is
  honoured by the hosting seam only when the actor is the booking owner carried
  on the answer; accepting is refused for a non-owner in `runLinkedDateMove`
  before it writes anything. The answer is deliberately not one of the routes'
  ADMIN-gated fields, which would 403 the only person entitled to answer. An
  officer who means to strand a booking still owes §7's confirmation and reason.

  **Every date-capable member surface offers all three arms.** Both doors, `PUT
  /api/bookings/[id]/modify` and `PUT /api/bookings/[id]/modify-dates`, route
  the arms through ONE shared function, differing only in the single-booking
  writer they hand in (`INV-SSOT-001`); a surface with `INV-HOST-049`'s widened
  read and no offer refuses moves it used to allow. `adminShiftBookingDates` is
  outside the arms: an officer's change escalates through `REQUIRE_OVERRIDE` and
  is never refused for stranding. A census checks its absence from the arms.

  **The *Cannot* arm names the WHOLE stranded set**, priced at nothing, with the
  primary's own figures as the combined ones, and the deferred supervision check
  is skipped on any arm that cannot commit while still governing every arm that
  can.

  Enforced by `src/lib/__tests__/adult-member-hosting-linked-move.test.ts`,
  `src/lib/__tests__/adult-member-hosting-same-owner.test.ts`,
  `src/lib/__tests__/booking-linked-date-move-service.test.ts`,
  `src/lib/__tests__/adult-member-hosting-call-sites.test.ts` (both doors) and
  `src/app/api/bookings/[id]/__tests__/modify-linked-move.test.ts`, whose
  failure messages carry this id. History, measurements and rejected
  alternatives: #3232.

### INV-HOST-051

- **The linked move is atomic and settles once, and whether it charges both
  change fees is a club setting that defaults to charging** (#3232 D2,
  `INV-CONFIG-001`).

  **ATOMIC.** Every write happens inside one transaction, so no state exists in
  which one booking has moved and the other has not. Any failure on the second
  booking — no beds, a minimum-stay violation, a Xero lock date, a member-night
  conflict, or a supervision refusal over the FINAL state — rolls the first one
  back with it. The provider work is the one thing that cannot be inside the
  transaction and is not: each booking's Stripe refund or charge, member email and
  Xero settlement is returned as a `deferredPostCommit` thunk and run after the
  commit, because a provider call under the global money key and a lodge capacity
  key is what the locking guide forbids.

  **ONE COMBINED FIGURE, ACCEPTED ONCE.** Both bookings' price recalculations and
  both change fees are summed and shown before the member accepts, and one
  refund-or-credit choice covers both. Every amount stays integer cents; the
  combined fields are sums of the per-booking ones, never separately derived. The
  due and refund figures are reported separately rather than netted, because
  Stripe and Internet Banking/Xero settlement stay distinct per booking and a
  single signed figure would imply a netting-off that never happens.

  **WHETHER A CARD-OR-CREDIT CHOICE IS NEEDED IS THE WRITE'S OWN ANSWER, CARRIED
  ON THE RESULT — NEVER RE-DERIVED FROM THE AMOUNTS.** The modification service
  refuses a settlement without a method on
  `cardRefundAmountCents > 0 || creditRefundAmountCents > 0`, an OR over BOTH
  options; a quote is priced against ONE of them, and the two come from separate
  policy tiers with their own percentage and their own fixed fee, each floored at
  zero. So the two expressions disagree whenever one option resolves to nothing and
  the other does not — a card tier carrying a processing fee larger than the
  refund, say — and the disagreement is a DEADLOCK, not a cosmetic one: the offer
  says nothing comes back, draws no Return-method control, the member accepts, the
  write demands a method, and the re-quote prices the same way and returns a
  byte-identical offer. Every retry repeats and neither booking moves. The fact
  therefore travels as `requiresSettlementMethod` on the modification result
  (`INV-SSOT-001`), and the panel attaches a method the member has already chosen
  on the strength of the ARM they chose rather than on the strength of that flag —
  a flag going quiet on a re-quote must not un-answer a question they answered.

  **A WAIVER IS RECORDED ONLY WHERE A FEE WAS SUPPRESSED.** `changeFeeWaived` and
  its reason are written from the fee that would have been charged, not from the
  request that asked for the waiver. The flag is passed for every booking the move
  drags along, and `calculateModificationChangeFee` already returns zero for an
  unchanged check-in, a `DRAFT` booking and a move outside every fee band, so
  recording the waiver from the flag alone over-counted exactly the number the
  field exists for — the one a treasurer reconciles against the club setting — and
  wrote "waived because our own supervision rule compelled this move" into the
  history of a booking that was never going to be charged. The stored reason has
  one home in code, because it is written to two places and read as a key.

  **THE SUPERVISION CHECK RUNS ONCE, OVER THE STATE THAT WILL COMMIT.** The
  intermediate state in which one of two linked bookings has moved would be
  refused by this very rule, and no ordering avoids it: move A first and A's seam
  sees B stranded; move B first and B's own seam sees B with no adult. So
  `modifyBookingBatch` accepts `hostingReconcile: "CALLER"` and hands the
  reconciliation back as `pendingHostingReconcile`, which the linked move runs for
  every booking it wrote before committing. Deferral moves the check and never
  removes it, and `booking-linked-date-move-service.ts` is the only caller
  permitted to ask for it.

  **BOTH CHANGE FEES, BY DEFAULT, AS A SETTING.** Both bookings really move, so
  both really attract their fee. Clubs will disagree about whether the second is
  fair when the club's own supervision rule is what compelled the move, so
  `BookingDefaults.linkedMoveChargesBothChangeFees` is the lever, defaulting to
  `true` — a club that means to waive it says so, and an upgrade never silently
  starts giving fees away. The member-facing sentence states which answer the club
  gave, so a waived fee is never described as charged or the reverse.

  **AND THE SETTING REACHES THE PRICING ENGINE, NOT ONLY THE SENTENCE.** It first
  shipped as a display flag: the combined figure was summed from two modifications
  that each charged their own fee, so a club that had waived the second fee told
  the member it was waived and charged it anyway. The waiver is a service argument
  on the modification service (`waiveChangeFee`), passed on the DRAGGED booking
  only — the booking the member chose to move always attracts its own — and it
  takes the same zero branch a parked edit takes, so the zero flows through the
  settlement options, the payment adjustment, the modification row, the audit
  trail and the Xero leg. It is deliberately NOT a field on the request-body input
  type, because that input is the parsed request body on both member save routes
  and a fee waiver living there would be a fee waiver any member could ask for;
  the one file permitted to pass it is censused, exactly as the deferred hosting
  check is.

  **"THERE ARE NOT BEDS FOR BOTH" IS DECIDED FROM A CLASS, NOT FROM A SENTENCE.**
  The `NO_CAPACITY` arm is selected by asking the second booking's refusal what
  kind of refusal it is, and the member path throws `InsufficientCapacityError` —
  the same 400 with the same words as before it was classed, so nothing on the wire
  changed. It has to be a class because the two over-capacity errors
  (`OverCapacityConfirmationRequiredError`, `WholeLodgeHoldBlockedError`) are
  raised on the ADMIN override path only, and a linked move is reachable only for
  the booking's own member: keyed on those alone the arm was unreachable, a full
  lodge propagated a bare 400 about beds on a booking the member had not asked to
  move, and the member was refused with no door — the third distinct way this arm
  was found to be dead. A message match would have worked until somebody reworded
  the message.

  **ONE LODGE CAPACITY KEY COVERS BOTH BOOKINGS**, and that is a property of the
  predicate rather than an assumption: the dependent envelope pins `lodgeId` to
  the changed booking's lodge, so a same-owner dependent is always at the same
  lodge, and no writer moves a booking between lodges. The order is unchanged —
  global `pg_advisory_xact_lock(1)`, then the lodge key, then the participant
  `Member` rows and the per-owner coverage key — and this change adds no new key.
  The ROSTER-DATE family is the one place where composing two booking writes takes
  keys outside a single sorted order: `lockRosterDates` sorts within a call and
  this transaction makes two, so it can hold a later date from the first booking's
  set and then ask for an earlier one from the second's. Every writer in the tree
  that acquires more than one roster-date key holds the global key first, so two
  such acquisitions can never interleave; that constraint is now stated where the
  key is minted and in `docs/CONCURRENCY_AND_LOCKING.md`, because it is what a new
  multi-key roster writer has to honour.

  **THE TRANSACTION IS BUDGETED FOR THE GLOBAL KEY, NOT LEFT ON PRISMA'S
  DEFAULTS.** It is roughly two batch modifications behind a blocking wait for
  `pg_advisory_xact_lock(1)`, and that wait counts against the 2s/5s default — so
  an ordinary cancel or bed assignment legitimately holding the key would abort a
  member's save. It takes the same `{ maxWait: 10_000, timeout: 30_000 }` as
  `assignBedRange`, the longest-lived holder of that key. Contention (P2028/P2034)
  is answered as "nothing was changed, try again in a moment" rather than as an
  opaque 500, because an unmapped contention error reaches the member INSTEAD OF
  THE OFFER and puts them back to being unable to move either booking.

  **AND THE POST-COMMIT WORK IS CONTAINED PER BOOKING.** The transaction has
  committed by then, so a failure there can never mean the move did not happen.
  Uncontained, one booking's follow-up failing meant the other booking got none of
  its own — no Stripe charge for its increase and no recovery row either, since
  that enqueue lives inside the thunk's own catch, no Xero leg, no audit row and no
  member email — while its dates had already changed, and the member was told the
  whole change had failed.

  Enforced by `src/lib/__tests__/adult-member-hosting-linked-move.test.ts`,
  `src/lib/__tests__/booking-linked-date-move-service.test.ts` and
  `src/lib/__tests__/adult-member-hosting-call-sites.test.ts`, whose failure
  messages carry this id.

### INV-HOST-052

- **A booking left uncovered because its owner declined the linked move has its
  own recorded cause, written by exactly one arm, and that cause was registered
  one release before anything wrote it** (#3232 D3, #3241,
  `docs/BLUE_GREEN_MIGRATION_POLICY.md`).

  **WHY ITS OWN CAUSE.** `HostingCoverageIncidentCause` had exactly two values,
  and a member's deliberate, prompted decision was filed as `SYSTEM_CHANGE` —
  the value that means an automatic change nobody could reasonably block. An
  officer reading the booking's history was therefore told the wrong thing, and
  anybody counting incidents by cause had a member's own choice mixed in with
  genuine automatic changes. That count is the one number a club or its committee
  would use to judge whether the supervision setting is working, so merging the
  two corrupts it, and corrupts it quietly. The repository already argues this
  against itself: the docblock on the neighbouring
  `HostingCoverageIncidentResolution` says its values are recorded rather than
  inferred, because "coverage came back" and "the booking was cancelled" are the
  same absence of a hazard and a very different story for an officer reading the
  history. A member's decision and an automatic change are the same kind of pair.

  **TWO RELEASES, AND THE ORDER IS THE RULE.** A production deploy runs
  migrations *before* the new colour takes traffic, while the previous colour is
  still serving against the same database. That colour's generated Prisma client
  knows this type with two labels and cannot deserialize a third. So:

  1. **Expand (#3232, shipped first).**
     `20260909010000_add_owner_declined_linked_move_incident_cause` registered
     `OWNER_DECLINED_LINKED_MOVE` and **nothing wrote it**. A declined offer was
     still stored as `SYSTEM_CHANGE`.
  2. **Runtime (#3241, the following release).** The declined arm — the
     owner-declined branch of `hostingCoverageActorOptions` in
     `src/lib/adult-member-hosting-review.ts` — writes the new value. **Both
     halves have now landed**, and the sequence stands here because the next
     value added to this enum owes the same one.

  Writing it early would not have been a cosmetic risk. `cause` is selected by
  the incident writer's OWN fold read in
  `src/lib/adult-member-hosting-coverage-incidents.ts` — the read every
  re-evaluation drain performs before it opens or folds an incident — as well as
  by the two officer surfaces. A row carrying the value during the drain would
  therefore have broken the reconciliation engine, not merely a screen.
  Registering the label breaks nothing: a client that never meets a value of a
  type is unaffected by that value existing.

  **That claim was measured, not reasoned about.** Every migration on the branch
  was applied to a throwaway PostgreSQL 16, a Prisma client was generated from
  `origin/main`'s own `prisma/schema.prisma`, and that client ran the fold read
  three times: after the expand with no row carrying the new label, **OK**; with
  a row carrying `SYSTEM_CHANGE`, which is what the expand release wrote for a
  declined offer, **OK**; and with that row's cause changed to
  `OWNER_DECLINED_LINKED_MOVE`, **failed** with
  `Value 'OWNER_DECLINED_LINKED_MOVE' not found in enum
  'HostingCoverageIncidentCause'`. The migration header records the same
  transcript.

  **THE WORDING DID NOT WAIT, AND NEITHER DID THE TRUTH.** Two things landed in
  the expand release, so an officer was not misinformed for a release — and the
  runtime half was then a writer rather than a writer plus two screens.

  - The officer-facing phrase for every cause has ONE home,
    `describeHostingCoverageIncidentCause`, and it already names the new value.
    The two surfaces had drifted into two different wordings for the same stored
    value — the bookings queue said "qualification changed", the stuck-state
    dashboard said "system change" (`INV-SSOT-001`). `SYSTEM_CHANGE` now reads
    "no longer covered after a later change", which is true of everything that
    value holds: an administrative cancellation, a lifecycle transition, a data
    correction, a club that tightened its own policy or switched the rule on, an
    officer who confirmed pending guests or force-confirmed and so ADDED people
    the existing cover no longer stretches to, and — while the halves were
    apart — a declined linked move. "Qualification changed" was true of none of
    those, and the interim phrase "cover removed by a later change" was untrue of
    the last three: nothing was removed in any of them.
  - The member's decision is **recorded in words** in the incident's audit
    history. It was already computed and carried on the queue item and then
    dropped, because only an officer override stored a reason, so the history
    showed a bare cause code for a decision a member had deliberately made after
    being warned. The audit row is the right home for it and not only the
    available one: an audit row describes ONE event, so it cannot go stale, while
    a "why" column would be left describing the decline after a later automatic
    change moved the same incident's uncovered state.

  It is **not** written onto `overriddenByMemberId`/`overrideReason`. Nobody
  exercised authority over a booking that was not theirs, so §7's mandatory
  reason and its attribution would both be inventions, and an officer would be
  shown a decision they never made.

  **ONE WRITER, AND THAT IS THE PART STILL BEING ENFORCED.** The writer-ban
  census is gone, deleted by #3241 in the same change that started writing the
  value — leaving it would have made that change unmergeable, and deleting it
  separately would have dropped the guard while the wait was still real. What
  replaced it is an exact-list census: `OWNER_DECLINED_LINKED_MOVE` is produced
  by the declined arm and by nothing else, and named outside a test only by the
  module that declares the union and owns the officer-facing phrase. An empty
  list means the writer was renamed or removed and a declined offer is quietly
  back to `SYSTEM_CHANGE`; a second entry means some automatic change now files
  itself as a member's decision, which is the count this value exists to keep
  clean. Widening either list is a change to this invariant, not a test fix.

  Enforced by
  `src/lib/__tests__/hosting-coverage-incident-cause-expand.test.ts`, whose
  failure messages carry this id: it pins the appended-never-reordered enum, the
  additive DML-free migration, the ledger row's declared deploy order, the
  wording in its one home on both surfaces, and the one-writer census above.
  `adult-member-hosting-same-owner.test.ts` pins the arm itself — the queue item
  the declined offer enqueues, and the cause and reason the drain then stores.

### INV-HOST-053

- **A re-evaluation row's explanation belongs to the booking that row is about,
  and an explained cause is never overwritten by an unexplained one** (#3241).

  **THE SHAPE OF THE DEFECT.** One `HostingCoverageReevaluation` row names an
  owner, a lodge and a night list, and the drain turns that triple back into
  every one of that owner's active bookings over those nights. §14 then asks of
  each "is this booking covered NOW", deliberately, rather than "did this change
  uncover it" — so the sweep also reaches bookings that were already uncovered
  for reasons of their own. Each of them used to be handed the row's `cause` and
  `reason`. An officer's private override reason therefore landed on a booking
  they had never considered, and a member's decision landed on a booking nobody
  had mentioned to them. It also inflated the count `INV-HOST-052` exists to keep
  honest: a club counting declined moves counted bookings nobody declined.

  **WHERE THE VOCABULARY LIVES.** The labels, their ranks, the one officer-facing
  phrase for each and the one stored sentence a declined move records are
  `src/lib/adult-member-hosting-incident-causes.ts`, split out of the incident
  writer by #3241 when the writer had grown to two jobs. Two officer surfaces and
  an audit line want the words and nothing else; the fold wants the ranks
  (`INV-SSOT-001`). The writer re-exports the words for callers that already
  imported them from it — a pointer, not a second definition.

  **THE ACTOR IS NOT THE STORY.** `actorMemberId` still reaches every booking in
  the sweep, because "who did the thing that revealed this" is true of all of
  them and is what an audit trail is for. What stops at the row's own booking is
  the `cause` and the `reason` — the claim about WHY, and about whom.

  **THREE PARTS, BECAUSE THE OBVIOUS ONE ALONE LOSES THE STORY.** Confining
  attribution is not sufficient by itself, and shipping only that would have
  silently dropped the decision from the very bookings it describes.

  1. **The drain** gives `cause` and `reason` only to the booking the row names —
     **and, for an officer override, to that booking's #738 split half**, because
     a split pair is one booking and the officer acted on the pair. The sibling
     query excludes its own input, so a half can never equal `sourceBookingId`;
     and §7's mandatory reason is stored nowhere but the incident, so where the
     uncovered half is the split child and its parent has no violation of its
     own, confining attribution to the id alone would leave that reason nowhere
     at all.

     **THE EXPANSION IS FOR AN OVERRIDE AND NOT FOR A DECLINE**, and that is not
     an oversight. A decline is an answer about an EXACT set of bookings, each of
     which gets a row of its own under part 2 — so a half that was not in that set
     would inherit a decision nobody was asked for, which is this invariant's own
     defect wearing a different hat. An override names no set: the officer
     confirmed a change to one booking, and its two halves are that booking. The
     extra read is therefore taken only for an override, and the ordinary sweep
     pays nothing (`adult-member-hosting-coverage-drain.ts`).
  2. **The enqueue** writes a row per **acknowledged** dependent — the member's
     declined set, or the exact set an officer was shown and confirmed under §7,
     both fingerprinted by the same stranded state key — even where the changed
     booking's own night window already reaches it.
     A dependent that PARTIALLY overlaps the new dates — the adult's booking
     still covers one of the kid's nights and leaves the other short — is an
     ordinary family shape, and it is reached only by the sweep. Without a row of
     its own it would lose the decision entirely.

     **AN OFFICER'S OVERRIDE IS AN ACKNOWLEDGEMENT TOO**, and the same rule
     carries it: the officer is shown the exact bookings their change would
     strand and confirms that set with a mandatory reason, so the incident opened
     on each of them is the record of who authorised it — and there is no other
     durable home for that reason. A dependent reached only by the changed
     booking's sweep, and so filed as a plain automatic change, would lose it.
     The end-to-end contract from #2576/#2597 asserts exactly this, and caught it
     when #3241's first attempt confined attribution without carrying it.

     **STRANDED, NOT EVERY DEPENDENT, AND THE DIFFERENCE IS THE WHOLE POINT.**
     `inspectSameOwnerDependents` drops from `stranded` any dependent whose
     uncovered state is already recorded — a stored review or an open incident at
     the same state key — and those are precisely the bookings uncovered for
     reasons of their own. They stay in the dependent set. Giving each of them a
     row of its own would hand them the story under their own name, where the
     drain's filter cannot help. A change that explains nothing about who — a
     plain `SYSTEM_CHANGE` with no reason — has nothing to carry, so it keeps the
     existing overlap rule and the ordinary edit still writes exactly one row.
     The changed booking's own row does not carry the decision either: "asked whether to move this booking as well" is
     self-contradictory on the booking they were editing.
  3. **A sweep yields the OPENING to the row that owns the story.** Before a
     story-carrying row opens an incident for a booking that is not its own, it
     asks whether that booking already has an unprocessed row of its own carrying
     a story, and if so leaves it alone entirely — that row will reconcile it
     moments later, with the explanation.

     This is about the AUDIT HISTORY, not the stored cause. Without it the sweep
     can open the incident unexplained and the explained row can then only
     promote it, which puts §7's mandatory reason on an *update* rather than on
     the opening — and an officer filtering the audit log for "incident opened",
     which is what the admin screen offers, would never see why. Ordering cannot
     fix it: both rows are written in one transaction, PostgreSQL gives every row
     in a transaction the same `now()`, and the claim orders by `enqueuedAt`.

     It yields only to a row that can still run. A row at or past `maxAttempts`
     is retired, so deferring to it would hold the incident closed for good — an
     unnoticed hazard is worse than an unexplained opening. `resolveRowRemit` in
     `adult-member-hosting-coverage-remit.ts` is the one home for both halves of
     a row's remit, split out of the drain when that file reached its size budget
     with a second job in it.
  4. **The fold promotes by rank**: `OFFICER_OVERRIDE` outranks
     `OWNER_DECLINED_LINKED_MOVE`, which outranks `SYSTEM_CHANGE`. For an
     identical uncovered state a more explained cause overwrites a less explained
     one, and never the reverse. That is what makes drain order stop mattering: a
     stranded booking can be opened by a sweep that knows nothing and reached
     afterwards by its own row carrying the member's decision. The guarded
     `updateMany` re-asserts the ranks under concurrency **as `notIn` the causes
     this write does not outrank** — an allow-list would exclude a label the
     running build has never heard of, which is exactly what an older colour
     meets mid-deploy under `INV-HOST-052`'s own two-release order, and the
     promotion would then match nothing, spin the retry loop and throw. A
     concurrent writer holding something stronger still wins rather than being
     erased. A promotion writes the story and NOTHING ELSE: the full update
     payload also clears the owner-notification claim, which is right when the
     state moved and wrong here — clearing a claim held by a delivery in flight
     loses its completion stamp and emails the owner twice about one unchanged
     condition (§16). The rank is a map checked with `satisfies`, so a fourth
     cause nobody ranks is a compile error rather than a silent 0.

  **WHAT THIS DOES NOT CHANGE.** A materially different uncovered state is still
  a new state: when the state key moves, the incoming cause is written whatever
  its rank, because the situation being described is no longer the same one. The
  pre-existing preservation of an officer's stored `overrideReason` across such a
  move is untouched.

  Enforced by
  `src/lib/__tests__/adult-member-hosting-coverage-drain-claims.test.ts` (the
  story reaches the row's own booking and no other, in both the declined and the
  officer-override directions, and a split half keeps the officer's reason),
  `src/lib/__tests__/adult-member-hosting-coverage-incidents.test.ts` (the
  decision is recorded whichever drain arrives first, an override promotes a
  decision and is never demoted by one, and a notification claim in flight
  survives a promotion) and
  `src/lib/__tests__/adult-member-hosting-same-owner.test.ts` (an overlapping
  stranded booking gets a row of its own, while a booking uncovered for its own
  reason and the booking being edited do not carry the decision), whose failure
  messages carry this id.
