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
(`CONCURRENCY_AND_LOCKING.md` → `../CONCURRENCY_AND_LOCKING.md`). Entries
compacted under #4990 are the exception: each keeps the rule, the code that
enforces it and a link, and the passages removed from it are archived as
comments on the deciding issue it cites. Do not restore that text;
[`WORD_BUDGETS.md`](WORD_BUDGETS.md) holds each entry to its length.

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
linked to a guest row on that exact night. Each consequence is deliberate:

- **Booking ownership never proves attendance.** The owner counts only through a
  participant row linked to them, and only on the nights that row covers. The
  evaluator is never given `Booking.memberId`, so it cannot be credited by
  accident.
- **The member LINK is authoritative, not the guest row's `isMember` flag**,
  which is a pricing-time snapshot. A row whose member cannot be resolved is
  treated as a non-member guest — the safe direction: it needs hosting rather
  than provides it.
- **Child, youth, infant and NOT_APPLICABLE (organisation) members cannot
  host.** They are still members in good standing, so their OWN nights never
  need covering: the minors rule (`requiresAdminReview`) owns children, and this
  rule is about non-member guest-nights only.
- **A lapsed membership is not a membership.** An inactive, cancelled or
  archived member cannot host AND their own nights need hosting: for this rule
  they are functionally a non-member (D-R3). The standing test is the single
  predicate both sides are built from, so a participant cannot fall between them
  and escape the rule. It is keyed off standing only, never `ageTier`, so an
  active organisation member is unchanged.
- **An unaccepted member-guest invite cannot host.** `consentStatus: PENDING` is
  not operationally present (D-12) — the kiosk, the arrival roster, bed
  allocation and the arrival emails all leave that row out — so counting it as a
  host would let a member suppress the review with an adult who never agreed to
  come. The review clears by itself the moment the invite is accepted.

Background: #2364.

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
`SAME_BOOKING` already has — qualifying adult member, exact guest-night,
membership standing, age, member-guest consent, exceptions, reason and evidence
structures — and adds only WHERE the host may be:

- **The relationship is the exact `Booking.memberId`.** An administrator
  entering bookings for different members never links them.
- **Only confirmed active attendance counts.** Drafts, holds, payment-pending,
  waitlist entries and offers, bookings awaiting review or an exception, bumped,
  cancelled, archived and expired bookings supply nothing, read through the
  canonical lifecycle helpers, never a second status list.
- **Exact lodge and exact NZ lodge-night.** Lodge A on Friday covers neither
  Lodge B on Friday nor Lodge A on Saturday; a stay may be partly covered.
- **Coverage is existential, not an assignment.** Nothing stores a permanent
  dependency on a person or booking: both `where` builders are re-derived from
  live rows at every evaluation, and evidence naming the source observed once
  never becomes an authorisation, so another eligible source keeps the dependent
  compliant with no incident or loss-of-coverage message.
- **Ownership is never attendance.** A booking owned by an adult member supplies
  nothing unless a qualifying adult member is recorded as attending that
  lodge-night; any qualifying adult member participant may cover, not only the
  account holder.
- **No capacity is consumed twice** (§15). The covering adult arrives as a
  `hostOnly` participant: their real attendance on their own booking is evidence
  for the dependent booking, and they are never duplicated as a guest on it. The
  source booking's own guests remain that booking's question.
- **Re-evaluation stays bounded** to the same `memberId`, lodge and nights; the
  lodge-wide sweep #2575 rejected is not built. A queue item names one owner,
  one lodge and an explicit night list, so no item can express a wider sweep,
  and a malformed night list yields no work rather than an unbounded read.

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

- **An authorised officer is ASKED TO CONFIRM, then ALLOWED and ESCALATED**
  (#2576 §7). An officer change that would strand a dependent raises
  `SameOwnerCoverageOverrideRequiredError` (409, `requiresOverrideReason: true`)
  naming what would be stranded; that blocks the UNCONFIRMED change, not the
  officer: §7's override needs the permission, an explicit confirmation, a
  mandatory reason, the affected bookings and nights, and an audit event.
  Re-submitted with `hostingCoverageOverride` (`{ acknowledged: true, reason,
  strandedStateKey }`, reason minimum 10 characters, unknown nested fields
  rejected), it proceeds as `OFFICER_OVERRIDE`, recorded against their member id
  with their reason on the incident. `strandedStateKey` digests (versioned) the
  changed source booking and the sorted dependent-booking/exact-night set shown.
  The retry re-derives it from authoritative rows under the per-owner lock: a
  changed non-empty set rolls the whole mutation back with a fresh prompt; an
  emptied set proceeds with no override audit. With nothing stranded, nothing is
  asked.

  The affected booking keeps its status, beds and payments, gaining an urgent
  compliance incident; nothing in the coverage machinery writes `Booking.status`
  (no automatic cancellation). Only surfaces using `hostingCoverageActorOptions`
  with a live officer session can raise the 409; every cron, webhook and
  lifecycle path passes `ESCALATE`.

  Approving a pending modification-policy exception takes the same two steps:
  the first attempt stays pending, returning the affected bookings and nights;
  the retry carries its own private override reason, never the member-facing
  approval explanation. The booking detail's officer edit and cancel controls
  use the same strict client-only prompt, bound to the whole rejected mutation
  (including shift pricing mode, refund method and email choice) and retired
  permanently if any proposal field changes. A retry reuses that proposal, not
  re-asking about email; a refreshed 409 replaces the key/list, clearing only
  the private reason and confirmation. Affected booking details render only when
  `viewerAuthorizationRole === "ADMIN"`; member self-removal and ordinary draft
  confirmation never gain this override UI.

### INV-HOST-029

- **A change to one PERSON's standing records the check it owes** (#2576 §8).
  The evaluator half is automatic (an archived or cancelled member stops
  qualifying); `enqueueHostingCoverageReevaluationForMember` is the other,
  called in the same transaction as archive, account-deletion anonymisation
  (before deactivation and guest unlink remove the attendance evidence),
  membership cancellation, single or bulk active/age-tier changes, consent
  approval, subscription settlement/reversal and member merge repoints. It fans
  out over live current-or-future bookings the person ATTENDS, not owns (§2),
  one bounded item per booking naming that booking's owner, lodge and nights
  (never #2575's lodge-wide sweep). It is gated on `ENFORCED`, not the scope: a
  lapse removes `SAME_BOOKING` cover too, and the drain's shared evaluator
  honours the lodge's scopes. Member-guest consent loss reaches it through the
  shared removal path, which reconciles inside the caller's transaction.

  **Participant fence (#2597).** Each high-level enqueue first proves its exact
  source owners and non-null actor under one sorted, de-duplicated `Member FOR
  KEY SHARE NOWAIT` statement; a missing member, contended row, changed source
  owner/lodge or attribution outside the proof rejects the whole outer mutation
  with the fixed safe 409, and a later call in one bulk transaction fails fast,
  rolling back earlier work. Before any attendance read or empty return, the
  standing fan-out locks its subject `FOR UPDATE NOWAIT` (never `FOR NO KEY
  UPDATE`), fencing the lodge-only booking-request hold's linked-member `KEY
  SHARE`. The hold takes its lodge key, re-reads the transaction-current request
  links, locks their sorted member ids and re-reads each as existing, active and
  unarchived before its versioned claim or any guest creation: hold-first makes
  the standing mutation retry with the committed guest; standing-first makes the
  hold wait, then refuse the inactive or archived row before creation in every
  mode, `DISABLED` and review-required included. Account deletion inherits this
  fence after its global → affected-lodge → member-lifecycle prefix, with no
  route-only duplicate.

  **Deletion and Xero contacts (#2597, #2623).** Under its target `Member FOR
  UPDATE`, deletion re-checks the Xero contact-create reservation/recovery
  blocker and every RUNNING member CONTACT UPDATE before anonymising. A member
  UPDATE commits a short `FOR KEY SHARE` reservation, calls Xero outside
  transactions, then completes operation and canonical link together under that
  `FOR UPDATE`, retrying only from the current Member, never stored pre-deletion
  PII. The create reservation, manual Link and provider-returned local-link
  paths re-read the deleted-member marker under their own Member lock before any
  provider call or attribution, so a deleted account neither sends its
  pre-deletion profile to Xero nor regains a link. Manual Link commits the
  Member pointer and FK-less canonical CONTACT ledger row together; deletion
  deactivates that ledger in the anonymisation transaction that clears the
  pointer. A canonical link commit also moves to `SUCCEEDED` a `FAILED` member
  CONTACT create proving Xero made the now-linked contact, in the same
  transaction and status-guarded, touching nothing else: no `RUNNING`
  reservation, no create that made a *different* contact. Merge, deletion and
  member detail read the blocker (whose predicates never consult
  `Member.xeroContactId`) through one predicate, so a refused member never
  renders reconciled; each refusal names the blocking operation and the Admin →
  Xero → Operations screen. Only an explicit `repairExistingLink` may reserve a
  CREATE for a linked member, re-resolving by exact non-archived name first so a
  live same-named contact is re-linked, not duplicated.

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

- **One active incident per booking; owner notification is fenced, at-least-once
  delivery** (§16). The partial unique index
  `HostingCoverageIncident_active_booking_unique` enforces the first against a
  concurrent second opener, which folds into the winner rather than surfacing a
  constraint violation. The stored `stateKey` is a fixed-width digest of the
  material-identity key, so a large party cannot outrun the column and make two
  problems compare equal.

  The notification takes a short delivery lease with an opaque claimant token
  before the send; `notifiedStateKey` is stamped only after transport reports
  success. Immediately before provider input is read, a guarded update renews
  the lease only while the incident is unresolved, unnotified and that exact
  state/token is current, so an expired-but-unreclaimed claimant may continue
  and races any successor on the row, one winning. A final exact read freezes
  recipient data and the incident's own evidence at the renewed timestamp; a
  stale or reclaimed worker calls no provider and never substitutes a later live
  booking review into an older claim. Completion and release match the same
  token.
  Missing email, placeholder/bounce suppression and a per-booking `noEmails`
  switch are terminal while the incident stays visible to officers; an
  unreadable `noEmails` flag is transient — the lease is released and the exact
  queue claim fails, because `hosting-coverage-lost` has no independent EmailLog
  retry authority. The provider stays outside transactions. A provider
  acceptance followed by a crash before the stamp may be resent: this is
  at-least-once delivery with one durable success stamp, not exactly-once. A
  crashed sender's lease expires after 15 minutes.

  The re-evaluation queue uses the same 15-minute token fencing for completion
  and failure, claims serial work one row at a time, and excludes ids that drain
  already attempted, so a slow later item is not pre-leased and a released
  failure cannot burn several attempts in one pass. Background: #2576.

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
  refused for it** (#3209, §8). A booking leaving CONFIRMED or PAID stops
  supplying cover, so a writer flipping one to a terminal status owes a
  confirming writer's re-read. The group organiser cancel, Internet Banking hold
  expiry, Stripe capacity-failed void and cross-lodge price-drift unwind
  reconcile inside their own cancelling transaction, then drain scoped to the
  cancelled booking (per child on a group cancel).

  They reconcile through `reconcileHostingReviewForSystemCancellation`: these
  transitions have no actor to ask, and §8's unblockable changes include every
  automated path (`HostingDependentCoverageDisposition`). `INV-HOST-028` does
  not cover this. The seam **removes the refusal rather than catching it**:
  `enforcement: "REVIEW_ONLY"` travels into the sibling loop, so a #738 split
  sibling the cancellation leaves uncovered RECORDS its hazard in the same
  transaction instead of raising `AdultMemberHostingRequiredError` and rolling
  the cancellation back. Dependents keep the default `ESCALATE`. Besides §13's
  school carve-out, `REVIEW_ONLY` is used only here and in the post-commit
  incident drain; `INV-HOST-020`'s census names all three and makes a fourth
  state which it is. Nothing is caught: participant retries and database
  failures reach existing re-drive boundaries.

  `adult-member-hosting-call-sites.test.ts` holds both halves, finding terminal
  flips **by the write itself** (a `booking.update`/`updateMany` `data:`
  assigning CANCELLED, EXPIRED or BUMPED) and requiring a seam in the
  **enclosing function**; a file spreading `RELEASE_WHOLE_LODGE_HOLD_UPDATE`
  with no detected flip must say why; exemptions are keyed `file::function`,
  naming the status flipped FROM. It cannot prove same-branch placement; a
  reviewer does.

  **A refusal is deterministic, so even the group re-drive would wedge on it**:
  `resumeInterruptedOrganiserCancels` (#1236) re-runs the idempotent cleanup for
  `ORGANISER_PAYS` groups with a CANCELLED organiser booking past a short grace
  and `organiserSettled` children still active, regardless of
  `GroupBooking.status`, using `ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES`,
  declared once in `booking-status.ts` and shared with the cancel loop
  (`INV-SSOT`).

### INV-HOST-042

- **Whether supervision work is owed is decided by the RELATED bookings' lodges
  too, not only the changed one's** (#3209). A lodge row overrides the club-wide
  row, and the #738 split-sibling relation (`hostingSiblingWhere`: direct parent
  or child, same member) has no lodge clause, so a change at a lodge with the
  rule off can strand a sibling at a lodge that enforces it. The gate is in
  `reconcileAdultMemberHostingReviewWithSiblings`, the entry point every such
  writer shares, and in no writer; it skips only when this booking's lodge is
  inactive **and** no related booking sits at an active one.

  **The same-owner half needs no widening:** `sameOwnerCoverageDependentWhere`
  pins `lodgeId` to the changed booking's lodge and
  `settleSameOwnerDependentCoverage` re-reads that lodge's mode, so skipping
  under an inactive lodge misses nothing ("keeps the dependent cohort at the
  changed booking's own lodge", `adult-member-hosting-same-owner.test.ts`).

  **`INV-LOCK-002` and #2623 T5 both hold.** A club that owes nothing never pays
  the `Member FOR KEY SHARE NOWAIT` participant proof (T5), so the widened
  question takes no lock: one indexed read of this booking's parent and children
  over `Booking(parentBookingId)`, and a policy read only for lodges other than
  this booking's own. When work is owed the fenced body runs whole, acquiring
  the Member rows before any coverage-owner advisory key (including the one the
  sibling's evaluation takes under its lodge policy); a skip acquires nothing.
  Pinned behaviourally in `adult-member-hosting-same-owner.test.ts` → "the mode
  gate reads the RELATED bookings' lodges too", and the skip's
  `failFastCoverageOwner` flag structurally in
  `adult-member-hosting-call-sites.test.ts` → "keeps the un-fenced return
  fail-fast on the coverage-owner key". History and reachability: #3209.

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
  `GroupBookingJoin.bookingId`, resolved in one module
  (`group-trip-identity.ts`), and the container's own status governs joining
  rather than cover.** `Booking.parentBookingId`, the #738 split relation, is
  forbidden as an identity source.

  **One carve-out: the second half of a #738 split pair inherits the first
  half's Group Trip** (owner decision, 31 August 2026). **The fence:** a booking
  inherits only from its `SAME_BOOKING` split sibling —
  `booking.parentBookingId`, owned by the same member, not cancelled, bumped or
  soft-deleted — and ONE WAY, so a parent never inherits from a child, a #796
  group joiner inherits nothing, and a `parentBookingId` relation in any other
  configuration supplies and receives nothing. Inheriting governs only what a
  booking RECEIVES: an inheriting child is no Group Trip source. The
  relation-based dependent set finds the split parent, not the inheriting child,
  so a Group Trip fan-out must reconcile each dependent through
  `reconcileAdultMemberHostingReviewWithSiblings`, never directly.
  `inheritedSplitPairGroupTrip` is the one implementation, taking only
  `Pick<LoadedHostingBooking, "parentBookingId">` so it cannot follow children;
  decoy-sibling fixtures pin the choice among siblings.

  **Every evaluator applies the carve-out:** `evaluateProposalPartyViolations`
  uses the shared `readInheritedSplitPairGroupTrip`.

  **Roster row first:** `createConfirmedBooking` claims the `GroupBookingJoin`
  row before creating and reconciling the split child, and
  `verifyAndCreateNonMemberJoin` claims its row before reconciling. Both join
  paths must answer the hosting rule before the `Booking` row exists, so
  `groupTripIdentityForJoin` takes identity from the redeemed container, whose
  id the member join hands its preflight.

  **`GroupBooking.status`** decides whether new bookings may join; a `CANCELLED`
  container does not cancel the joiners' own bookings, so source and dependent
  sets are never filtered on it; whether a booking is live is `Booking.status`'s
  question. The `PAID_UP_ADULT_MEMBER_REQUIRED` lockout stays per-booking.

  Enforced by `adult-member-hosting-call-sites.test.ts` (exception-path call,
  single definition, roster-first order), `group-trip-identity.test.ts` and
  `adult-member-hosting-group-trip-cover.test.ts` (carve-out, join orderings).
  History: #3037, #3038.

### INV-HOST-044

- **A Group Trip host is HOST-ONLY, counted ONCE, and read under a bound of its
  own.** Where a club has enabled `SAME_GROUP_TRIP`, qualifying adult members
  attending another live booking in the same Group Trip enter the evaluation as
  `hostScope: "SAME_GROUP_TRIP"`, `hostOnly: true` participants built by the
  canonical `toHostingParticipants`.

  **Host-only:** no bed, participant, price, payment or responsibility moves.
  The adult is never duplicated as a guest here; their own booking's uncovered
  guest-nights stay that booking's hazard, and two separately owned bookings
  keep two lifecycles.

  **Counted once:** `loadSameGroupTripHosts` excludes in its query the
  split-sibling (`SAME_BOOKING`) and same-owner (`SAME_BOOKING_OWNER`) source
  ids actually read, so the snapshot's `coveredByScopes`, which the kiosk reads,
  never credits a scope that supplied nothing new. With the same-owner scope OFF
  the same booking is legitimately a Group Trip source instead: the union of
  cover is the same either way, and only the credited scope differs.

  **Bounded by `SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT`, not the same-owner
  number**, argued from shape (each booking needs a bed, so lodge capacity
  bounds the population), never from a club's lodge size (`INV-CONFIG-001`). A
  writer truncates, erring towards the rule; an evidence caller passes its own
  ceiling and is refused with `HostingGroupTripSourceCeilingExceededError`,
  never handed a short host list. The diagnostic pack imports the writer's
  constant.

  **Both cross-booking source reads are one read, ordered unconditionally:**
  `loadSameBookingOwnerHosts` and `loadSameGroupTripHosts` are
  `loadCoverageSourceHosts` with one relationship clause changed
  (`INV-SSOT-001`). `COVERAGE_READ_ORDER` binds writers too, because an
  unordered `take` moves `adultMemberHostingStateKey` between evaluations of an
  unchanged booking and re-notifies an officer.

  **Member-owned and non-member-owned joins consume this cover on identical
  terms.** Nothing about who owns a source or a dependent booking is consulted.
  Enforced by `adult-member-hosting-group-trip-cover.test.ts`, whose failure
  messages carry this id. History: #3038.

### INV-HOST-045

- **The kiosk's adult-cover display is DERIVED from the canonical evaluation,
  and a stale, failed or unrecorded evaluation never renders as cover** (#3040,
  epic #2943). On a Group Trip card, the privileged kiosk tier may show where a
  booking's adult supervision comes from, read by `deriveKioskAdultCoverSource`
  (`kiosk-adult-cover.ts`) from the frozen violation snapshot
  (`Booking.adultMemberHostingReview`, parsed by `parseStoredHostingReview`);
  nothing is recomputed for display.

  **A snapshot records a violation and nothing else**: with nothing uncovered
  the evaluator returns `null` and the reconciler writes `Prisma.DbNull`, so
  "fully covered" is the ABSENCE of a snapshot and the display has no "all
  covered" wording (pinned against the real evaluator).

  **Four statuses; only `EVALUATED` carries night rows** (a discriminated union;
  the others carry empty `nights` and `scopes` tuples). `NOT_RECORDED`, no
  snapshot and no signal against it, is the ordinary state: muted text, *"Adult
  cover: no issue recorded for this booking"*, neither a warning nor a positive
  claim. `UNREADABLE` (not canonical, or self-contradictory) and `STALE` render
  amber. `EVALUATED` means at least one night, at least one uncovered.

  **Staleness signals, in this order:** (1) a queued
  `HostingCoverageReevaluation` for the owner at this lodge, read first since it
  invalidates an absent snapshot as much as a present one, night list not
  intersected; (2) an open `HostingCoverageIncident` with NO snapshot (with one,
  the snapshot stands), never in any payload; (3) a readable snapshot with
  nothing uncovered; (4) a covered night resting on `SAME_GROUP_TRIP`, which
  makes the whole snapshot `STALE`, never a night uncovered: before that refusal
  is removed, #3039 must enqueue a row for every DEPENDENT owner or extend
  `readStalenessSignals` to the whole group's owners. The policy revision is NOT
  a signal: `incidentPolicyChanged` compares mode and enabled scopes, and a
  material change reaches signal 1.

  **A partially readable snapshot is `UNREADABLE`**: no malformed night row is
  skipped; the per-night evidence and the `uncovered` list must name the same
  uncovered nights; duplicate nights, a covered night with no supplying scope
  and a scope list naming nothing this deployment has are rejected, each guard
  mutation-verified.

  **No requirement in force means no cover line.** Where the resolved MODE
  (never the scope set) is not a consequence — `DISABLED`, no row, or a
  malformed set — the kiosk omits `adultCoverSource`, as for a viewer without
  the capability, and issues no staleness read or anything else on that path.
  That mode is the one club setting the kiosk Group Trip surface consults, and
  gates the cover line alone; the linkage badge is gated on nothing (D1 on
  #3040, `INV-PRIV-016`).

  **`EVALUATED` shows the officer's decision** (`PENDING`, `APPROVED`,
  `REJECTED` or `null`), as an approval moves only
  `adultMemberHostingReviewStatus`. **Cover is per night**: the scope union is
  only a heading; `coveredByScopes` ABSENT on a covered night reads as
  `SAME_BOOKING` (`QualifyingHostsForNight`), EMPTY is `UNREADABLE`. The kiosk
  drops the member ids in `qualifyingHostsByNight` (`INV-PRIV-016`).

  Enforced by `kiosk-group-trip-privacy.test.ts`, `group-trip-tiers.test.ts` and
  `kiosk-group-trip-card.test.tsx`. History: #3040.

### INV-HOST-046

- **When a change strands another account's Group Trip booking, the change
  proceeds, the sibling is escalated to officers, and the actor is told nothing
  about the other account** (owner contract, #2943; #3039), through the existing
  incident and officer queue.

  **No new refusal, error body, member-facing sentence or override prompt
  exists** (test-asserted). `settleGroupTripDependentCoverage` cannot throw: it
  records durable work and returns. `lockAndVerifyGroupTripCoverageDependents`
  may throw the stable, non-disclosing `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409
  when its fail-fast trip key loses a race or the sibling set drifts, rolling
  the actor back, so the no-block promise holds of the OUTCOME, not of every
  attempt. Only `invoice-paid-effects.ts` passes
  `GroupTripFanOutOptions.bestEffort` (degrade, not refuse), legal only where a
  transition cannot remove cover (`PAYMENT_PENDING -> PAID`); the settlement
  reaper's de-confirming revert never may.

  **Dependents are the trip at this lodge, with no night clause**: seams run
  after the write, so `groupTripCoverageDependentWhere` composes
  `coverageDependentEnvelopeAcrossNightsWhere` (same lodge, active, not this
  booking or soft-deleted); sources keep their night clause. Each dependent gets
  one `HostingCoverageReevaluation` item: itself as `sourceBookingId`, its owner
  as `memberId`, the lodge, its OWN nights, cause `SYSTEM_CHANGE` even after an
  officer override. `assertHostingCoverageQueueParticipantsLocked` refuses an
  item unless one proof source's `bookingId` and `ownerMemberId` are its
  `sourceBookingId` and `memberId`. The drain always adds each dependent's split
  halves (`hostingSiblingWhere`, `INV-HOST-043`).

  **`GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT`** (own constant, source ceiling's
  number) caps the items. When it binds, the fan-out (not the dependent read)
  writes beside the log line, in that transaction and once per trip, a
  `reportGroupTripDependentCeilingBound` audit row
  (`booking.hostingCoverage.groupTripFanoutTruncated`, keyed on the
  `GroupBooking`, `severity: "important"`) saying the rest were not re-evaluated
  and may lack their required adult.

  **The fan-out lives in the three seams**, so every writer reaching the hosting
  rule participates (`INV-SSOT-001`):
  `reconcileAdultMemberHostingReviewWithSiblings` (reconcile, can refuse),
  `enqueueOwnHostingCoverageReevaluation` (confirming paths that must not be
  refused) and `enqueueHostingCoverageReevaluationForMember` (membership
  lifecycle: a change in host standing, `participantQualifiesAsHost`, removes
  cover from every booking relying on that person). The last plans each trip
  once before its participant fence, takes trip keys before owner keys and
  records through `settleGroupTripDependentCoverage`. A fourth seam joins the
  census first.

  **Closing, reopening and deleting need no hook.** `GroupBooking.status`
  governs joining, not cover (`INV-HOST-043`). `booking-delete.ts` hard-deletes
  only `DRAFT` and soft-deletes only `CANCELLED`, neither a cover source; the
  `GroupBookingJoin`/`GroupBooking` cascades fire only on a hard delete, and
  `OPENABLE_ORGANISER_STATUSES` keeps an organiser's booking out of `DRAFT` when
  its group is created, so no cascade destroys a live trip's identity.

  Enforced by `adult-member-hosting-group-trip-reconciliation.test.ts`,
  `adult-member-hosting-group-trip-races.realdb.test.ts` and
  `adult-member-hosting-call-sites.test.ts`. History: #3039.

### INV-HOST-049

- **The same-owner dependent fan-out reads over the window the changed booking
  VACATED as well as the one it holds, and each queue item carries the
  DEPENDENT's own nights** (#3232). Fixing either half alone still loses the
  booking, so each is mutation-verified separately.

  **The read.** Dependent reads run after the write, so one overlap test against
  the NEW dates misses a booking that relied on the old ones and leaves it
  recorded as compliant while uncovered. The set is the UNION of the vacated and
  current windows — `coverageDependentEnvelopeOverStayUnionWhere`, composed with
  §1's `memberId` relationship by `sameOwnerCoverageDependentOverStayUnionWhere`
  — never the group direction's dropped night clause
  (`coverageDependentEnvelopeAcrossNightsWhere`), because here an extra row can
  refuse a member's move; the union is exact. `hostingCoverageActorOptions`
  requires `vacatedRange`: `modifyBookingDates`, `adminShiftBookingDates` and
  `modifyBookingBatch` supply it; the rest pass `null`, one overlap test.

  **The items.** The drain turns an item's nights back into bookings
  (`loadSameOwnerCoverageDependentIds`), so the settle step records one item per
  dependent the changed booking's own window cannot reach, naming that
  dependent's OWN nights (`enqueueSameOwnerDependentItems`, gated by
  `dependentNeedsOwnQueueItem`). In the ordinary edit every dependent overlaps
  and exactly one item is written; more appear only after a move, capped with
  the dependent set at `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT`.

  **The fence.** The dependent set is planned before the participant fence and
  re-verified under the per-owner coverage key, the Group Trip fan-out's plan,
  lock, re-verify and retry protocol, with no new lock or ordering: same-owner
  dependents share the `memberId`, so only the proof's source list grows.

  Enforced by `adult-member-hosting-same-owner.test.ts` and
  `adult-member-hosting-linked-move.test.ts`, whose failure messages carry this
  id. History and worked example: #3232.

### INV-HOST-050

- **A member is never refused a change they have no way to make; where moving
  one of their bookings would strand another of their own, they are OFFERED the
  linked move** (owner decision, 2 September 2026, #3232). A refusal names only
  actions the member can take, never "update the affected booking first".

  **Three arms.** *Yes*: both move atomically on one combined figure accepted
  once (`INV-HOST-051`). *No*: only the changed booking moves; the member is
  told plainly the other will lack adult supervision, and an officer-queue
  incident records that they were asked and answered. *Cannot*: no beds for both
  is said plainly and warn-and-continue offered, naming the WHOLE stranded set,
  priced at nothing, the primary's figures as the combined ones.

  **The offer replaces the refusal only when** the dependent no longer shares a
  night with the changed booking (otherwise `SameOwnerCoverageWouldBreakError`,
  unflagged) **and** shifting it by the ARRIVAL delta overlaps a night the
  changed booking keeps (`linkedMoveWouldRestoreCover`). That test only raises
  the offer; the supervision pass over the would-commit state remains the
  authority (a mixed set reaches the offer and is decided there), skipped on an
  arm that cannot commit and governing every arm that can. The engine marks the
  refusal `linkedMoveWouldAnswer`; `modifyBookingWithLinkedMoveSupport` prices
  it by running both moves through the modification service and rolling back
  (`INV-SSOT-001`); an unenriched refusal names an officer.

  **State keys:** declining binds the stranded set alone
  (`strandedCoverageStateKey`, the officer override's); accepting binds
  `linkedMoveStateKey` (stranded set, proposed windows, combined money including
  the price delta). A stale key gets a fresh prompt: a stale answer is a fresh
  first submission, judged by the same delivery test at both throw sites, and
  cannot claim an arm the shift cannot deliver.

  **Money and wording.** The quote holds a due field and a refund field, never
  one signed number: they do not net off, as each booking refunds or charges on
  its own (per booking exactly one is non-zero; across bookings both can be).
  Every surface composes the sentence from
  `hosting-coverage-linked-move-client.ts` (`INV-SSOT-001`), states both figures
  when both are non-zero, says they settle separately, and is count-driven: the
  dependent cap is `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT`, the arm relied on for
  informed consent names every booking it will leave uncovered, and the
  both-directions sentence says which way the money goes, counting no bookings.
  Every claim holds for both directions: no fee "included" in a total, no named
  zero combined fee, no "one change fee only" when the primary's fee is also
  nothing, no "will be asked once" when already answered. The offer names
  `policyRetainedAmountCents` summed across moving bookings.

  **Save stays disabled until an arm is chosen** (errors in an announced live
  region); no reason is demanded. **Only the booking's own member answers**: the
  seam honours only the owner's decline, `runLinkedDateMove` refuses a non-owner
  before writing, and the answer is no ADMIN-gated field; an officer still owes
  §7.

  **Every date-capable member surface offers all three arms**, both `PUT` doors
  (`[id]/modify`, `[id]/modify-dates`) through one function, differing only in
  the single-booking writer handed in (`INV-SSOT-001`); `adminShiftBookingDates`
  is outside the arms (census-checked): it escalates via `REQUIRE_OVERRIDE`,
  never refused for stranding.

  Enforced by `adult-member-hosting-linked-move.test.ts`,
  `adult-member-hosting-same-owner.test.ts`,
  `booking-linked-date-move-service.test.ts`,
  `adult-member-hosting-call-sites.test.ts` and `modify-linked-move.test.ts`.
  History: #3232.

### INV-HOST-051

- **The linked move is atomic and settles once, and whether it charges both
  change fees is a club setting that defaults to charging** (#3232 D2,
  `INV-CONFIG-001`).

  **Atomic:** one transaction; any failure rolls back both bookings. Each
  booking's Stripe, email and Xero work is a `deferredPostCommit` thunk,
  contained per booking: one failing never skips the other's or reports the
  committed move failed.

  **One combined figure, accepted once:** both bookings' repricing and change
  fees, summed in integer cents from per-booking fields, shown before acceptance
  with one refund-or-credit choice; due and money back
  (`editTotalMoneyBackCents`, freed credit included) never net off. The need for
  a card-or-credit choice is the modification result's own
  `requiresSettlementMethod`, never re-derived from amounts (`INV-SSOT-001`); a
  method already chosen attaches by its ARM, not that flag.

  **The setting** is `BookingDefaults.linkedMoveChargesBothChangeFees`; the
  member is told the club's answer. A waiver reaches pricing as
  `waiveChangeFee`, a modification-service argument (never a request-body field;
  its one permitted caller is censused) passed for the DRAGGED booking only, its
  zero reaching settlement, payment adjustment, modification row, audit and
  Xero. `changeFeeWaived` and its one-home reason are recorded only where a
  chargeable fee was suppressed.

  **One supervision check, over the committing state:** `modifyBookingBatch`
  accepts `hostingReconcile: "CALLER"` only from
  `booking-linked-date-move-service.ts`, returning `pendingHostingReconcile`,
  run for every written booking before commit.

  **`NO_CAPACITY` is chosen by error class** (the member path's
  `InsufficientCapacityError`), never by message.

  **Locks:** one lodge key covers both (the dependent envelope pins `lodgeId`
  and no writer moves a booking between lodges), global → lodge → `Member` rows
  → per-owner coverage key, adding no key; its two roster-date sets rely on the
  [global
  key](../CONCURRENCY_AND_LOCKING.md#composition-roster-date-writers-2586). It
  takes the same `{ maxWait: 10_000, timeout: 30_000 }` as `assignBedRange`;
  P2028/P2034 answers "nothing was changed, try again in a moment".

  Enforced by `adult-member-hosting-linked-move.test.ts`,
  `booking-linked-date-move-service.test.ts` and
  `adult-member-hosting-call-sites.test.ts`. History: #3232.

### INV-HOST-052

- **A booking left uncovered because its owner declined the linked move has its
  own recorded cause, written by exactly one arm, and that cause was registered
  one release before anything wrote it** (#3232 D3, #3241,
  `docs/BLUE_GREEN_MIGRATION_POLICY.md`).

  **Its own cause.** `SYSTEM_CHANGE` means an automatic change nobody could
  reasonably block; filing a member's deliberate decision under it misinforms
  officers and corrupts the by-cause count.

  **Two releases; the order is the rule**, owed by the next value added to this
  enum. Migrations run while the previous colour serves, and its Prisma client
  cannot deserialize an unknown label, even in the fold read every drain
  performs (`adult-member-hosting-coverage-incidents.ts`). Expand (#3232):
  `20260909010000_add_owner_declined_linked_move_incident_cause` registered the
  value; nothing wrote it. Runtime (#3241): the owner-declined branch of
  `hostingCoverageActorOptions` writes it. Both have landed.

  **Wording.** Each cause's officer-facing phrase has one home,
  `describeHostingCoverageIncidentCause`, used by the bookings queue and the
  stuck-state dashboard (`INV-SSOT-001`); `SYSTEM_CHANGE` reads "no longer
  covered after a later change". The member's decision is recorded in words in
  the incident's audit history, **never** on
  `overriddenByMemberId`/`overrideReason`: nobody exercised §7 authority.

  **One writer:** an exact-list census holds that the declined arm alone
  produces the value, and only the module declaring the union and owning the
  phrase names it outside tests; widening either list changes this invariant.

  Enforced by `hosting-coverage-incident-cause-expand.test.ts` (appended enum,
  additive DML-free migration, the ledger row's deploy order, the phrase on both
  surfaces, the census) and `adult-member-hosting-same-owner.test.ts` (the
  declined arm's queue item and stored cause and reason). History: #3241.

### INV-HOST-053

- **A re-evaluation row's explanation belongs to the booking that row is about,
  and an explained cause is never overwritten by an unexplained one** (#3241).
  `actorMemberId` reaches every booking the drain's §14 sweep matches by the
  row's owner, lodge and nights; `cause` and `reason` do not.

  Cause labels, ranks, phrases and the declined-move sentence have one home,
  `adult-member-hosting-incident-causes.ts` (`INV-SSOT-001`); the incident
  writer re-exports the words.

  1. **The drain** gives `cause` and `reason` only to the named booking, plus,
     for an officer override alone, its #738 split half (no extra read
     otherwise).
  2. **The enqueue** writes a row per **acknowledged** dependent (the member's
     declined set or an officer's §7-confirmed set, both bound by the stranded
     state key) even where the changed booking's window reaches it.
     `inspectSameOwnerDependents` drops from `stranded` any dependent whose
     uncovered state is already recorded (a stored review or open incident at
     that state key), leaving it a dependent without the story. A plain
     `SYSTEM_CHANGE` with no reason keeps the overlap rule and one row; the
     edited booking's own row never carries the decline.
  3. **A sweep yields the OPENING**: a story-carrying row leaves entirely alone
     another booking with its own unprocessed story-carrying row below
     `maxAttempts`. `resolveRowRemit` alone decides a row's remit.
  4. **The fold promotes by rank**: `OFFICER_OVERRIDE` over
     `OWNER_DECLINED_LINKED_MOVE` over `SYSTEM_CHANGE`. For an identical state,
     higher overwrites lower, never the reverse; the guarded `updateMany`
     re-asserts this as `notIn` the causes not outranked, never an allow-list
     (`INV-HOST-052`); a stronger concurrent writer still wins. A promotion
     writes the story only, never clearing the owner-notification claim (§16);
     an unranked cause fails to compile (`satisfies`).

  **When the state key moves**, the incoming cause is written whatever its rank;
  preservation of a stored `overrideReason` is untouched.

  Enforced by `adult-member-hosting-coverage-drain-claims.test.ts`,
  `adult-member-hosting-coverage-incidents.test.ts` and
  `adult-member-hosting-same-owner.test.ts`. History: #3241.
