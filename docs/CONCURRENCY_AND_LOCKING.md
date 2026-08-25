# Concurrency and advisory locking

How the app serialises the operations that would otherwise race — overbooking a
lodge, double-restoring a member's credit, two people holding the same night,
two runners generating one roster, a settle racing a reap. The primary
cross-row mechanisms here are **PostgreSQL transaction-scoped advisory locks**
(`pg_advisory_xact_lock(...)`): they are held for the life of the enclosing
transaction and released automatically on commit or rollback. Narrow
`SELECT ... FOR UPDATE` protocols and one maintenance-only table-lock protocol
also exist and are inventoried below. All writers additionally follow the
status-guarded-claim rule described below.

This doc maps **which locks exist, what each one protects, how they interact,
and the ordering every writer must follow**. Read it before changing any lock
key, adding a capacity/credit/settlement write path, or converting a global lock
to a scoped one (or the reverse).

> Why advisory locks and not unique constraints? Several of these invariants are
> cross-row or cross-table (e.g. "a member can't hold two bookings covering the
> same night" spans `BookingGuest` → `Booking`), or need a **partial** unique
> index Prisma cannot express and `db:check-drift` would then reject. Where a
> DB constraint *can* carry the invariant it is preferred (and, since #1636, the
> credit-restore exactly-once guarantee IS a unique constraint — see below);
> where it can't, an advisory lock serialises the check-then-write instead.

## The two-tier protocol (#1881)

The multi-lodge migration split what used to be one club-wide lock into two
tiers. **Getting the tier — and the acquisition order — wrong re-opens the exact
money/capacity races the locks exist to prevent.**

**The rule itself has one home, and it is not this page.** `INV-LOCK-001` (which
tier a writer takes), `INV-LOCK-002` (global before per-lodge, and the single
mint of the per-lodge key) and `INV-LOCK-003` (every Tier-2 site is registered
with its own reason) state it, in
[`docs/invariants/operations.md`](invariants/operations.md); cite those ids in a
review, a guard message or an issue. What follows **expands** them against the
real writers — which cohort each sits in, and why — which is work the ids
deliberately do not do. Expanding is not restating: this section may say more
than an id, and it may say it about a named writer, but it may not say something
different. If this section and an `INV-LOCK-*` id ever disagree, the id is the
rule and this section is the defect.

### Tier 1 — per-lodge capacity claims

`acquireLodgeCapacityLock(tx, lodgeId)` (`lodge-capacity-lock.ts`, re-exported by
`capacity.ts`) serialises **bed/capacity claims for ONE lodge**. Bookings at different lodges never contend, so two
members booking different lodges proceed in parallel. Every path that reads
occupancy and then claims a bed (create, confirm-from-draft, settle-to-CONFIRMED,
date/guest modification, waitlist confirm, the Internet-Banking capacity gate)
takes this lock keyed on the booking's own lodge.

### Tier 2 — global booking-status / money serialisation

`pg_advisory_xact_lock(1)` (the literal global lock) serialises **status
transitions and money side effects that must be mutually exclusive across the
whole booking regardless of lodge**: cancel, capture/settle, hold-release, the
group-settlement reaper, refunds, and credit restoration. These are not
per-lodge concerns — a cancel and a capture of the *same booking* must exclude
each other whatever lodge it is at — so they share the single global key.
Bed-allocation writers also join this cohort when their rows must not cross a
cancellation/lifecycle prune: inventory writes, placement/move/range, explicit
auto-allocation, approval, and reviewed removal all take global before their
lodge tier even though they do not themselves move money. **Member merge is the
one documented exception** — it is a bed-allocation writer that takes the lodge
tier and deliberately not this key, because it runs on a 120s budget; see "Merge
joins the bed-allocation cohort" (#2595).

Each of these call sites is registered individually — its stable identity, its
tier, and the counterpart or race that makes the narrow tier insufficient — in
`GLOBAL_LOCK_SITE_REGISTRY` (`src/lib/__tests__/advisory-lock-guard.test.ts`).
That registry is where a site's reason is registered and enforced: a new Tier-2
site fails CI by name until one is written, and a registration that no longer
matches a live site fails as stale rather than approving nothing
(`INV-LOCK-003`). Where a section of this page walks one of those sites in more
detail — the deleted-booking refund tasks below are the longest example — it is
expanding that entry and must agree with it; if the two ever diverge, the entry
is what CI enforces and this page is the defect.

### A writer that does BOTH takes BOTH — global first

Many writers do both tiers at once: a Stripe capture claims capacity **and**
moves money; a date modification reprices/refunds **and** re-checks capacity; a
quote-accept flips booking status **and** holds a bed. Every such writer:

1. takes the **global `lock(1)` FIRST**, then
2. takes the **per-lodge lock**.

The global-before-per-lodge order is fixed everywhere so composing the two can
never deadlock. Writers that compose several *same-family* locks (multiple
per-lodge locks, or multiple per-member locks) acquire them in **sorted key
order** for the same reason. (`INV-LOCK-002`.)

### Status-guarded claims (defense in depth)

Every status-transition write in the cluster is a **status-guarded
`updateMany`**, not a bare `update` by id:

```ts
const claimed = await tx.booking.updateMany({
  where: { id, status: <expected status(es)> },
  data: { status: <new status>, ... },
});
if (claimed.count === 0) { /* lost the claim — bail, no side effects */ }
```

Under the correct lock this is belt-and-braces (the under-lock re-read already
established the status), but it makes the "no clobber" guarantee **structural**
rather than purely lock-dependent: a writer that somehow slipped the lock still
cannot flip a booking a concurrent writer already moved.

### Email retry authority uses a guarded row claim, not an advisory lock (#2362)

`cron-email-retry.ts` composes no booking, capacity, membership-lifecycle, or
money mutation. It reads the booking and recipient only to decide whether a
retained authenticated detail URL may still be disclosed to the current
direct/inherited mailbox, re-finalizes the local delivery copy, then keeps the
existing `EmailLog` `FAILED -> QUEUED` guarded `updateMany` claim before SMTP.
Both that claim and a fail-closed retirement match the selected row's status,
attempt count, legacy body, and rollback-isolated booking body, so only one
concurrent runner can move the snapshot; losing either guard sends nothing.
The additive `EmailLog` authority columns introduce no advisory-lock key or
transaction participant; provider delivery remains outside a database
transaction. New booking rows keep `htmlBody` null and retain retry HTML only in
`bookingRetryHtmlBody`, which the old worker cannot select after rollback.

## The lock families

All keys below are the argument(s) to `pg_advisory_xact_lock`. Two-argument keys
use `(namespace, subject)`; single-argument keys hash a descriptive string or
are the literal `1`.

| Lock | Key | Helper / where | Tier | Serialises |
| --- | --- | --- | --- | --- |
| **Global booking / money** | `1` (literal) | inline `tx.$executeRaw` | 2 | Booking-status + money side effects that must exclude across the whole booking regardless of lodge: cancel, capture/settle, hold-release, group-settlement reaper/settle/refund/organiser-cancel, refunds, credit restore; plus bed-allocation inventory/placement/move/range/auto/approval/removal writers that must serialize with lifecycle prune. Member merge is the one bed-allocation writer that deliberately does NOT take this key — see "Merge joins the bed-allocation cohort" (#2595). |
| **Per-lodge capacity** | `hashtextextended(<lodgeId>, 0)` | `acquireLodgeCapacityLock(tx, lodgeId)` (`lodge-capacity-lock.ts`, re-exported by `capacity.ts`) | 1 | Capacity claims/checks and bed-allocation mutations for one lodge; booking admission versus lodge deactivation; hut-leader overlap and optional bed-hold writes; roster eligibility snapshots; and direct or config-transfer chore-template changes, which serialize active-template validation for that lodge. |
| **Per-member night footprint** | `hashtext("booking-member-night"), hashtext(<memberId>)` | `lockBookingMemberNights(tx, guests)` (`booking-member-night-conflicts.ts`) | cross-lodge | Serialises the person-night guard ACROSS lodges (see below). |
| **Per-owner hosting coverage** | `hashtext("hosting-coverage-owner"), hashtext(<Booking.memberId>)` | `lockHostingCoverageOwner` / `lockHostingCoverageOwners` (`adult-member-hosting-coverage-lock.ts`) | cross-booking | Serialises `SAME_BOOKING_OWNER` coverage (#2576 §9): one booking's compliance depends on another booking of the SAME owner, so the key remains authoritative even though #2600 made allocation-participating confirmation and cancellation compose global → lodge. Taken LAST among the application lock families a caller composes. Roster-aware modification paths take global → lodge → roster-date → any applicable member keys → sorted queue-participant `Member FOR KEY SHARE NOWAIT` rows → coverage-owner; queued incident reconciliation takes hosting policy-set → sorted claimed member-lifecycle keys → sorted claimed `Member FOR KEY SHARE` rows → coverage-owner. Paths that do not use roster or member keys omit those tiers. Ordinary producers try sorted owner keys before re-entering the blocking helper, while merge takes its sorted owner keys only after its one sorted participant `FOR UPDATE` statement. The key is taken only when the lodge actually has the scope enabled. |
| **Per-member credit ledger** | `hashtext("member-credit-ledger"), hashtext(<memberId>)` | `lockMemberCreditLedger(memberId, tx)` (`member-credit.ts`) | — | A member's credit-ledger balance operations (spend, negative-adjustment validation, orphan-restore repair, the Xero inbound applied-credit repair, and the F20 pre-payment-reduction applied-credit clamp `clampAppliedCreditToBookingPrice`, taken inside the modification transaction only when the booking carries applied credit, and the #2265 stored-election consumption `consumeStoredCreditElection`, taken inside the `create-payment-intent` pay transaction and the Internet Banking switch transaction only when the booking carries an outstanding election). |
| **Member lifecycle** | `hashtext("member-lifecycle:<memberId>")` | inline (`member-lifecycle-actions.ts`, `app/api/admin/deletion-requests/[id]/route.ts`, `nomination.ts` approval mapping, `admin-family-group-requests-service.ts`, `member-merge.ts`, `adult-member-hosting-coverage-drain.ts`) | — | Archive/delete of one member; account-deletion approval (the #1756 partner-share prefix — global cohort `lock(1)` + every affected lodge, sorted — and only then member lifecycle → shared standing-subject `Member FOR UPDATE NOWAIT` → exact queue-participant `Member FOR KEY SHARE NOWAIT` rows → coverage-owner before deactivation and guest unlink); overwrite of one member by application-approval mapping (E10, #1936); linking/removing one member into/from a family group on admin request review; **member merge** (dual-lock on master + loser, E11 #1937, see below — merge takes the merge-only partner-share prefix, so every affected lodge key is held BEFORE this tier while the global cohort key is deliberately NOT taken at all, and the two `member-partner-link:` keys immediately AFTER it, #2595); and the queue-drain handshake that prevents a claimed hosting item from using identities while merge re-points them. |
| **Membership application** | `hashtext(<application key>)` | `membershipApplicationLockKey` (`nomination.ts`) | — | State transitions of one membership application. |
| **Membership applicant** | `hashtext(<applicant-email key>)` | `membershipApplicationApplicantLockKey` (`nomination.ts`) | — | Per-email applicant dedup at submit time. |
| **Roster-date writers** | `hashtext("roster:<date>")` | `lockRosterDate(tx, date)` / sorted `lockRosterDates(tx, dates)` (`roster-lock.ts`) | date | Serialises whole-roster save/regenerate/confirm/auto-suggest, kiosk confirm and complete/uncomplete, and booking/guest cleanup that can remove suggested rows for the same lodge night. |
| **Config-transfer import** | `hashtext("config-transfer-import")` | `acquireConfigImportLock(tx)` (`config-transfer-lock.ts`) | — | Single-flights configuration-bundle apply and excludes lodge identity mutations while an import resolves bundle slugs to immutable lodge ids. A lodge update/deactivation then takes its immutable target-lodge capacity key before re-reading the lodge and active-lodge/dependency predicates. |
| **Minimum-stay policy set** | `hashtext("minimum-stay-policy-set")` | `lockMinimumStayPolicySet(tx)` (`minimum-stay-policy-set.ts`) plus the migration's `MinimumStayPolicy_lock_set` statement trigger | policy config | Serialises every live CRUD and config-transfer replacement across the small club/lodge policy set. The database trigger puts draining old-colour DML behind the exact same key before any tuple lock. |
| **Adult-member hosting policy set** | `hashtext("adult-member-hosting-policy-set")` | `lockAdultMemberHostingPolicySet(tx)` / `tryLockAdultMemberHostingPolicySet(tx)` (`adult-member-hosting-policy-set.ts`) plus the migration's `AdultMemberHostingPolicy_lock_set` statement trigger | policy config | Serialises the admin write route and the config-transfer replacement over the one club row plus one row per lodge (#2364), fences the drain's policy read before incident reconciliation, and excludes member merge while policy reconciliation enumerates bookings and inserts queue rows. Unlike its minimum-stay sibling the trigger is NOT a blue/green drain boundary — the table did not exist before its own migration, so no old colour writes it — it is there so advisory-before-tuple order holds for every writer, operator psql included. Policy writers and merge take the blocking form. The drain takes the fail-fast form, releases a contended exact queue claim without consuming an attempt, and otherwise composes policy-set → sorted member-lifecycle → sorted `Member FOR KEY SHARE` rows → coverage-owner. |
| **Membership subscription billing** | `hashtext("membership-subscription-billing:<seasonYear>")` | `confirmSubscriptionBillingPreview`, `reconcileSubscriptionBillingExceptions` (`membership-subscription-billing.ts`) | — | Annual/approval charge snapshot creation for one membership year; the #2148 refresh-reconciliation holds the same key so exception auto-resolution serialises with confirm and never resolves rows a concurrent confirm is regenerating. The #2161 operator family-marker writers (MARK/UNMARK on the subscription-billing route) deliberately take **no** advisory lock: they only insert/release a `FamilyGroupSeasonInvoiceMarker` row (single-active enforced by a partial unique index, so a concurrent double-mark is a benign no-op), and confirm re-derives suppression from the live marker rows under this same lock inside its transaction, so a mark landing mid-confirm either is seen by the in-tx re-preview or shifts the confirmation token — never a torn snapshot. |
| **Authoritative fee schedule** | `hashtext("fee-schedule:<domain>:<key>")` | `lockFeeSchedule` (`authoritative-fees.ts`) | — | Serialises effective-dated membership or entrance-fee schedule changes for one configured key. |
| **Member partner link** | sorted `hashtext("member-partner-link:<memberId>")` keys | `acquireMemberPartnerLinkLocks` (`member-partner-lock.ts`), called by `lockPartnerMembers` (`member-partner-link.ts`), the reviewed move (`bed-allocation-move.ts`) and member merge (`member-merge.ts`) | — | Serialises partner-link invariants across every member touched by a link; same-family keys are sorted. The CONFIRMED partial uniques are per side (`memberAId`, `memberBId`), so "at most one confirmed partner" is enforced by this key alone — every writer of a CONFIRMED link, and every reader whose read decides a write, must hold it. The partner-link service takes ONLY this family; the reviewed move and merge take it LAST, after member-lifecycle, so the one edge into it is one-way (#2595). |
| **Xero member contact link (legacy key)** | `hashtext(<memberId>)` | short local-link transactions (`xero-contacts.ts`) | — | First-writer-wins local `Member.xeroContactId` linking after provider work. This legacy unnamespaced key is shared by both Xero contact-link writers; do not copy it for new domains. |
| **Diagnostics budget reserve (per month)** | `hashtext("diagnostics-budget-reserve"), hashtext(<month>)` | `reserveDiagnosticsBudget` **and** `settleDiagnosticsRoundtrip` (`ai-diagnostics-usage.ts`, AID-2 #2371) | — | Serialises every AI Diagnostics budget RESERVE **and** SETTLE for one billing month so the reserve's read-check-insert (sum live reservations + settled spend, compare to budget, insert reservation) is atomic against concurrent reservers AND against a settle's reservation-delete + `settledCents` increment. A burst of paid diagnostics roundtrips therefore cannot push `settled + reserved` over the monthly budget, and a settle can never commit mid-reserve to under-count committed spend; a lost claim (over budget) inserts nothing and denies the paid call. Different months do not contend. Held only for the milliseconds of each short transaction; the provider call runs entirely OUTSIDE both. Both take ONLY this key (no second lock), so no ordering cycle is possible. See "Composition: diagnostics budget reserve" below. |
| **Backup run claim** | `hashtext("backup:run-lock")` | `claimBackupRun` (`backup-run.ts`, #2095) | — | Single-flights managed database backups across containers (nightly cron vs admin run-now). Held only for the milliseconds of the reap-stale → active-check → insert-RUNNING claim transaction; the `pg_dump`/upload pipeline runs entirely outside any transaction, so a crashed run can never wedge the lock (a dead RUNNING row is reaped by heartbeat age on the next claim). Single-lock holder; composes with no other family. The config-transfer pre-apply safety backup deliberately bypasses this claim (it must run inline; concurrent dumps are independent snapshots writing uniquely-named files). |

### Composition: lodge admission, deactivation and hut-leader assignments (#2701)

The immutable lodge id is the one mint for this cohort's per-lodge key. Booking
creation resolves an explicit requested lodge id, then takes any applicable
global tier followed by that lodge's capacity key. Only after the key is held
does it re-read active status, member access and the requested room before
admitting a draft, confirmed booking or waitlist entry. Lodge deactivation
takes the config-transfer singleton first, then the same target-lodge key, and
re-reads the target, the other-active-lodge predicate and all blocking
dependencies. Consequently a create cannot validate an active lodge and commit
after its deactivation, while two attempts to deactivate the last two lodges
cannot both validate the other's stale active state.

There are **six** writers of `HutLeaderAssignment`. Three of them decide the
overlap predicate, and those three take this per-lodge key and re-read overlap
under it. The guarantee that buys is narrower than "one lodge cannot end up
with two overlapping hut leaders", and the narrower statement is the true one:

> No two hut-leader assignments overlap by more than one day at one lodge,
> **except assignments created by the school-approval path**, which neither
> decide the predicate nor are counted by it.

The second half of that exemption is #2926. Until then the school path did not
decide the predicate but its rows still *blocked*, so a school group silently
refused every later manual or cron assignment for those nights while never being
refused itself. Nothing had decided that asymmetry. The owner decided it on 17
Aug 2026: teacher records do not block independent assignments. Only that one
direction changed — whether an existing assignment blocks a TEACHER is
unchanged, because the school path still runs no overlap read.

**The exemption is keyed on `HutLeaderAssignment.source`, the provenance the
CREATING writer stamps, and that is load-bearing rather than an implementation
detail.** The first attempt keyed it on `Member.role != "SCHOOL"`, which reads
correctly and is wrong: `Member.role` is DERIVED and admin-writable
(`legacyRoleFromAccessRoles` maps the `ORG` access role to `SCHOOL`, and the
member editor's User Type control grants `ORG`), so reclassifying an ordinary
member as an organisation removed their LIVE assignment from the predicate and
let an admin or the cron create a second overlapping leader for those nights.
Reading the access role instead fails the same way one step earlier —
`accessRoleTokensForUserType("organisation")` returns `["ORG"]`, dropping
`USER`. `Member.role = "SCHOOL"` is also the school CONTACT member, not only a
teacher. `source` is written once by the insert and by nothing afterwards, so no
membership edit can move it.

There is no unique constraint on the range behind the application check, so
that holds only for as long as all three keep deciding under the key:

- `POST /api/admin/hut-leaders` — role-only and bed-holding alike. Member,
  overlap and optional bed-availability checks all re-run under the key.
- `PUT /api/admin/hut-leaders/[id]` — including an edit that clears the bed or
  never had one. #2887 corrected this: #2286 had locked only the bed-holding
  branch on the reasoning that releasing capacity is safe, which is true of
  capacity and false of the overlap predicate a bedless edit can still break by
  MOVING DATES.
- `cron-hut-leader-auto-assign` — two changes, from two PRs, and both are
  needed. #2915 restructured the job to iterate active lodges and decide every
  question per (lodge, night): one lodge's leader used to silence every other
  lodge for that night, and two lodges with one eligible adult each summed to
  two so neither got one. #2887 then put the create inside a transaction
  holding that lodge's key, with the already-covered and overlap questions
  re-asked under it — scoping alone still let the cron race an admin, or a
  second cron container, into two overlapping leaders at one lodge.

Different lodges retain independent keys. Confirmation email is sent only after
commit and outside the transaction.

The other three writers, and why the guarantee is worded the way it is:

- `school-booking-request.ts` creates one assignment **per teacher** when a
  school request is approved — same dates, same lodge, deliberately overlapping
  each other, because several teachers do supervise one group together. It holds
  the lodge key (it is inside the approval transaction) but runs no overlap read,
  and must not: adding one would refuse the club's own school bookings. It is
  also the only writer that stamps `source = SCHOOL_BOOKING`, which is what takes
  those rows out of the other three writers' predicate (#2926).

  This is the exemption in the rule above, and it covers TWO cases, which is why
  the wording names the PATH rather than the relationship between the rows. The
  first is the teachers of one approval overlapping each other, by design. The
  second is easy to miss: nothing forbids two separately approved school bookings
  at the same lodge on overlapping dates, and neither approval transaction reads
  overlap, so their teacher assignments overlap too. An earlier wording said "no
  two **independently created** assignments overlap", which reads as covering the
  second case and does not — those two approvals are as independent as any two
  writes in the system.
- `[id]/pin/route.ts` rotates a PIN and `[id]/route.ts`'s DELETE removes a row.
  Both write on the base client outside any lock. Neither can create an overlap
  — one changes no dates and no lodge, the other only ever removes a row — so
  neither needs the key.

**The cron's coverage probes are a fifth decision point, and they are
deliberately NOT the same rule** (#2926). `cron-hut-leader-auto-assign` asks two
questions per (lodge, night): *is this night already covered?* — a `findFirst`
over any assignment spanning the night, once cheaply and once again under the key
— and *would this assignment overlap?*, which is the shared predicate. The
coverage probes stay **source-blind**: a school-teacher row counts as coverage,
so the job does not auto-assign a leader for a night a school group already has
teachers on site. The overlap predicate excludes those same rows **only for a
deliberate caller**: the carve-out is opt-in via `allowOverlappingSchoolRows`,
the two admin routes pass it, and the cron does not. That is not an
inconsistency, it is the two questions being different ones: coverage is
automatic and should stay out of the way when somebody responsible is already
there, while overlap is a REFUSAL and must not refuse an officer who has
deliberately decided to add a leader.

**Why the carve-out is opt-in rather than unconditional.** Applying it to the
cron as well was a reachable defect, not a theoretical one. The coverage probes
ask about ONE night, while the row the job creates spans the guest's whole stay.
Teachers 10-14 Aug; a sole adult's stay 12-20 Aug; the loop reaches 15 Aug, whose
coverage probe finds nothing; with the carve-out applied the span read over
12-20 Aug skipped the teacher rows and the job planted a CRON row across
12-20 Aug, including the school nights it is documented never to reach. Being
MANUAL-equivalent, that row then blocked officers across the whole span. Omitting
the flag restores exactly the pre-carve-out refusal for the job, so the night
stays uncovered as it did before — which is the intended behaviour, not a
regression. Both probes must keep agreeing with each
other — a locked re-ask that answered a different question from the cheap one
would make the two skips disagree.

**COVERAGE is a whole class of reader, and every one of them stays
source-blind.** The cron's two probes are the ones that can refuse an automatic
write, which is why they are named above, but `hut-leader-coverage.ts`, the
admin page's uncovered-dates panel and the `eligible-members` suggester all ask
the same "is somebody on site that night?" question, and all of them should keep
counting a teacher. The consequence to know about is a conservatism, not a
defect: on a night a school group occupies, the suggester still reports the
member as fully covered and offers no range, even though the POST would now
accept one. An officer who wants a leader beside the teachers adds the
assignment directly and is no longer refused. Anything NEW that refuses a write
on the strength of an overlap belongs behind `findHutLeaderOverlapRefusal`
rather than behind its own read.

### Composition: roster-date writers (#2586)

`lockRosterDate` is the only source of the `roster:<date>` key. Every operation
that validates guest eligibility before creating or re-attributing assignments
(admin GET auto-suggest, whole-roster Save, Regenerate, Confirm and email
selection, and kiosk
whole-roster Confirm) takes the complete order **global booking lock(1) →
immutable lodge-capacity lock → roster-date lock → authoritative re-read →
assignment rows**. Joining the booking writers' first two tiers is essential
even when no assignment exists yet: otherwise a roster Save could validate an
old stay, wait while a booking moves or a review is approved, then insert into
the previously empty partition.

Booking date/batch modifications already hold global → lodge. They now acquire
one sorted set containing every night in the old and proposed stay ranges **plus
both the old and the new CHECK-OUT dates** — since #2622 a chore row can
legitimately sit on a booking's check-out date (the departure morning), so a set
built from the half-open night ranges alone would leave that partition unlocked
and a concurrent whole-roster Save could insert into it after the modification
had already decided to clean it up. Every such caller derives its ranges through
`rosterOperationalDayRange(checkIn, checkOut)` (`roster-lock.ts`), which extends
a half-open night range to its inclusive operational-day span; the exceptional
stored assignment dates are added to the same sorted set, all before changing a
Booking or BookingGuest tuple. Guest removal and kiosk departure derive their
sets from STORED assignment dates rather than an envelope, so they cover
checkout-day rows without widening: guest removal takes global → lodge → sorted
stored roster dates before its post-lock re-read and guarded deletion. Member
guest consent and admin booking-review claims share global → lodge; guest add
shares the immutable lodge tier. Those common tiers serialize eligibility
changes with roster validation without making every booking writer enumerate
every possible roster night.

The three roster-aware booking modification paths continue into the optional
member-night and member-credit tiers only after their roster-date set is held,
then call the same-owner hosting reconciler last. Guest removal likewise reaches
the hosting reconciler only after its sorted roster-date locks, guest deletion
and any applicable member-credit write. Thus their concrete composition is
global → lodge → roster-date → applicable member keys → coverage-owner. This is
not a claim that every booking writer takes every tier: create, confirm, cancel,
membership fan-out and drain paths omit the roster and/or member keys they do
not use. The invariant is that a path which does compose them never takes a
roster-date or member key after the coverage-owner key.

Cleanup's own out-of-range predicate is the operational span, not the night
range: it removes rows strictly before check-in or strictly after check-out, and
its guest-level counterpart asks the same operational-day helper roster
eligibility asks (#2622, epic D-M6) against the canonical night rows. Cleanup
and eligibility therefore cannot disagree about whether a given date was
occupied, which is what makes the widened lock set sufficient rather than merely
larger.

Kiosk complete/uncomplete takes only the affected roster-date key. Departure
timestamps are not eligibility inputs, but departure cleanup also updates the
same `BookingGuest` tuple as consent decline/expiry. It therefore joins the
global, lodge, sorted roster-date, then BookingGuest order so it cannot invert
the consent writer's first two tiers and deadlock on guest-versus-roster
resources. A multi-night cleanup sorts and de-duplicates all keys before
acquiring the first one. After any wait, cleanup re-reads its targets and uses
guarded `deleteMany` predicates, so a row re-attributed by a whole-roster Save
is never deleted from a stale id snapshot.

The lock is date-wide rather than lodge-wide because `ChoreAssignment` has no
`lodgeId`. Isolation still comes from every current-row predicate requiring both
the related `Booking.lodgeId` and `ChoreTemplate.lodgeId`; the wider lock trades
some cross-lodge concurrency for one unambiguous key shared with legacy writers.
Whole-roster Save re-reads its revision, eligible guests, and active templates
after acquiring the lock and performs no mutation on a stale or invalid draft.
It then deletes removed rows and creates/updates retained rows in that same
transaction, writing both authoritative booking and guest foreign keys.
Admin chore-template update/delete takes the same lodge tier before its
post-lock re-read and tuple mutation, so deactivation cannot commit between a
roster action's active-template check and assignment write. Configuration
transfer takes its singleton first, then any selected policy-set locks, then
every existing lodge represented by the lodge-config bundle in sorted id order,
all before its in-lock re-plan. Its chore-template fingerprint and writes are
therefore protected by the same lodge tier; a newly created lodge needs no key
because its id is not visible to a concurrent roster transaction before commit.
Admin lodge create and rename take the config-transfer singleton before deriving
or writing a slug, so the bundle-slug mapping cannot acquire a new, unlocked
existing target after the import chooses its lodge keys. These writers take no
policy-set or lodge-capacity key, so they cannot invert the import's order.

Roster email **selection** uses the short eligibility transaction and rejects an
ineligible guest or inactive template before minting any token. Effective-email
and preference reads, token refresh, and provider sends remain outside that
transaction. The lock participant inventory and acquisition-order contracts
are enforced by `advisory-lock-guard.test.ts` and
`roster-lock-contract.test.ts`.

### Composition: minimum-stay policy set (#2363)

`POST /api/admin/booking-policies/minimum-stay` and the row-level `PUT` and
`DELETE` routes call `lockMinimumStayPolicySet(tx)` before their first policy or
lodge read, then re-read/validate and write inside the same transaction. The
policy set is club-sized, so one global configuration key is intentionally
preferred to per-scope concurrency: it gives every writer one unambiguous lock
order across a blue/green drain.

The additive migration also installs `MinimumStayPolicy_lock_set`, a `BEFORE
STATEMENT` trigger for INSERT, UPDATE and DELETE. A draining old colour cannot
call the TypeScript helper, but PostgreSQL takes the same
`hashtext("minimum-stay-policy-set")` transaction lock before that statement
reaches any row. New-runtime DML merely re-enters the lock it already holds.
This keeps both colours in **advisory → tuple row** order; do not move this lock
into a row trigger, which would invert old-colour order against the new routes.
A separate `BEFORE ROW` trigger manages only the integer revision after the
statement lock is held: material old-colour updates advance an unchanged token,
new `OLD + 1` CAS writes are not double-incremented, and non-material writes keep
the old token.

Configuration transfer composes two global configuration keys in one fixed
order: `config-transfer-import` **first**, then `minimum-stay-policy-set`, before
the booking-policy category re-fingerprints or replaces any rows. Live CRUD
takes only the second key, and no policy writer takes them in reverse, so this
composition cannot form a cycle. The database statement trigger re-enters the
second key during import DML.

#### Which client reads the policy set

`validateMinimumStay` (`booking-policies.ts`) takes an optional trailing `db`
that defaults to the module-level Prisma client. The rule is one line: **a
caller already inside `prisma.$transaction` MUST pass its own `tx`.** Two
callers are in that position — `modifyBookingBatch`
(`booking-batch-modification-service.ts`) and `modifyBookingDates`
(`booking-date-modification-service.ts`) — and both run the check while holding
`pg_advisory_xact_lock(1)` **and** the per-lodge capacity lock. Reading through
the module client there checks out a **second pool connection underneath both
locks**, which is the pool-starvation shape the ordering rule at the top of
`member-guest-add-policy.ts` exists to forbid: under load every connection can
end up held by a transaction waiting for a connection. Passing `tx` also gives
the check the transaction's own snapshot instead of a second, later one.

Every other caller is deliberately OUTSIDE a transaction and keeps the default:
booking create, both public group-join stages, the member group join, the two
waitlist-offer confirm paths, the advisory modify quote, and the policy-check
route. Those are pre-write checks with no lock held, so the module client is
correct and cheapest there. The residual window between such a read and the
claim that follows it is milliseconds and is the same footing every other
pre-write policy check on those paths sits on.

This is a **pool** argument, not a lock-order one: no minimum-stay policy writer
ever takes a per-lodge capacity lock, and no booking path takes the policy-set
key, so the two keyspaces are disjoint and cannot deadlock in either order.
`booking-batch-modification-minimum-stay.test.ts` and
`booking-date-modification-minimum-stay.test.ts` each pin their call site to the
transaction client so a future edit cannot silently reintroduce the second
connection.

### Composition: adult-member hosting policy set (#2364)

`PUT /api/admin/booking-policies/adult-member-hosting` calls
`lockAdultMemberHostingPolicySet(tx)` before its first policy or lodge read, then
compare-and-swaps on the revision it read inside the same transaction. The set is
one club row plus at most one row per lodge, so a single global configuration key
is deliberately preferred to per-scope concurrency.

Configuration transfer composes three global configuration keys in one fixed
order: `config-transfer-import`, then `minimum-stay-policy-set`, then
`adult-member-hosting-policy-set`, all before the booking-policy category
re-fingerprints or replaces any row. Live CRUD takes exactly one of the last two
and never both, and no writer takes them in another order, so the three cannot
form a cycle.

The `AdultMemberHostingPolicy_lock_set` `BEFORE STATEMENT` trigger takes the same
key ahead of any tuple lock. Its purpose differs from the #2363 one it copies:
that trigger exists because a draining old colour already wrote
`MinimumStayPolicy` and could not call the TypeScript helper, whereas this table
was created by its own migration and has no old-colour writer at all. It is kept
so the ordering holds unconditionally — for operator psql and for any future
colour — rather than only for the code paths that exist today. A separate `BEFORE
ROW` trigger manages the revision after the statement lock is held, and is
stricter than its sibling: a material update must present `OLD + 1`, and a
non-material one keeps the token so a no-op cannot invalidate somebody's open
editor.

#### Which client reads the hosting policy

`loadAdultMemberHostingPolicy` (`adult-member-hosting-review.ts`) takes the same
optional trailing `db` as `validateMinimumStay`, under the same one-line rule: **a
caller already inside `prisma.$transaction` MUST pass its own `tx`.** Every
enforcement site is in that position, because the hosting review is reconciled
inside the booking write itself — booking create (all three services plus the
split child), `modifyBookingBatch`, `modifyBookingDates`, `adminShiftBookingDates`,
the guest-add route, the guest-removal service and the waitlist confirm — and all
of them hold `pg_advisory_xact_lock(1)` and/or a per-lodge capacity lock while
they do it. Reaching for the module client there would check out a second pool
connection underneath both locks, which is the pool-starvation shape the ordering
rule at the top of `member-guest-add-policy.ts` forbids.

The one caller that keeps the default is the booking-create route's
pre-transaction check for an admin on-behalf confirmation, which runs before any
transaction is opened. This is a pool argument, not a lock-order one: no hosting
policy writer takes a per-lodge capacity lock and no booking path takes the
policy-set key, so the keyspaces are disjoint and cannot deadlock in either
order.

#### Same-owner coverage takes a per-owner key (#2576)

`SAME_BOOKING_OWNER` makes one booking's compliance a function of ANOTHER booking's
rows, so it gets its own advisory-lock family: `hosting-coverage-owner`, keyed on the
booking OWNER.

**An earlier version of this section argued the opposite, and it was wrong.** The
argument was that coverage is same-lodge by definition (§4), so "every path that can
confirm a booking and every path that can remove exact-night attendance already takes
`acquireLodgeCapacityLock` for that lodge", leaving two interacting writers always
contending for the same per-lodge key. When #2576 introduced the owner key, that was
false in both directions:

- `booking-cancel.ts`'s four claim transactions took `pg_advisory_xact_lock(1)` and
  not `acquireLodgeCapacityLock`;
- `booking-create.ts` and the guest-add route took `acquireLodgeCapacityLock` and
  not `pg_advisory_xact_lock(1)`.

Those different keys at READ COMMITTED left the named create-versus-cancel race
open. #2593 later made the allocation-participating confirmed-create and cancellation
paths compose global → lodge. That later overlap does not retire the owner key:
coverage is a cross-booking, per-owner invariant, and participant/member/queue
producers do not all share those tiers. The coverage-owner key remains the
authoritative common serialisation point and stays last.

The invariant is per-OWNER, so the key is the owner — the same reasoning that gave
`lockBookingMemberNights` its own family, because per-lodge locks cannot serialise a
per-member invariant. `lockHostingCoverageOwner` is taken by every reader and writer
of same-owner cover:

- `evaluateBookingAdultMemberHosting`, before it reads another booking as cover
  (and only when `SAME_BOOKING_OWNER` is actually enabled);
- `settleSameOwnerDependentCoverage`, before it reads cross-booking dependents;
- `enqueueOwnHostingCoverageReevaluation`, the seam the confirming paths use instead
  of evaluating (it still queues under `SAME_BOOKING`; only the owner lock is
  conditional on `SAME_BOOKING_OWNER`);
- `enqueueHostingCoverageReevaluationForMember`, the §8 membership-lifecycle fan-out,
  which collects the affected booking owners and takes their keys together through
  `lockHostingCoverageOwners`, in sorted owner-id order.

**Acquisition order: the coverage-owner key is always last among the application
locks a caller actually takes.** It follows `pg_advisory_xact_lock(1)`,
`acquireLodgeCapacityLock`, roster-date locks, `lockBookingMemberNights` and
member-credit locks wherever those families participate. The roster-aware batch,
date and admin-shift services therefore use global → lodge → sorted roster dates →
member-night (when the party contains linked members) → member-credit (when the edit
writes credit) → coverage-owner. Guest removal has no member-night guard and omits
that tier; create, confirm, cancel, membership fan-out and drain paths omit the
roster and/or member tiers they do not use. This is one partial order with optional
tiers, not a claim that every path takes the complete chain. Several owners are
locked in sorted order, the same discipline the member-night lock uses. Postgres
advisory locks are re-entrant per session, so a transaction that takes the same
owner key twice (the evaluator and then the settle step) pays nothing for the
second acquisition.

A club that has not enabled the scope never takes the key: every caller resolves the
lodge policy first and skips the lock.

`settleSameOwnerDependentCoverage` reads through the CALLER's `tx` for the same
reason every other hosting read does, so it sees that transaction's own writes and
the committed state of everything else.

The DRAIN starts outside the authoritative transaction. `HostingCoverageReevaluation`
rows are written inside that transaction — the change and the obligation to look at
its consequences commit or roll back together — and
`drainHostingCoverageReevaluations` starts only after it commits, so it re-reads
COMMITTED facts. Each bounded queue item then gets its own short transaction: the
transaction-scoped owner lock must stay held through the reconciliation reads and
incident writes. Email remains outside that item transaction and is sent only after
it commits. `settleHostingCoverageAfterCommit` is the wrapper the mutation paths call
for that, and it never accepts a caller's `tx`;
`adult-member-hosting-call-sites.test.ts` asserts so tree-wide.

Incident reconciliation composes one additional fixed chain. It first attempts the
adult-member hosting policy-set key so a policy demotion cannot race a fresh urgent
incident. This drain acquisition is deliberately non-blocking: member merge may hold
the key for its whole long transaction, while Prisma's default short transaction
deadline includes lock wait. On contention the item transaction returns before any
lifecycle lock, payload read, reconciliation or notification claim, then the worker
exact-token releases Q, clears its lease and reverses the claim-time attempt. The
same invocation's `seenIds` prevents a hot loop, while merge's post-commit drain can
claim the item immediately; repeated cross-worker contention therefore delays work
without exhausting `maxAttempts`. Errors after acquisition remain poison-item
failures and retain ordinary attempt accounting. A queue claim is only an in-memory
snapshot: member merge may re-point its
owner and FK-less actor after the claim commits. The drain therefore takes the
sorted, unique `member-lifecycle:<id>` keys for the claimed owner and actor, then
locks those same `Member` rows `FOR KEY SHARE`, and only then re-reads the complete
queue payload through Prisma with exact `id + claimToken + processedAt: null`.
Every later read uses the refreshed owner, actor, lodge, nights, cause, source and
reason; a missing exact claim performs no work.
The dependent-id read remains deterministically capped at 25, so absence from that
list is never treated as proof that the source booking was cancelled. While the
same policy/lifecycle/Member locks are held, the drain reads the refreshed source id
directly and applies the shared terminal-attendance predicate: only a missing,
soft-deleted, `CANCELLED`, or `BUMPED` source receives the `BOOKING_CANCELLED`
incident resolution. Every extant non-terminal lifecycle stays unresolved even if
it sorts beyond the bounded fan-out.
If the refreshed owner/actor set differs from the set locked by that transaction,
the drain performs no reconciliation and starts a new transaction from the
refreshed payload. This avoids acquiring a newly discovered id out of sorted order
and also covers a second merge of the first survivor. After three unstable reads
the exact claim is failed for a later sweep instead of processing an unfenced id.

The advisory tier is the merge handshake for a queue row that already exists; its
later Member row lock is too late. Member merge takes the hosting policy-set key and
then sorted member-lifecycle keys at transaction entry, before it re-points
relations. If drain wins, merge waits and later re-points the drain's committed
incident effects. If merge already re-pointed the persisted queue row, the typed
queue re-read sees the survivor. The composed order is **policy-set → sorted
member-lifecycle → sorted Member KEY SHARE → exact queue re-read → coverage-owner**.
Member merge joins the first two tiers in that same direction;
every other member-lifecycle participant omits the policy key. Policy writers take
no lifecycle, Member-row or coverage-owner lock, so no counterpart reverses this
chain. The queue read is deliberately not a `FOR UPDATE`: no queue tuple lock is
held while the member tiers are acquired, so there is no queue → Member inversion.

Ordinary producers close the new-row side of that handshake at each high-level
enqueue seam (#2597). **Each seam reads the lodge's resolved hosting mode first and
returns before acquiring anything when that mode gives it nothing to do** (#2623 T5).
The two seams do not share one threshold, and the difference is deliberate rather
than drift:

| Seam | Returns early when | Why |
| --- | --- | --- |
| `enqueueOwnHostingCoverageReevaluation` | `mode !== "ENFORCED"` | It only enqueues queue work, and only an ENFORCED lodge can ever act on it. |
| `reconcileAdultMemberHostingReviewWithSiblings` | mode is neither `ENFORCED` nor `ADMIN_REVIEW_REQUIRED` | Under review-only the dependants must still be re-read and a review snapshot written, so the fence is genuinely owed. |

Widening the first to the second's test would take a lock for work that cannot
exist; narrowing the second to the first's would skip the fence at a review-only
lodge that needs it.

That gate is a correctness statement as well as a cost one: with the mode inactive
the evaluator takes no coverage-owner advisory key and neither the sibling fan-out
nor the same-owner settle step is reachable, so there is no ordering left to protect
— while without it, a club with hosting `DISABLED` paid a row lock on every booking
write and could be refused with the fixed `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409 by
a concurrent member-lifecycle writer, for a rule it does not use. A club that enables
the rule concurrently is covered by the policy write's own enumerate-and-enqueue
reconciliation under the policy-set key — and the un-fenced return the gate takes
passes `failFastCoverageOwner`, so if the rule does turn on between that read and the
reconciler's own one call deeper, the coverage-owner key is acquired with
`pg_try_advisory_xact_lock` and the caller gets the stable retry 409 rather than a
blocking wait taken inside its booking transaction. That path can write no queue row:
it holds no participant proof, and every queue write demands one.
Once the mode is active, before any coverage-owner key they plan the exact source
booking owners plus the non-null actor, sort and de-duplicate the ids, and lock those
`Member` rows in one `FOR KEY SHARE NOWAIT` statement. They then verify typed Member
existence and re-read each source booking's authoritative owner and lodge. A missing
participant, `55P03`, changed source attribution, or final queue owner/actor outside
the runtime-issued exact proof throws the fixed
`HOSTING_COVERAGE_PARTICIPANT_RETRY` 409 and rolls the caller's complete outer
transaction back. Interactive callers tell the operator to reload before retrying
and to check payment status where applicable; automated callers retain their
existing retry/redelivery boundary.

That proof is a capability, not a plain value: `acquireHostingCoverageQueueParticipantProof`
registers each object it returns in a module-private `WeakSet`, and
`assertHostingCoverageQueueParticipantsLocked` rejects anything absent from it, so a
structurally identical object literal cannot stand in for a locked participant set.
**`acquireHostingCoverageQueueParticipantProof` can never issue a proof it did not lock
for.** A client that cannot execute the lock statement (no `$executeRaw`) is refused
with `HostingCoverageParticipantFenceUnavailableError` rather than being handed an
unlocked proof; that error is deliberately *not* the retryable
`HOSTING_COVERAGE_PARTICIPANT_RETRY` 409, because it reports a wiring fault that no
amount of retrying can clear.

That guarantee is scoped to the acquire seam, and deliberately so: the module's second
proof-minting export, `proveMemberMergeHostingCoverageParticipants`, takes no lock of
its own. It exists because member merge acquires its participants separately, through
`lockMemberMergeHostingCoverageParticipants`, and then attests to that acquisition. Both
sides pass plain `readonly string[]`, so **nothing at the type level ties the attested
ids to the ids actually locked** — on that half the invariant is a convention its one
caller (`member-merge.ts`) currently keeps, not a structural guarantee. A second
merge-like path that hand-built `lockedMemberIds` would obtain a proof the whole
downstream chain trusts, with no row lock ever taken. Brand that return type before
adding one.

A double standing in for this client must model **both** under-lock reads, not just the
lock: `member.findMany` for the existence/order re-read, **and** `booking.findMany` for
the owner/lodge re-read behind the `sourceFingerprint` drift check. Modelling only the
first leaves the second returning nothing, which the fence correctly reads as drift and
reports as an unexplained 409. `src/lib/__tests__/support/hosting-participant-fence-double.ts`
provides both; `src/lib/__tests__/adult-member-hosting-queue-participants.test.ts` shows
the minimal shape. Narrowing a double is not a licence to disable the fence for the call
sites that double reaches. That rule is now enforced on the source itself and not only
in behaviour: `adult-member-hosting-queue-participants.test.ts` asserts that every
`issueProof` inside `acquireHostingCoverageQueueParticipantProof` sits *after* the
`FOR KEY SHARE NOWAIT` statement, so a future early return placed above the lock fails
the suite even if it is shaped differently from the one #2619 removed.

Because `HostingCoverageParticipantFenceUnavailableError` deliberately carries no `code`,
the four boundaries that re-throw only `HOSTING_COVERAGE_PARTICIPANT_RETRY` and turn
everything else into an operator warning — the Xero link, push and contact-import routes'
subscription-history refresh, and the shared `recordLinkedContactSubscriptionSyncError` —
report it as a partial-success warning rather than failing the request. That is a
consequence of keeping the wiring fault out of the retryable 409 hierarchy, which is
correct: no amount of retrying grows a client a `$executeRaw` method, so a 409 there would
invite an endless loop. It is unreachable in production, where every Prisma client and
transaction client exposes `$executeRaw`. It is recorded here because it is the one path
on which a wiring fault would be logged rather than surfaced.

The member-standing fan-out adds a subject fence before even its first candidate
read or empty-fan-out return. `enqueueHostingCoverageReevaluationForMember` locks
the member whose standing changed `FOR UPDATE NOWAIT`; `FOR NO KEY UPDATE` is
deliberately insufficient because a `BookingGuest.memberId` FK check takes
`KEY SHARE`. A contended or missing subject therefore raises the same fixed retry
and rolls the complete outer standing mutation back. Centralising the fence in
the shared fan-out covers deactivation, archive, cancellation, consent,
subscription and account-deletion writers rather than relying on one route to
remember it.

**That subject barrier is deliberately NOT gated on the hosting mode, and it is the
one exception to the paragraph above** (#2623 T5). The participant fence inside the
same function already is gated — the per-lodge `ENFORCED` filter returns before any
proof is acquired — but the barrier sits above it and runs for every club, because
it is the shared standing-subject fence rather than a hosting-coverage one: it is
what makes a concurrent booking-request linked-member hold and a deactivation
mutually exclusive, which is the identity-safety contract stated below ("independent
of the lodge's hosting consequence"). A club-wide `ENFORCED` gate was written above
it while implementing #2623 T5 and real PostgreSQL refuted it — the mode-parameterised
hold/deletion interleavings in `adult-member-hosting-queue-merge.realdb.test.ts`
failed for `DISABLED` and `ADMIN_REVIEW_REQUIRED`, because a deletion could then
deactivate the member and unlink the guest underneath a hold that had already read
them as active. `adult-member-hosting-call-sites.test.ts` now asserts the ABSENCE of
a mode read above that barrier, with the reason, so it is not "finished" later.

The acquisition is deliberately per seam, not a transaction-wide pre-plan. A bulk
transaction can call a fan-out more than once, so compatible Member key-share locks
alone would still let two transactions hold different coverage-owner keys and wait
on one another's later key. Each ordinary seam therefore also tries its sorted
coverage-owner keys with `pg_try_advisory_xact_lock` before re-entering the blocking
helper. A later conflict fails immediately and rolls back the earlier work too. This
keeps the existing #2600 order: global → sorted lodge keys → sorted roster dates →
applicable member keys → participant Member rows → coverage-owner. It does not add a
late member-lifecycle key or source-Booking row lock, either of which would invert a
counterpart writer.

The lodge-only booking-request hold takes the other side of that row protocol. After
its canonical lodge key it re-reads the transaction-current request link snapshot,
locks the exact sorted and de-duplicated linked `Member` ids `FOR KEY SHARE`, and
then re-reads those rows through Prisma while the locks are held. Every linked row
must still exist, be active and be unarchived. The request's optimistic `version` is
part of the later claim, so a link edit between the read and claim rolls the hold
back instead of creating guests from a stale snapshot. Hold-first makes a concurrent
standing fan-out's `NOWAIT` fail safely; after retry the newly committed guest is in
the candidate set. Standing-first makes the hold wait at `KEY SHARE`, then observe
the committed inactive/archive state and return the same safe 409 before any owner,
booking or guest is created. That refusal is independent of the lodge's hosting
consequence (`DISABLED`, `ADMIN_REVIEW_REQUIRED`, or `ENFORCED`), so review policy is
not an identity-safety backstop. Account deletion inherits this shared protocol
after its existing global → affected-lodge → member-lifecycle prefix. No late
lifecycle or source-Booking lock is added; the hold order is lodge → sorted linked
Member rows, and the standing order is its existing prefix → subject Member → queue
participants → coverage-owner.

Member merge owns the blocking counterpart. After its bounded relation moves it
plans the survivor's attendance plus the captured loser-owned bookings, then takes
one sorted `Member FOR UPDATE` statement over master, loser and every ancillary
queue owner. It re-plans under those rows; a new guest, booking, owner or lodge that
changes the participant fingerprint returns the merge's existing safe 409 rather
than acquiring another row late.

**That statement waits, but only for `MEMBER_MERGE_PARTICIPANT_LOCK_TIMEOUT_MS`
(10s)** (#2623 T6). It stays BLOCKING rather than `NOWAIT` because merge is
irreversible admin work and a short overlap with an ordinary writer should still
succeed. What was wrong was the wait being unbounded *while holding*: the merge
transaction still holds the adult-member hosting policy-set advisory key here, and
its own `FOR UPDATE` on up to `HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT` (50)
THIRD-PARTY owners blocks every FK write naming them — so an uninvolved
booking-create or guest-add waited behind the tail of a merge, for as long as the
merge transaction's own `timeout: 120_000` allowed. The bound is applied with
`set_config('lock_timeout', …, true)` immediately before the statement and restored
with `SET LOCAL lock_timeout TO DEFAULT` immediately after a successful acquisition,
so the rest of the merge
transaction's locks — sorted coverage-owner keys, the loser delete — keep their own
unmapped failure semantics. **`DEFAULT`, not a hardcoded `0`**: `0` means "wait
forever" rather than "whatever it was", so on a deployment that sets `lock_timeout`
at the database or role level, restoring `0` would delete the operator's bound for
the rest of the merge. `SET LOCAL` rather than `RESET` because `RESET` is
session-scoped and survives the commit on a pooled connection, silently clearing a
session-level setting the caller had made. Nothing in this repository sets
`lock_timeout` at any level today, so `DEFAULT` resolves to `0` and the behaviour is
unchanged; it is hardening against a deployment that adds one. PostgreSQL raises a `lock_timeout` cancellation as
SQLSTATE `55P03`, the same code `NOWAIT` raises, so it lands on
`HostingCoverageParticipantRetryError` and merge converts it into its existing
"participants changed, nothing was saved, re-run the preview" 409. There is no
restore on the failure path because the cancelled statement leaves the transaction
aborted. Both halves — that it stops, and that it still waits — are proven against
real PostgreSQL in `adult-member-hosting-queue-merge.realdb.test.ts`. Only then does it take the sorted coverage-owner
keys, sweep both live queue pointers (`memberId` and the FK-less `actorMemberId`),
fold those late counts into the existing relation totals, enqueue actorless
merge-generated `SYSTEM_CHANGE` work under the private exact proof, and delete the
loser. `MEMBER_MERGED` remains the Full Admin attribution. If ordinary enqueue wins,
merge waits at `FOR UPDATE` and the late sweep carries the committed row forward; if
merge wins, the ordinary `NOWAIT` fails before writing. No obligation is cascaded
away and an `OFFICER_OVERRIDE` cause/reason is never replaced by merge's generic
fan-out.

Concurrency inside the drain is handled by expiring, opaque-token claims rather than
long-lived locks. Items are claimed **just in time, one at a time**, not leased as a
serial batch: a later row therefore gets its full lease when its work actually starts.
The drain excludes every id it has already attempted, so releasing one transient
failure cannot let the same invocation immediately reclaim it and burn the remaining
attempt budget. A queue item is claimed by an `updateMany` guarded on
`processedAt: null`, the `attempts` value just read, and either no current token or an
expired token. The claim atomically writes a fresh random token and 15-minute expiry
while incrementing `attempts`. Completion and failure both match that exact token;
once an expired claim has been reclaimed, its stale worker can neither mark the item
processed nor clear the replacement claim or overwrite its `lastError`. A crashed
worker therefore burns one attempt, but cannot burn another or be retried until its
lease expires. A worker that loses either completion or failure fencing reports a
lost claim rather than a processed item.

Owner notification uses a separate 15-minute delivery lease with the same exact
claimant rule: claim writes an opaque token, and completion/release must match that
token as well as the incident and state key. Immediately before transport, a guarded
update renews the lease timestamp only if the incident is unresolved and unnotified
and the incident/state/token are still exact. Fresh, exact-boundary and
expired-but-unreclaimed owners therefore continue; if a successor races the old
token, both serialize on the incident row and only one guarded update wins. One final
exact read at the renewed timestamp then freezes the booking recipient plus the
uncovered nights from the incident's evidence. A stale/resolved/reclaimed claim
sends nothing, and the delivery never re-reads
`Booking.adultMemberHostingReview`, which may already describe a later state. A
successful transport stamps `notifiedStateKey`. Missing recipients and
intentional suppression are terminal while the officer incident stays open; an
unreadable booking `noEmails` flag is transient, releases the exact notification
lease, and fails the exact queue claim for a later outbox retry. The email provider
call stays outside every database transaction. That leaves one unavoidable interval
after the final token read in which state can move before the provider call; closing
it would hold a transaction across email delivery. There is a second unavoidable
at-least-once ambiguity after transport: if the provider accepts the message and the
process dies before `notifiedStateKey` is stamped, the expired lease is retried and
can send a duplicate. The provider exposes no idempotency key, while stamping before
transport would make the same crash lose the notice permanently. The contract is one
active exact claimant per renewed lease and one durable success stamp per
transition, not exactly-once provider delivery. The
one-active-incident-per-booking rule uses the partial unique index
`HostingCoverageIncident_active_booking_unique` (a concurrent second opener loses
on the index and folds into the winner). No new key is added to the lock-ordering
table.

#### Which client reads the subscription-lockout mode (#2543)

The same rule, reached differently. `peekSubscriptionLockoutMode()` takes no `db`
and reads two uncached settings rows (`loadEffectiveModuleFlags` and
`loadMembershipLockoutSettings`) through the module client, so it cannot be handed
a `tx` — which means an in-transaction caller must not call it at all. Instead the
mode is **resolved once per request, outside the transaction, and passed down as a
value**:

- `resolveGuestRateMembershipTypes` and
  `priceBookingGuestsWithMembershipTypePolicy` take
  `subscriptionLockoutMode`, and it is threaded from every booking write path
  through `createDraftBooking` / `createConfirmedBooking` /
  `createWaitlistedBooking` (shared `BaseInput`), `prepareGuestPlan`,
  `calculateModifiedPricing`, `removeBookingGuestInTransaction`, the guest-add
  route, `modify-quote`, the quote route and the waitlist sweep.
- The pricing gate is reached from inside `booking-create.ts`,
  `booking-modify-plan.ts`, `booking-date-modification-service.ts`,
  `booking-guest-removal-service.ts`, `waitlist.ts`, `waitlist-cross-lodge.ts`,
  `booking-request-shared.ts`, `group-booking.ts` and the guest-add route — every
  one of them holding a per-lodge capacity lock and often `lock(1)` as well. An
  independent settings read there is exactly the second-pool-connection shape the
  hosting rule above forbids, and it applied to EVERY club in EVERY mode, because
  the read happens before the mode is known.
- `peekSubscriptionLockoutMode()` remains the fallback for a caller that genuinely
  holds no mode. It exists at all (rather than `resolveSubscriptionLockoutMode`)
  because the latter refreshes the financial-year cache, which can reach Xero —
  a provider call the booking rules forbid outright inside a transaction.

The mode is also passed for a second, non-pool reason: two independent reads in
one request can disagree if an admin saves the panel between them, which on
`modify-quote` (seven or more pricing passes, two of them differenced into the
member's settlement delta) is a money error rather than a nuisance. See the
`INV-LOCKOUT` rules in `docs/invariants/subscription-lockout-pricing.md`.

#### Which client reads the club's timezone (#2870)

The same rule again, and the one place it decides whether a member keeps a bed.
A payment link expires at the end of the check-in day in the club's **persisted**
timezone (`INV-CONFIG-002`), and four decisions read that one boundary: the mint
in `payment-link.ts` / `booking-request.ts` / `group-booking.ts`, the refusal to
mint a link that would be born expired, and the two capacity-releasing
`PENDING -> CANCELLED` terminal cancels in `cron-confirm-pending.ts`. Three of
those sites are inside a `prisma.$transaction` already holding
`acquireLodgeCapacityLock`, one of them under `lock(1)` as well.

Resolving the zone is a `clubTimeSettings.findUnique`. So the zone is **resolved
once, outside the transaction, and passed as a value** to
`paymentLinkExpiryForCheckIn(checkIn, zone)`, which is pure and takes no client —
`mintSplitGuestPaymentLinkIfAbsent` and `resolveHoldWindowUnderLock` both take
the zone as a parameter rather than reading it. The reader is
`readClubTimeZoneOutsideRequest()` from `club-time-zone-runtime`, not
`clubTime()`, because all four files are reachable from
`src/instrumentation.node.ts`; `docs/CLUB_TIME_KERNEL.md` -> "Where the zone
comes from" is the rule and the measurement.

`confirmPendingBookings` reads it **once per run** rather than once per booking,
for the second, non-pool reason as well: two bookings resolved in one tick must
be judged against the same club day, or a zone change mid-run would cancel one
booking's hold and extend another's on different boundaries.

**What enforces it, and why it is a source contract.** `paymentLinkExpiryForCheckIn`
imports no reader at all, so it cannot resolve the zone under a lock however it is
called — the refuse-when-handed-a-transaction-client shape used by
`buildSubscriptionBillingPreview` has nothing to key on here, because there is no
client to key on. What is left to protect is a property of the four **callers**:
each one's own `await` must sit outside its own transaction. Two guards hold it.

- `payment-link-expiry-club-zone.test.ts` -> `reads the club's zone outside every
  transaction, in all four writers` reads the four files off disk, paren-matches
  every `$transaction(...)` argument list, and fails on a
  `readClubTimeZoneOutsideRequest(` found inside one. It covers all four writers
  at once, including `approveBookingRequest` and `verifyAndCreateNonMemberJoin`,
  which no runtime test reaches — measured: a read added straight after
  `acquireLodgeCapacityLock` in both of those files left every suite covering them
  green. A companion case fails if the scanner stops matching anything, so it
  cannot go quietly vacuous.
- `cron-confirm-pending.test.ts` counts the zone reads that happen **while a
  `$transaction` callback is running**, and requires zero. A per-run call count
  cannot stand in for that: a read that moved inside the transaction but still ran
  once per run keeps the count at 1 and passes.

If you add a fifth writer on this boundary, the first guard already covers it the
moment its file joins that census's list; add the file, do not add a bespoke test.

#### Which client reads the cancellation and non-member-hold policy (#3110)

`getNonMemberHoldPolicy`, `getNonMemberHoldDays` and `loadCancellationPolicy`
(`cancellation.ts`) each take an optional trailing `db` that defaults to the
module-level Prisma client, under the same one-line rule the three sections
above state: **a caller already inside `prisma.$transaction` MUST pass its own `tx`.**
The three share a private helper, `getBookingPeriodForDate`, which holds two of
the reads, so the parameter is threaded through it as well.

**Nine call sites are in that position**, every one of them holding
`pg_advisory_xact_lock(1)` **and** the per-lodge capacity lock. Six pass `tx`
directly: the guest-add route, `modifyBookingDates` (two reads),
`adminShiftBookingDates`, `booking-cancel.ts`'s paid-cancel path, and the
waitlist confirm. Three are reached indirectly, through helpers that hold no
transaction opener of their own:

- `applyLifecycleTransitions` already takes `tx` as its first parameter and
  passes it on;
- `calculateModificationSettlementOptions` and `calculateModificationChangeFee`
  take a **required** `db`. Required rather than defaulted, and deliberately:
  neither `booking-modify-settlement.ts` nor `booking-modify-plan.ts` imports a
  module-level Prisma client at all, so a `db = prisma` default would place a
  silent fall-back to a second pooled connection inside a transaction-scoped
  helper — the exact failure the parameter removes, in the hardest place to see
  it. It also turns the caller census into a typecheck rather than a grep.

Hoisting these reads above their transactions was considered and rejected at
every site. All nine feed the readers a `checkIn` and `lodgeId` taken from a
booking row re-read by `tx.booking.findUnique` **after** both locks, and two of
them read against `newCheckIn` — a value the transaction is itself computing. A
hoisted read would resolve the policy against a check-in the transaction is in
the middle of changing, which reintroduces the snapshot divergence passing `tx`
exists to remove.

**Eleven other call sites are deliberately outside a transaction and keep the
default:** the quote route, booking create, the exception-approval path, the
booking-request approval, the group-join and cross-lodge waitlist offers, the
pending-confirm cron, the advisory `modify-quote` route (which now passes the
module client explicitly, because its helper requires the choice), the
cancel-preview route, the booking detail page and `group-cancel.ts`. Those are
pre-write or read-only checks with no lock held, so the module client is correct
and cheapest there.

This is a **pool** argument, not a lock-order one: no cancellation-policy or
booking-period writer takes a per-lodge capacity lock, and no booking path takes
a policy-set key, so the two keyspaces are disjoint and cannot deadlock in
either order.

`cancellation-policy-client-contract.test.ts` pins both halves off the real
source, with **no allowlist of sites**, so a tenth in-transaction call site is
caught the day it is written rather than by the next audit. It reads the
transaction spans lexically — including `withOptionalTransaction`, which a scan
built only from `prisma.$transaction(` misses — and separately requires any
reader call inside a function that *receives* a client to pass that client on,
which is the only way to reach the three indirect sites.

### Composition: application-approval mapping (E10, #1936)

The membership-application approval transaction is the one writer that composes
the application and member-lifecycle families. Its fixed acquisition order is:

1. `member-application:<applicationId>` (the existing approval lock), THEN
2. every mapped target's `member-lifecycle:<memberId>`, in **sorted key order**.

Counterpart analysis — no cycles are possible:

- Other `member-lifecycle` holders either take one key or use sorted multi-key
  acquisition. Member archive/delete approval (`member-lifecycle-actions.ts`)
  locks exactly one member and takes no application lock; the admin family-group request
  review transactions (`admin-family-group-requests-service.ts`) lock exactly
  the one pre-existing member being linked into (or removed from) a group
  before writing `FamilyGroupMember` — required because a `FamilyGroupMember`
  insert does not bump `Member.updatedAt`, so only the lock (not the mapping
  preview token) can serialise it against the mapping approval's
  in-any-family-group collision guard. (The group-create *reject* transaction
  takes no member lock: it links nobody into a group.) Member merge locks master
  plus loser, and the hosting drain locks the claimed owner plus non-null actor;
  both sort and de-duplicate before acquiring the first key.
- No `member-lifecycle` holder ever acquires a `member-application` lock, so
  the application → member-lifecycle direction is one-way.
- Within the member-lifecycle family the approval acquires multiple keys in
  sorted order, matching the same-family rule above.

The F20 clamp inserts any required Xero deallocation outbox row before releasing
the member-credit lock. Provider GET/delete/recreate calls run later, outside the
transaction; ambiguous provider state fails to durable retry/manual review.
Allocation and deallocation handlers detect another RUNNING operation for the
same Payment. Separate runners can claim both rows before either check, so this
contention uses a dedicated transient result: each loser returns to PENDING
(never FAILED), and a later scan runs them without overlap. A post-recreate
verification (or next-run top-of-loop guard) mismatch that is explained purely by
Xero eventual consistency relative to the durable checkpoints — a just-deleted
allocation still listed, or a just-created recreate not yet listed — reuses that
same transient PENDING requeue (bounded, so persistent non-convergence still
lands FAILED) instead of failing terminal; only a mismatch no eventual-consistency
projection explains stays terminal. Provider-verified
local slice/link reconciliation retakes the member ledger lock.
The deallocation worker's first member-locked transaction records one durable
snapshot of desired applied cents plus all precise slices. Clamp, inbound repair,
and allocation planning query the deallocation fence under that same lock.
A fresh PENDING row fences inbound/clamp writers so stale provider truth cannot
undo the committed local target. Allocation/deallocation workers may pass it to
preserve queue order only while it has no snapshot/checkpoint; a manually
requeued checkpointed PENDING row remains fenced, as do RUNNING and any
provider-ambiguous failure states. Manual retry only CAS-requeues to PENDING;
the outbox claim is the sole authority that may execute provider calls.

The `create-payment-intent` pay transaction (#2265) does all three tiers of
work — it flips a booking's status, it claims capacity, and it moves credit —
so it takes all three locks, in the house order: the global booking lock(1)
first, then the booking's per-lodge capacity lock, then (inside
`consumeStoredCreditElection`) the per-member credit-ledger lock. lock(1) is
what makes it mutually exclusive with cancel, capture and the settlement paths;
without it the status writes could resurrect a just-cancelled booking. Every
status, capacity and money decision consumes a post-lock re-read, never the
pre-transaction snapshot.

Both arms of that transaction take both booking-tier locks. The DRAFT arm
capacity-checks (DRAFT-scoped exemption: a DRAFT can never carry a persisted
override) and claims `DRAFT -> PAYMENT_PENDING` with a status-guarded
`updateMany`. The already-`PAYMENT_PENDING` arm — an admin-released
`AWAITING_REVIEW` booking — re-checks capacity too and honours a persisted
override (#1771), which that arm CAN carry: it may settle the booking at $0
below, and a settle without a capacity claim is exactly what the other settle
paths refuse to do. On a capacity refusal it 409s; nothing was charged, so
nothing is cancelled or refunded.

The election itself is taken with a guarded claim: `updateMany` matching the
booking id, `PAYMENT_PENDING`, and the exact amount that was read under the
ledger lock, in the same transaction as the ledger write. Two racing consumers
therefore cannot both apply the credit — the loser matches zero rows and
returns "nothing to do" rather than a phantom outcome its caller would act on
(a second confirmation email, a second Xero invoice, a second `MEMBER_PAID`
event). The $0 settlement's `PAID` write is status-guarded the same way and
throws on count 0, rolling the credit application back with it.

The Internet Banking switch consumes the election under the same three locks it
already held, after its capacity decision, so a refused switch leaves the
election intact. Every provider call (the Stripe intent, the confirmation
email, the Xero invoice queue, the superseded-intent drain) stays outside the
transaction.

The settlements CLEAR the election with the same guarded-claim discipline
(#2319). `clearStaleCreditElection` moves the column from the exact amount read
to NULL and reports whether the claim landed, so a settle running alongside a
consumer never clobbers it: either the consumer already applied the credit (the
claim matches nothing and the settle reports "nothing stale", which matters
because a phantom clear would tell the member their credit went unapplied when it
had just been applied) or the consumer has yet to run and is untouched. The three
clearing writers all hold lock(1), which both consumers also take, so the guard
is belt and braces rather than the primary defence — but the property no longer
depends on that lock still being there. The writers are
`markBookingPaymentSucceeded`'s `PAID` claim, the Internet Banking inbound
reconcile's `PAID` and late-capacity-failure `CANCELLED` flips, and the
repriced-to-$0 auto-pay in both modification services. Each clear's reporting —
the audit row and the operator alert — runs POST-commit, outside the transaction,
because it sends email; the public payment link's refusal for an election-bearing
booking is signalled out of its transaction by a private error for exactly the
same reason.

Never-captured cancellation and Internet-Banking hold expiry acquire global
booking lock(1) first and the per-member credit-ledger lock second. While
holding both, they query for any non-complete applied-credit deallocation
before their first write. If one exists they defer the whole transition; a
later retry computes the clearing amount from provider-converged slices. The
paid/captured cancel (refund) path does not take the credit-ledger lock or this
fence: it restores credit from the payment mirror (mirror-based and capped) and
never sizes clearing from slices. Legacy inbound rows missing
those slices are repaired under the member-credit lock only when a unique
positive funding lot proves provenance. Slice reduction/deletion is therefore
working state, while the operation checkpoint/history and inactive/active
object-link history preserve the durable audit trail.

### Composition: diagnostics budget reserve (AID-2, #2371)

`reserveDiagnosticsBudget` (`ai-diagnostics-usage.ts`) is the AI Diagnostics
spend gate, and it deliberately does NOT reuse the page-help AI assistant's soft
read-then-spend cap (`checkAiBudget`, which is documented there as able to
overshoot by cents under concurrency). A diagnostics session is a MULTI-TOOL
agentic loop making several paid provider roundtrips, so a burst of concurrent
sessions could overspend a soft cap. Instead each paid roundtrip takes a
**guarded claim**: inside one short transaction it acquires
`pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'), hashtext(<month>))`
as its first statement, reclaims expired reservations for that month, sums the
live reservations (`DiagnosticsBudgetReservation`) plus the settled spend
(`DiagnosticsUsageMonthly.settledCents`), and inserts a worst-case reservation
ONLY if `settled + reserved + reserveCents <= budget`. The advisory lock
serialises every reserve for the month, so each admitted reservation sees the
committed reservations of all prior ones and the invariant holds for every one —
`settled + reserved` can never exceed the budget. A lost claim (over budget)
inserts nothing and denies the paid call (no side effect), exactly like the
status-guarded `updateMany` claims elsewhere in this document.

The provider call runs entirely OUTSIDE this transaction (the lock releases on
commit). Afterwards `settleDiagnosticsRoundtrip` deletes the reservation and
books the actual cost into `settledCents` in a second short transaction that
takes the **same** per-month advisory lock as its first statement. This is
load-bearing: without it a settle's reservation-delete + `settledCents` increment
could commit BETWEEN a concurrent reserve's two READ COMMITTED reads (settled
spend vs. live reservations), so the just-settled roundtrip would be counted in
NEITHER term — its reservation already gone, its settled increment not yet in the
reserve's snapshot — under-counting committed spend and admitting an over-budget
reservation. Sharing the lock makes reserve and settle mutually exclusive per
month, so every reserve sees a consistent `settled + reserved` sum. Settle takes
only this one key (never a second lock), so it cannot form a lock-ordering cycle
with the reserve or anything else. The reservation's `expiresAt` is a
crash-safety backstop so a process that dies between reserve and settle cannot
pin worst-case budget for the rest of the month — the next reserve for that month
sweeps it. The multi-tool loop is bounded
by `DIAGNOSTICS_MAX_TOOL_ROUNDS`, so one session's worst-case is
rounds x worst-case-roundtrip and the monthly budget bounds the sum across
sessions. This is a single-domain lock keyed per month; it composes with no
other lock family (no booking, capacity, credit, or policy writer takes it, and
it takes none of theirs), so it cannot form a cycle. FAIL-CLOSED throughout: a
missing delegate, a lock/read/insert fault, or an unwritable meter denies the
paid call.

The mutual exclusion this rests on is proven against a real PostgreSQL by
`ai-diagnostics-budget-race.realdb.test.ts` (#2532), which runs from the same
opt-in harness as the rest of this document's race proofs. Its lead test FORCES
the overspend interleaving rather than racing for it: a third connection holds
the per-month key open, and both reservers are then observed queued on that
exact key in `pg_locks` while `pg_stat_activity` still shows them with no
transaction id — i.e. blocked before either wrote anything — before the holder
is released. So removing the lock, taking it after the budget reads, or taking
it after the guarded insert each fail deterministically instead of flaking. See
`docs/ai-diagnostics/README.md` ("Concurrency proof").

The first four are the **booking / capacity / credit cluster** — they interact,
and are where the ordering discipline matters. The remaining rows are
independent single-domain locks. Their namespaced keys do not intentionally
contend with the cluster or each other. The legacy Xero member-contact key is an
explicit exception: retain it only for its two current counterpart writers and
do not use unnamespaced `hashtext(<id>)` for new lock families.

### Narrow row- and table-lock protocols

**Lock raw, read typed (#2289).** Every **raw** row lock below takes its lock
with `$executeRaw` on a statement that selects a **constant** (`SELECT 1 … FOR
UPDATE`), and then reads whatever it needs through the ordinary Prisma model,
inside the same transaction and therefore under that same lock. (Not every row
lock in this document is raw — the member-photo cleanup writers acquire the
`Member` row lock through an ordinary `member.update`, as that protocol
describes. The rule below is about raw statements.) The lock is held for the rest
of the transaction, so the two statements are behaviour-identical to one
`SELECT the-columns … FOR UPDATE`, at the cost of one extra round trip in a
transaction that already makes several.

**With one exception that every raw lock on a MUTABLE key must handle.** The
equivalence holds only while the lock statement matches at least one row.
`FOR UPDATE` locks nothing when it matches nothing, and this repository runs at
READ COMMITTED deliberately (see `src/lib/member-merge.ts`), so the follow-up
model read takes a **fresh statement snapshot** and can return a row that was
inserted — or renamed onto that key — after the lock ran, with no lock held on
it. A single `SELECT * … FOR UPDATE` could not do that: an unlocked row could
never be in its result set. `$executeRaw` returns the affected-row count, so the
zero-match case is detectable for free; treat it as **not found**, which is
exactly what the single-statement form produced for that interleaving. This bites
only where the lock key can change under you: `booking-create-promo.ts` locks on
`PromoCode.code` and checks the count for this reason, while every other site
below keys on an immutable cuid (or materialises its singleton before locking)
and cannot see a row appear between the two statements.

The reason is not tidiness. `$queryRaw<SomeRow[]>` is an **unchecked cast**: raw
SQL returns the *physical* column names and the generic declares whatever the
author believed, so where the two disagree every property arrives `undefined` —
and `undefined` is quietly falsy in exactly the comparisons that guard money.
Booking creation used to read its locked promo that way, and in a deployment
whose columns differed it silently disabled the total-redemption cap
(`undefined !== null` is true, `n > undefined` is false) and zeroed the
FREE_NIGHTS discount (`?? 0`), so members were quoted a discount and charged
without it, for months, with nothing logged. Prisma owns the mapping, so a model
read cannot drift that way.

A statement that genuinely cannot be a model read — the rate limiter's atomic
`CASE … RETURNING` upsert is the only one in production code — validates its rows
with `decodeRawRows` from `src/lib/raw-sql-rows.ts` instead. Both halves are
enforced across non-test code in `src/`, `scripts/` and `prisma/`: ESLint rules
refuse a `$queryRaw<…>` generic or a `SELECT *` in a raw statement, written
either as a tagged template or as a `Prisma.sql` composition passed to the call;
and `src/lib/__tests__/raw-sql-shape-guard.test.ts` pins the whole raw-SQL
call-site inventory so a new one has to be classified. Tests are deliberately
exempt from both — `concurrency-lock-races.realdb.test.ts` reads raw counts on
purpose, and a test's wrong shape fails the test on the spot rather than
mispricing a booking.

- **Trusted legacy induction baseline** —
  `src/lib/induction-baseline.ts` (`runInductionBaseline`, #2361): apply takes
  `LOCK TABLE "MemberInduction" IN SHARE ROW EXCLUSIVE MODE` as the **first
  database statement** in its Serializable transaction. The mode conflicts
  with the `ROW EXCLUSIVE` lock PostgreSQL takes for every insert, update, or
  delete on `MemberInduction`, including cascade deletes, so the command first
  waits for existing direct induction DML and then makes later direct DML wait
  until apply commits. It re-reads the complete active `USER`/`ADMIN`
  real-member population and all of their induction rows only after that lock,
  rebuilds a versioned SHA-256 digest over every safe plan input, and compares
  it exactly with the reviewed dry-run digest before the blocker, no-op, or
  write branches. A concurrent writer that changes the plan therefore makes
  the waiting apply fail with a refreshed report rather than silently taking
  the blocker or no-op path. With a matching digest, apply refuses the entire
  run if any eligible member has a `DRAFT` or `IN_PROGRESS` row visible in that
  locked read, and performs its `createMany` plus digest-bearing audit write in
  the same transaction. Dry run never takes the lock and never writes.

  This is deliberately a table lock rather than a new advisory-lock family:
  PostgreSQL makes ordinary `MemberInduction` DML in
  `src/lib/induction.ts`, application approval, member lifecycle/merge cascade
  paths, and admin induction routes contend **when that DML reaches this
  table**. This does not serialize those workflows' earlier reads, member
  creation/import, other lifecycle writes, configuration changes, or any side
  effect outside this table. From the final dry run through the post-apply
  verification dry run, operators must therefore pause all of the following;
  the runbook makes this freeze mandatory:

  - individual and bulk member updates to `role`, `active`, date of birth, or
    `ageTier`;
  - membership-application approvals, admin and family-request member creation,
    group-booking join acceptance/token claims that can create an active
    `USER`, CSV/member imports, and Xero member imports;
  - membership-assignment saves and roll-forward jobs that can update
    `ageTier`;
  - changes to the chosen actor's `canLogin`, access-role assignments,
    active/archive/cancel state, account deletion, or merge;
  - archive, cancel, reactivate, delete, merge, and other member lifecycle
    operations;
  - induction create, signer assignment/reassignment, sign-off, admin
    completion/override, void, and delete operations; and
  - changes to club identity, age-tier settings, nomination settings, or
    induction-template content and activation.

  None of those actor, `Member`, group-booking join, or configuration writers
  is covered by the `MemberInduction` table lock merely because the baseline
  later reads its result. Their pause is an operational freeze, not a database
  lock.

  The baseline transaction takes no application advisory lock and mutates no
  `Member` or template row, so it cannot invert the global -> lodge -> member
  advisory order. Foreign-key checks can still wait on a concurrent member
  lifecycle transaction; if PostgreSQL detects a deadlock or the transaction
  times out, the whole apply rolls back and the operator starts again from a
  fresh dry run. Do not move validation reads before the table lock or weaken
  the lock mode: either change would reopen the locked
  classification/direct-DML race. Do not claim this table lock freezes the
  wider population or composes with writers before they touch
  `MemberInduction`.

- `booking-create-promo.ts` locks the selected `PromoCode` row with `FOR UPDATE`
  and then reads it through `tx.promoCode.findUnique` (lock raw, read typed —
  #2289) before validating and consuming its use count. It is the only site that
  locks on a **mutable** key (`PromoCode.code`), so it also checks the
  affected-row count `$executeRaw` returns: a lock that matched nothing is
  treated as "Promo code not found" rather than reading a row it does not hold —
  see the zero-match exception under "Lock raw, read typed" above. Booking
  creation has
  already taken the per-lodge capacity lock, so the current order is lodge ->
  promo row; no counterpart writer may take the promo row and then a lodge lock.
- **Every booking-modification path that may write `currentRedemptions`** takes
  the same protocol via `lockPromoCodeRowsForUpdate` / the reprice wrapper
  `lockAndRefreshPromoCodeUsage` (both `src/lib/promo.ts`), *before* its first
  cap read and its first `currentRedemptions` write. All four are covered:
  `booking-modify-plan.ts` (`applyPromoCodeChanges`, the batch-modification
  path — the only one that can touch **two** codes, so it uses the multi-id
  form), `/api/bookings/[id]/guests` (adding guests),
  `booking-date-modification-service.ts` (changing dates) and
  `booking-guest-removal-service.ts` (removing guests). Each of the four has
  already taken the per-lodge capacity lock, so the order is again
  lodge -> promo row. The reprice wrapper also **re-reads
  `currentRedemptions` under the lock**, because a reprice carries a
  `PromoCode` snapshot loaded with the booking before the locks were taken;
  locking and then deciding against a number read outside the lock would leave
  the race open. It has **four** call sites, not three: the batch-modification
  path calls it too, on the branch that re-prices a booking whose promo code is
  not changing (there the multi-id lock is already held, so the call is for the
  refreshed counter and its re-lock is a no-op; the swap branch instead re-reads
  the whole promo row under that same lock). Every caller must then validate
  against the object the wrapper **returns** — validating the snapshot that went
  in would serialise correctly and still decide on a stale number, so the source
  contract in `src/lib/__tests__/promo-reprice-cap-exclusion.test.ts` pins that
  threading at all four sites. A promo **swap** touches two promo rows in one
  transaction (the outgoing code's counter is refunded, the incoming code's is
  charged), so the helper sorts the ids and locks them one statement at a time:
  every caller therefore takes promo row locks in the same global order and two
  opposite swaps cannot build a cycle. The sort is done in the application
  rather than by `ORDER BY ... FOR UPDATE`, so the ordering does not depend on
  the query plan. The lock became load-bearing with #2299: a reprice can now
  *release* a usage slot as well as take one, so check-then-consume must be
  serialised. The helper selects a **constant** through `$executeRaw`
  (`SELECT 1 … FOR UPDATE`) and discards the result — it exists purely for its
  lock and never reads a value out of a raw row, which is the trap #2289
  documents. Because it keys on the immutable `PromoCode.id`, it needs no
  affected-row check: a missing id simply locks nothing and the caller's own
  lookup reports "Promo code not found".
  #2390 added one more read under the same lock and changed what the decision
  produces. The reprice paths pass `capOverflow: "coverExisting"`, which makes
  `validateAndCalculatePromoDiscount` read — still under the lock, and still
  before any write — which members already hold a **beneficial** allocation on
  the booking being repriced, and then divide the remaining allowance among the
  rest instead of refusing. No new lock, no new key, no change of order: the
  same row lock now protects a "who is covered" decision rather than a yes/no
  one. That read must stay ahead of the redemption write for the trigger reason
  documented in `docs/DOMAIN_INVARIANTS.md` — and ahead of the beneficiary list
  itself, because `maxGuestsPerBooking` is spent while that list is built and a
  protected member cut there would be invisible to every later check. The edit
  preview (`/api/bookings/[id]/modify-quote`) runs the same rule off `prisma`
  with no lock — it writes nothing, and a preview that disagreed with the save
  would be worse than one that is momentarily stale. Where they do disagree the
  edit panel shows the SAVE's sentence before it closes, so the member reads the
  outcome that was actually applied rather than the one that was previewed.
- `bed-allocation-bunk-pairing.ts` locks the owning `LodgeRoom` row with
  `FOR UPDATE` before checking and changing one room's bunk-group membership.
  This protocol is independent of the booking/capacity/credit lock cluster.
- **Club-theme logo writer** — `src/lib/club-theme.ts` (`saveClubTheme`, #2322):
  the site-style save transaction locks the `ClubTheme` singleton
  (`$executeRaw`SELECT 1 FROM "ClubTheme" WHERE "id" = 'default' FOR UPDATE``)
  and reads the currently-stored logo back through `tx.clubTheme.findUnique`
  under that lock (lock raw, read typed — #2289), so two concurrent saves
  serialise and can never both delete the same replaced `LOGO` blob (or orphan
  each other's new one). Because `FOR UPDATE` locks nothing when the row is
  absent, the transaction first materialises the singleton with a
  `createMany … skipDuplicates` so a **first-ever** save is serialised too.
  Singleton-keyed; no advisory lock; disjoint from the booking/capacity/credit
  and money lock clusters. The acquisition order is **`ClubTheme` row first,
  then `MediaImage`** — the lock is taken before the blob presence check, the
  row write, and the scoped `deleteMany`. The delete is scoped to
  `kind: "LOGO"`, so a `CONTENT` picker image referenced by page HTML can never
  be collected by a theme save. Under the same lock the incoming `logoUrl` is
  checked to still exist before it is written, which refuses a stale tab's save
  (409) rather than dangling the theme or deleting a blob that is still
  referenced.

  Counterpart writers, and why there is no cycle:
  - **Config-transfer apply** (`src/lib/config-transfer/apply.ts`) takes
    `pg_advisory_xact_lock(hashtext('config-transfer-import'))` and then writes the
    `ClubTheme` row inside its bundle transaction, so the order is advisory ->
    `ClubTheme` row. `saveClubTheme` takes no advisory lock at all, so the two
    orders cannot invert. `recreateBundleMedia` only ever **creates**
    `MediaImage` rows (and reads candidates for byte-identical reuse) — it locks
    no existing `MediaImage` row — so an import never holds a `MediaImage` lock
    while waiting for the theme row. Because an import can hold the theme row for
    the length of a whole bundle, `saveClubTheme` runs with an explicit
    `maxWait` 10s / `timeout` 15s and the site-style route maps an exhausted wait
    to a 503 retry-later rather than a 500.
  - **Image-library delete** (`src/app/api/admin/image-library/[id]/route.ts`) is
    a bare `MediaImage` delete with no surrounding row lock, and is itself scoped
    to `kind: "CONTENT"`, so it can never touch a `LOGO` blob this protocol owns
    — disjoint in both direction and row set.
  - **Member photo writer** (below) locks the `Member` row and touches only
    `MEMBER_PHOTO` blobs. The two protocols share the `MediaImage` table but
    never the same rows, and neither takes the other's parent row, so they are
    table-disjoint for locking purposes.

- **Member photo writer** — `src/app/api/members/[id]/photo/route.ts` (epic #171):
  the upload (POST) and remove (DELETE) transactions each take
  `$executeRaw`SELECT 1 FROM "Member" WHERE "id" = $1 FOR UPDATE`` and then read
  the existing `photoImageId` back through the Prisma model under that lock
  (lock raw, read typed — #2289) before creating/repointing the blob, so two
  concurrent replace/remove requests for the same member serialise on the
  member row and can never leave a `MEMBER_PHOTO` blob orphaned. Member-id keyed;
  no advisory lock; disjoint from the booking/capacity/credit and money lock
  clusters. The counterpart cleanup writer `deleteOwnedMemberPhotoBlobs` runs
  inside the member-merge and account-deletion transactions and touches the same
  `MEMBER_PHOTO` rows. A photo upload is **not** serialised by the
  member-lifecycle advisory lock, so a live upload for a member *can* be
  in-flight when a merge/account-deletion of that member begins — the member
  stays an uploadable subject (self or admin-on-behalf) until the lifecycle
  transaction commits. What makes that safe and **deadlock-free** is a single
  shared acquisition order that every writer honours: **lock the `Member` row
  first, then the `MediaImage` rows.** The upload takes `Member … FOR UPDATE`
  then `MediaImage` create/deleteMany; the cleanup writers take the `Member` row
  via `member.update` (lifecycle `xeroContactId` null at
  `member-lifecycle-actions.ts`; merge field-merge/`teardownLoserXero` in
  `member-merge.ts`) *before* calling `deleteOwnedMemberPhotoBlobs`. Because no
  writer ever takes a `MediaImage` lock before the owning `Member` row, the two
  cannot deadlock. Do not reorder a `deleteOwnedMemberPhotoBlobs` call ahead of
  its transaction's `Member`-row write. Both cleanup writers also read the
  leaving member's `photoImageId` **fresh under that already-held row lock** —
  the deletion path from its own `member.update … select photoImageId`, the
  merge from a `member.findUnique` after `teardownLoserXero`'s `member.update` —
  never from an earlier in-memory snapshot. That closes an under-deletion race:
  an admin-on-behalf upload landing after the snapshot but before the lock is
  held repoints the member to a NEW blob carrying the *admin's*
  `uploadedByMemberId`; keying the sweep off the stale snapshot would match
  neither that blob's id nor its uploader and orphan it once the member is
  hard-deleted. The fresh locked read supplies the member's current pointer so
  the blob is swept.

  The merge's fresh read is a **whole-row** read of both members, not just
  `photoImageId`, because the same staleness sinks its field-merge WRITE (#2243).
  `Member.photoImageId` is a real FK, so a patch derived from the transaction's
  opening snapshot writes the blob id the racing upload just deleted, and
  Postgres 23503 / Prisma P2003 rolls the ENTIRE merge back as a bare 500 — with
  the preview token none the wiser, because it verifies against that same stale
  snapshot. Both the write patch and the sweep pointer now come from that one
  fresh read. `familyGroupId` is the patch's other real FK and the same story:
  a club admin can delete the `FamilyGroup` (`DELETE
  /api/admin/family-groups/[id]`, behind `requireAdmin`) without taking any
  member-lifecycle lock.

  **The merge REFUSES mid-transaction drift rather than applying it.** The patch
  is derived twice — once from the transaction-opening snapshot (the derivation
  the preview token is verified against) and once from the fresh read — and if
  the two disagree on any field the merge throws a 409
  (`merge_drift_in_transaction`) naming those fields, before anything is written.
  Nothing is saved and the operator re-runs the preview. That keeps the promise
  the rest of the repo's preview/confirm flows make (config transfer's ADR-002:
  *what was previewed is exactly what is applied*) and matches this merge's own
  pre-transaction token check, which already 409s on drift. The original bug
  stays fixed either way: the stale FK value is detected from the fresh read and
  never handed to Postgres, so the failure mode is a plain 409, not a bare 500.

  **The same refusal covers the family links (#2437).** The five Member
  self-relation columns (`parentMemberId`, `secondaryParentId`,
  `inheritEmailFromId`, `inheritEmailChoiceId` — added by #2716, and moved by
  the same generic mechanism as its sibling — and
  `detailsConfirmedByMemberId`) are written by admin
  paths outside the `member-lifecycle` lock (`admin-members-service.ts`, the
  dependents link route). #2445's exclusion of the master's own row from the
  self-relation moves stopped a mid-merge link write corrupting the graph (the
  master as its own parent), but left the SILENT-LOSS arm: a link pointing at
  the loser that lands after the opening snapshot survives the moves
  un-repointed and is quietly nulled by the loser's hard-delete
  (`onDelete: SetNull`) — no error, no audit. Three mechanisms compose to
  close every interleaving. **Step 1 is value-conditional**: the master's
  pointer at the loser is nulled with a `WHERE column = loserId` predicate
  (re-evaluated after blocking under READ COMMITTED), so a pointer that moved
  since the opening snapshot refuses at step 1 instead of being overwritten —
  and a successful null holds the master's row lock to commit, which is what
  makes the step-5 expectation for that column enforceable rather than a
  check of step 1's own write. **The step-3 self-relation sweeps are
  id-bounded** to the rows captured by the in-transaction token re-derivation
  (counts and captured ids come from the same read), so a link that lands
  after the capture is never absorbed onto the master unvetted — it stays
  pointing at the loser. **The step-5 under-lock re-read** then checks all
  three arms: any change to the four columns on either member row beyond the
  merge's own step-1 nulling and step-3 re-pointing
  (`diffSelfRelationLinkState`), and any OTHER row still referencing the
  loser after the moves, 409s with the same `merge_drift_in_transaction`
  refusal naming the changed links in club-admin vocabulary (owner decision
  on #2437, 1 Aug 2026: detect and refuse — deliberately NOT a new
  advisory-lock participant for the link writers, and NOT a DB CHECK
  constraint). Interleavings after the re-check cannot reopen the hole: both
  member rows are FOR UPDATE-locked, and an inbound FK write referencing the
  loser from another row blocks on its KEY SHARE lock against that FOR UPDATE
  and then fails loudly on the FK once the hard-delete commits. The 409 rolls
  the transaction back whole, so the in-transaction `MEMBER_MERGED` audit never
  lands — but the refused attempt is **not** silent: since #2498 a single
  boundary in `executeMemberMerge` writes one best-effort `MEMBER_MERGE_REFUSED`
  audit on the base client, OUTSIDE the rolled-back transaction, for this arm and
  every other merge refusal (`merge_blocked`, `preview_drift`,
  `partner_share_lodge_drift`, the field-drift arm, self-merge, missing member,
  confirmation mismatch). It records the actor,
  both member ids, the refusal code/status, and a non-PII structural summary of
  what drifted or blocked; the write is best-effort so it can never turn a clean
  409 into a 500, and one refusal yields at most one row (owner decision on
  #2498, 2 Aug 2026, taking the convention #2437 deliberately left open).

  **One new row lock, no new lock family.** Immediately before that fresh read
  the merge takes `SELECT 1 FROM "Member" WHERE "id" IN (…) ORDER BY "id" FOR
  UPDATE` over the master and the loser. The loser was already row-locked by
  `teardownLoserXero`'s unconditional `member.update`; the master was not, and
  that open window could strand an orphaned `MEMBER_PHOTO` blob (a concurrent
  on-behalf upload for the MASTER commits blob M2, the merge overwrites the
  pointer with the loser's absorbed value, and the loser-only sweep never touches
  M2) as well as producing avoidable drift 409s. Both ids are locked in **one
  id-ordered statement**, the same ordering rule as the two advisory locks at the
  top of the transaction, so it cannot deadlock against the mirror merge. Order
  against `MediaImage` is unchanged: this is a `Member` lock, still taken before
  any `MediaImage` write.

  What that row lock does **not** close: it protects the two `Member` rows, not
  the rows their foreign keys point AT. A concurrent `FamilyGroup` delete can
  still abort the merge — now by deadlocking against this lock (Postgres 40P01)
  rather than by writing a stale value (23503). Closing that would need the
  family-group writers to join the member-lifecycle lock family and is out of
  scope. Locking the master earlier (before the guards and the self-relation
  pass) rather than only before the field write was considered on #2437 and
  deliberately **not** taken — the master stays unlocked until step 5, and the
  family-link drift re-check above is what closes that window.

- **Deletion-request approval release** — `src/lib/deletion-request-decision.ts`
  (`releaseDeletionRequestApprovalClaim`, #2627): takes
  `$executeRaw`SELECT 1 FROM "DeletionRequest" WHERE "id" = $1 FOR UPDATE`` as the
  first statement of its transaction, reads the claim's holder and note back
  through the Prisma model under that lock (lock raw, read typed — #2289), and
  only then performs the guarded `APPROVAL_IN_PROGRESS -> PENDING` transition; the
  route writes the `member.deletion_approval_claim_released` audit row with the
  awaited `createAuditLog` on the same transaction client, so the record and the
  transition commit or roll back together. The lock exists for the ATTRIBUTION,
  not for the transition — the transition is safe on its guard alone, but the
  holder it nulls has to be read at the same serialised point or an ABA
  interleaving records an admin whose claim was never displaced. Request-id keyed
  on an immutable cuid, so the zero-match exception above cannot bite (a zero
  count means the request itself is gone, which is emphatically not a held claim);
  no advisory lock; disjoint from the booking/capacity/credit and money clusters.
  Counterpart, and why there is no cycle: the approval finalisation takes the
  future-partner-shared-allocation and member-lifecycle advisory locks, then this
  row (through its own guarded `updateMany`), then the `Member` row. The release
  takes this row and inserts an `AuditLog`, which carries no FK to `Member` and so
  takes no `Member` lock at all — one lock each way, no inversion. Because the
  finalisation legitimately holds this row from its claim to its commit, the
  release runs with explicit `maxWait` 10s / `timeout` 15s — deliberately longer
  than the finalisation's own default 5s budget, so a release loses to it on the
  guard rather than on the clock — and the route maps P2028/P2034 to a 503
  retry-later (`DELETION_REQUEST_RELEASE_CONTENDED`) rather than a bare 500, the
  same shape as the club-theme logo writer above. Before the release existed as a
  transaction it was an auto-commit `updateMany` that blocked and then returned
  the mapped 409, so the 503 keeps a contended release actionable instead of
  regressing it to an opaque failure. Both winner orders, the release/audit
  atomicity, and the rejection guard's own lock wait are forced against real
  PostgreSQL in `adult-member-hosting-queue-merge.realdb.test.ts`.

Do not add or compose a row lock without updating this inventory and documenting
its order against every advisory- and row-lock counterpart. **Every lock strength
counts** (#2623 T9(d)): `advisory-lock-guard.test.ts` used to census the literal
`FOR UPDATE` only, so the six non-test `FOR KEY SHARE` statements this repository
ships — the hosting queue participant fence, the booking-request linked-member hold,
the coverage drain's claimed-identity lock, the incident actor lock and the two Xero
contact reservations — appeared in no counted inventory at all, and were exempt from
the "lock raw, read typed" rule for the same reason until that rule was widened.
Nothing escaped: all six select a constant through `$executeRaw`. A seventh written
as `$queryRaw` projecting columns would have passed every gate. The census now
matches `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE` and `FOR KEY SHARE`, and
ignores double-quoted string literals so prose inside an error message is not
counted as a statement.

### Member merge — dual member-lifecycle lock (E11 #1937)

`executeMemberMerge` (`member-merge.ts`) first takes the adult-member hosting
policy-set key, then the merge-only partner-share **lodge** prefix (#2595 — every
affected lodge capacity key in sorted order, and deliberately no global cohort
key), then holds **two**
`member-lifecycle:<memberId>` advisory locks at once — one for the master, one
for the loser — and finally the two `member-partner-link:<memberId>` keys. All
are acquired at the top of the single merge transaction, before any read that
decides a write, and the two member keys in **sorted id order**
(`[masterId, loserId].sort()`, smaller id first) so a
merge and its mirror (a merge started from the other direction, or a concurrent
archive/delete of either member) can never deadlock. Because the keys share the
`member-lifecycle:` namespace with `member-lifecycle-actions.ts`, a merge also
mutually excludes any archive or delete of either the master or the loser.

The `member-partner-link:` tier is the last one merge takes, and it is there for
two reasons that are one reason: merge **writes** partner links (step 2 re-points
the duplicate's links onto the master, dropping the ones that would give the
master two confirmed partners) and, since #2595, **reads** them to decide which
future shared doubles step 3b deletes. The CONFIRMED partial unique indexes are
per side (`memberAId`, `memberBId`), so the database alone cannot enforce "at
most one confirmed partner" — only this key can. Merge takes it in the same
relative position as the reviewed move (`bed-allocation-move.ts`:
member-lifecycle **then** member-partner-link), so it adds a second holder of an
existing edge rather than a new edge; and the partner-link service takes this key
and no other tier, so no holder of it can be waiting on anything merge holds.
The policy key is held through all relation moves, hosting re-evaluation writes,
and loser deletion. A concurrent policy reconciliation therefore either inserts a
complete pre-merge loser-owned queue row before merge starts (which the relation
sweep moves to the master), or waits and reads the surviving booking owner after
merge commits. It cannot insert a loser-owned row after the sweep for deletion to
cascade away, nor race the deleted FK into a policy-save failure.

The hosting drain is the other multi-key participant: it may hold the claimed
owner and actor keys, also sorted and de-duplicated, to exclude merge before
relation moves begin for an already-existing queue row. It takes the hosting
policy-set first; no other member-lifecycle participant takes that policy key, so
this edge is one-way. Policy CRUD and configuration transfer share the policy-set
key for their complete enumerate-and-enqueue transaction: policy first creates a
complete loser-attributed row that merge moves, while merge first makes the policy
writer wait and enumerate the survivor after commit. Configuration transfer keeps
its wider fixed prefix — config-import → minimum-stay policy-set → hosting
policy-set — and no provider call moves inside either transaction.

Ordinary booking/member producers do not take the policy-set key. Their #2597
handshake takes the standing subject `Member FOR UPDATE NOWAIT` before its first
fan-out read, then one exact, sorted `Member FOR KEY SHARE NOWAIT` statement per
high-level enqueue seam containing every planned source owner plus the non-null
actor. The booking-request hold takes the matching lodge → exact sorted linked
`Member FOR KEY SHARE` path and re-reads active/archive state before its versioned
claim. Merge takes the blocking counterpart only after its relation moves: one
sorted `Member FOR UPDATE` statement over master, loser and every ancillary owner
in the bounded survivor-attendance/captured-booking plan. It then re-plans under
those rows, takes sorted coverage-owner keys, runs the late owner and actor queue
sweeps, emits actorless merge work under the exact participant proof, and deletes
the loser. A plan mismatch returns 409; it never acquires a participant late.

That gives both commit orders a safe result. An ordinary producer that already
holds key share finishes its attributed queue write before merge's `FOR UPDATE`
can proceed, so the late sweep moves it. A merge that owns `FOR UPDATE` makes the
ordinary `NOWAIT` fail before any queue write, rolling back the complete caller
transaction. Repeated bulk calls also try coverage-owner keys without waiting; a
later conflict rolls back earlier calls instead of forming a hold-and-wait cycle.
The composed merge order is **hosting policy-set → every affected lodge key in
sorted order, and no global cohort key (#2595) → sorted member-lifecycle →
sorted member-partner-link (#2595) →
relation moves → one sorted master/loser/ancillary Member FOR UPDATE → under-lock
re-plan → sorted coverage-owner → unresolved Xero contact-create proof re-check →
late owner+actor sweeps → unbacked shared-double reconciliation (#2595) →
actorless enqueue → loser delete**. #2595 adds two tiers: the lodge prefix at the
TOP, before the member-lifecycle pair (see "Merge joins the bed-allocation
cohort" below for why it cannot sit at its point of use), and the partner-link
pair immediately after it, matching the reviewed move's order.

`XeroSyncOperation.localId` is deliberately FK-less, so each provider contact
CREATE first commits one exact `RUNNING` reservation in a short transaction that
holds the target Member row `FOR KEY SHARE`. Only after that transaction commits
does the Xero provider call begin. Preview and execution block on that active
reservation; execution repeats the query after the complete Member/coverage-owner
lock set. If merge already owns `FOR UPDATE`, the reservation waits, then finds
the deleted member and never reaches Xero. If reservation wins, merge sees it and
rolls back. This closes the post-check provider race without putting Xero inside a
transaction or adding an advisory-lock tier.

Member-scoped contact UPDATE uses the same row protocol. Before authentication
or provider work, a short transaction takes the exact target `Member FOR KEY
SHARE`, re-reads the deleted marker, current `xeroContactId`, and complete
contact payload, then builds and commits the `RUNNING` UPDATE operation from
that locked snapshot. The request sent after commit is that same authoritative
snapshot, never the caller's earlier closure. After Xero returns, a second short
transaction takes that Member `FOR UPDATE`, re-checks the same contact id, and
changes the operation to `SUCCEEDED` together with the canonical CONTACT ledger
upsert. Merge and account deletion re-check every RUNNING member CONTACT UPDATE
while holding their participant Member rows. Update-first therefore keeps the
member alive until operation/link completion; lifecycle-first makes the waiting
reservation observe a missing, anonymised or relinked member and call no
provider. If merge first fills a surviving master's phone, address, or email,
the waiting UPDATE sends those post-merge values. A Member UPDATE retry follows
the same locked rebuild and must never fall back to the stored request payload,
which can contain stale PII.

Inbound webhook reconciliation, admin bulk contact sync/import, historical
canonical-contact backfill, managed contact-group completion, and name-order
repair share the same Member-row family. Every local PII fill,
`Member.xeroContactId` write, and reconstructed/refreshed FK-less CONTACT link
takes the exact Member `FOR UPDATE`, re-reads the deleted marker and current
contact id (plus still-blank fields for PII), then commits the
pointer/link/ledger work in one short transaction. Name repair uses the outbound
UPDATE reservation above and is sent only after its reservation commits.
Provider reads and writes remain outside those transactions.
Inbound/backfill-first therefore commits before merge/deletion can
continue, after which lifecycle teardown removes the loser's/deleted member's
FK-less contact link and privacy fields; lifecycle-first makes the waiting
inbound writer observe a deleted, anonymised, or relinked member and write
nothing. A pre-lock contact/email match is only a candidate and is never
authority to restore local PII.

Manual Xero linking uses the symmetric member-row fence. Provider contact lookup
and cache refresh remain outside transactions; the short local link transaction
then takes the exact target `Member FOR UPDATE`, re-reads an ambiguous active
contact-create reservation under that lock, and writes the member link only when
none exists. The `Member.xeroContactId` write and canonical CONTACT
`XeroObjectLink` upsert commit in that same transaction; the FK-less ledger row
must never be written after releasing the Member lock because merge could delete
the losing member in that gap. If create reserved first, Link returns the fixed
privacy-safe 409 and writes nothing. If Link locked first, the create
reservation's waiting `FOR KEY SHARE` resumes after the link commits, re-reads
the authoritative `Member.xeroContactId`, and refuses before reserving or calling
Xero. The same privacy transaction clears `Member.xeroContactId` and deactivates
every active Member CONTACT ledger row, so a change that completed before
deletion cannot leave an active identity link. An ambiguous
`CREATE_IN_PROGRESS` member page therefore offers only authoritative refresh;
the stronger `PROVIDER_CREATED_LINK_PENDING` state still offers Link as its
recovery action while suppressing another Create.

Inside that same link transaction — manual Link, the inbound patch, and
`findOrCreateXeroContact`'s phase-2 write — a canonical link commit also closes
the provider-created create it has just completed
(`closeProviderCreatedContactRecoveryForLinkedContact`). It is a status-guarded
`updateMany` on `status: "FAILED", manuallyResolvedAt: null` restricted to rows
whose recorded `resolvedContactId` equals the contact being linked, so it is
idempotent, a lost claim against the admin resolve action writes nothing, a
`RUNNING` reservation is never touched, and a create that made a *different*
contact stays open as the genuine duplicate it is. Because the close shares the
Member `FOR UPDATE` with the pointer and ledger writes, merge and deletion can
never observe a linked member with that operation still blocking them. Merge,
deletion and the member detail display read the blocker through one predicate
(`findMemberContactChangeMergeBlocker`), so the display cannot report a clean
state for a member either lifecycle operation is refusing.

Account deletion composes the same fence with its existing lifecycle order. While
holding the target `Member FOR UPDATE`, deletion re-checks the complete active,
provider-created, or stale-unknown contact-create blocker before anonymising.
Create-first therefore makes deletion return its safe recovery contract without
changing the member. Deletion-first makes a waiting create reservation, manual
Link, provider-returned local-link phase, or inbound contact writer re-read the
canonical deleted marker and refuse before any new provider call or local
attribution. Provider calls stay outside all of these transactions.
Real-PostgreSQL races pin both winner orders for deletion/merge versus
create/manual Link/inbound reconciliation/historical backfill, including no provider
reservation/call/link when lifecycle wins and no dangling FK-less link when
merge or deletion completes.

The deletion side of that fence takes the row lock and re-checks the blocker set,
but deliberately does **not** re-read the deleted marker as a refusal (#2627).
Deletion is what writes that marker, so asserting it there made a member who had
already been through an approved self-service deletion permanently impossible to
hard delete — the fence raised `XeroMemberUnavailableError`, which no delete path
catches or maps, so the operator got a bare 500 with no code and no remedy.
Anonymisation has already torn the contact linkage down (`Member.xeroContactId`
nulled, every active Member CONTACT ledger row deactivated), so Xero
availability is not a question that applies to such a member. The
contact-*writing* participants still assert it, which is what makes
deletion-first refuse them.

Approve, reject and release of one `DeletionRequest` share a separate exact-row
winner protocol: a guarded `updateMany` naming the exact status it transitions
FROM is the only authority for any transition. Rejection claims `PENDING` — and,
since #2627, the exact FLAVOUR of `PENDING` it was authorised against, because a
released request is `PENDING` too. An unconfirmed rejection guards on
`reviewedAt: null`, a confirmed reject-after-release on `reviewedAt: { not: null }`,
and the two shapes partition `PENDING` exactly. The Full-Admin gate and the
confirmation that separate those two cases are evaluated against the route's
opening read, which is not the serialised point, so putting the marker in the
guard is what stops a release committing in that window from silently converting
an ordinary rejection into an unwarned reject-after-release over
already-committed cancellations. An
approval with future bookings to cancel first claims
`PENDING -> APPROVAL_IN_PROGRESS`, before the first cancellation commits, and
finalises only from that claim inside the privacy anonymisation transaction; an
approval with nothing to cancel takes no claim and finalises `PENDING ->
APPROVED` in that same transaction, because it committed nothing ahead of it
(#2627). A Full Admin release performs `APPROVAL_IN_PROGRESS -> PENDING`.
PostgreSQL serialises contenders on the request row, so the loser returns 409 and
sends no contradictory email: a release arriving while a finalisation is
committing blocks on that row's write lock and then matches zero rows, and a
release that commits first makes the finalisation match zero rows and roll its
whole anonymisation transaction back. If a later approval mutation fails, the
claim and anonymisation roll back together to whichever status the approval
started from. Booking cancellations committed before the approval transaction
remain truthful partial cleanup and are reported as such if a concurrent
rejection or release won. A finalisation that loses its guard to a release lands
on `PENDING`, which is reported as exactly that (`DELETION_REQUEST_APPROVAL_RELEASED`)
rather than as an unconfirmable final state.

The release is the one transition that additionally takes the request row
`FOR UPDATE`, and it must be handed a transaction client. It nulls the claim's own
attribution, so its audit entry is the only surviving record of who held the
claim — and that holder has to be read at the same serialised point as the
mutation, or an ABA interleaving (a claim released and re-taken between the read
and the write) records an admin whose claim was never displaced. So the release
takes the row lock, reads the previous holder and note through the Prisma model
under it ("Lock raw, read typed" above), performs the guarded transition, and the
route writes the audit row with the awaited `createAuditLog` inside that same
transaction: the record and the transition commit or roll back together. The
guarded `updateMany` is retained under the lock, so a caller that forgets the
transaction still fails closed instead of reporting a release that did not happen.
The transition also stamps `reviewedAt` on the now-`PENDING` row which — with no
`reviewedBy` — is the durable marker that this request was re-opened after an
approval had started; `docs/DOMAIN_INVARIANTS.md` covers what the queue, the
reject dialog and the reject route each do with it, and the guard above is what
makes it binding rather than advisory.

Because that lock is the release's first statement and the finalisation
legitimately holds the same row from its claim to its commit, this is the one
transaction here designed to WAIT. It therefore carries explicit
`maxWait` 10s / `timeout` 15s (longer than the finalisation's own default 5s
budget, so a release loses on the guard rather than on the clock) and the route
maps P2028/P2034 to a 503 `DELETION_REQUEST_RELEASE_CONTENDED` retry-later, the
same convention as the site-style/club-theme writer recorded earlier in this
document. See the "Deletion-request approval release" entry under "Narrow row- and
table-lock protocols" for the full lock order and counterpart analysis.

After Xero returns a newly created contact, the operation is durably marked
`provider_contact_created_local_link_pending` before the local link transaction.
That marker remains authoritative recovery proof while `RUNNING` and after the
stale-operation reset changes it to `FAILED`; resetting a row must not erase a
known provider-created contact. If both attempts to record that proof fail, the
exact unmarked `RUNNING` reservation remains an ambiguous create-in-progress
fence. A stale reset preserves that uncertainty as exact `FAILED` +
`ORPHANED_STALE_RUNNING`, without claiming that Xero created anything. Both
states suppress another Create and block member merge. They clear only after the
member is linked, the operation succeeds, or an operator explicitly resolves it;
a terminal non-provider failure clears the ambiguous state. A failed local link
also remains a blocker with the strict `FAILED` + local-link phase +
`providerContactCreated: true` proof. Matched-existing contacts and unrelated
failed or completed operations do not block.

Inside the locks the merge re-reads both members, re-runs the full guard matrix,
and re-verifies the HMAC preview token (which bakes in both `updatedAt` values)
before any write, so a stale preview or a concurrent edit fails with a 409
instead of merging against changed state. A concurrent edit that lands *after*
that check, from a writer outside the lock family, is caught by the second
derivation described under "Member photo writer" above and 409s the same way
(#2243) — so the sentence holds end to end, not just at the transaction's
opening. There are **no Xero API calls** in or
after the transaction — the loser's Xero teardown is DB-only (deactivate
contact-identity `XeroObjectLink` rows and re-point the active
`ENTRANCE_FEE_INVOICE` link to the master); the loser's Xero contact is left for
manual clean-up.

The merge transaction runs with an extended interactive-transaction window
(`timeout: 120s`, `maxWait: 10s`): re-pointing 70+ relations takes hundreds of
sequential round-trips on a heavy member, and the dual advisory lock already
serialises every competing lifecycle writer, so the long window cannot admit a
concurrent conflicting write.

#### Merge joins the bed-allocation cohort — lodge BEFORE member, and no global key (#2595)

Merge invalidates future partner-shared double-bed placements (see
`INV-CAP-030` in docs/invariants/booking-dates-and-capacity.md: dropping the
duplicate's CONFIRMED partner link leaves the master sharing a double with
somebody it has no partnership with). Repairing that inside the merge
transaction means merge is a bed-allocation writer, so it takes a
**partner-share prefix** — and both *what* is in that prefix and *where* it is
taken are load-bearing:

```
lockAdultMemberHostingPolicySet(tx)                              policy config
  → acquireMemberMergePartnerSharedLodgeLocks(tx, [master, loser])
        = acquireLodgeCapacityLock per affected lodge, sorted     per-lodge
          (affected = the lodges of their future bed allocations
           UNION the lodges of EVERY booking they hold a guest
           row on — no date filter, no status filter, #2672)
        = NO pg_advisory_xact_lock(1)                             deliberately
  → member-lifecycle:<master> / member-lifecycle:<loser>, sorted  member
  → member-partner-link:<master> / member-partner-link:<loser>,   member links
        sorted (#2595 — the sweep READS confirmed links to decide
        which shared doubles it deletes; same relative position as
        the reviewed move's own lifecycle→partner-link pair)
  → steps 1-3: null self-cycles, resolve collisions, applyMoves
  → one sorted master/loser/ancillary `Member … FOR UPDATE`        member rows
  → under-lock hosting re-plan + sorted hosting-coverage-owner     last
  → contact-create proof re-check + late owner/actor queue sweeps
  → step 3b: sweepUnbackedFutureSharedDoublesWithLocksHeld
             (handed the locked lodge set. MUST stay below the
              `Member … FOR UPDATE` line above: it first re-derives
              the guest-row lodges under that row lock — where the
              FK's FOR KEY SHARE cannot commit against it, so the
              set is frozen — and 409s if the prefix no longer
              covers them. Moved above it, that check degrades from
              a fence to an observation. Then 409s per candidate
              row outside the set, #2672)
  → steps 4-8: Xero teardown, field merge, audit, enqueue, delete
```

That is the #2597 order with **two** tiers inserted, both before any read that
decides a write: the per-lodge prefix at the very top, and the
`member-partner-link:` pair immediately after the member-lifecycle pair. Nothing
already in the sequence moved, and no new key is taken late. (The composed order
at "Member merge — dual member-lifecycle lock" above lists both; this diagram
and the sentence under it used to name only the lodge tier, which made one
section of this document contradict another and itself.)

**Why the lodge tier is at the top.** It MUST be taken before the
member-lifecycle pair, never after. Merge's own lock set was member-scoped and
took no lodge key before this, so bolting the sweep on at the point of use —
after the relation moves, with the member-lifecycle keys already held — would
acquire a lodge key *after* a member key and invert the fixed
**global → lodge → member** order this document opens with, against every
ordinary bed-allocation writer that takes global → lodge and then reaches a
member tier. That is a deadlock, not a style point. The same reason forces the
lodge set to be **derived** before the relation moves: the helper reads the two
members' own future allocations and guest rows, so it has to run while both
identities still name their rows.

**Why merge takes no global cohort key.** An advisory xact lock is released only
at COMMIT and merge runs with `timeout: 120s`, so a merge holding `lock(1)` would
exclude every cancel/capture/settle/refund and every bed-allocation writer in the
club for its whole window. Those writers open their own interactive transaction
and *then* block, on Prisma's default 5-second budget, so they are **rejected with
`P2028`, not merely queued**. Measured on the disposable harness, a merge held the
key ~0.9-1.4s on a five-member fixture on a quiet machine and 10-60s on a loaded
one; hosted CI sat at the loaded end. The #1756 partner-share callers (link
dissolve, deactivation, ADULT→minor correction, seasonal reassignment, bulk
update, account-deletion approval) are all short transactions and keep the global
key through `acquireFuturePartnerSharedAllocationLocks`. Merge is the one caller
long enough for it to matter, so it has its own narrower helper.

**What pays for dropping it: the guest-row derivation.** With no global key, the
only thing serialising the sweep against the bed-allocation writers is the
per-lodge capacity key, so the derived lodge set has to cover every lodge a
placement could *land* in, not just the lodges where a bed is already allocated.
It is the union of two reads:

- the lodges of the two members' future `BedAllocation` rows (each row's own
  `room.lodgeId`, so a legacy row that has drifted out of its booking's lodge
  partition is still covered), and
- the lodges of **every booking either member holds a guest row on**
  (`BookingGuest.memberId IN (master, loser)` and nothing else). No date filter,
  no status filter: booking-status transitions serialise on the global key that
  merge no longer holds, and the stay columns are rewritten by writers merge
  cannot exclude, so narrowing on either would be narrowing on state a racing
  writer can change.

A future placement implies a guest row **in the same lodge**, because a
`BedAllocation` exists only for a `BookingGuest` (FK-constrained), every
allocating writer picks its room from that booking's own lodge
(`roomsForBooking`/`roomsAtLodge`, plus the explicit "Bed belongs to a different
lodge than the booking" refusal on the manual paths and the reviewed move's
`LODGE_MISMATCH`), both `Booking.lodgeId` and `LodgeRoom.lodgeId` are NOT NULL,
and no writer ever updates `Booking.lodgeId`.

**Why the date filter is gone (#2672).** That second read used to ask for FUTURE
guest-nights only — `BookingGuest.stayEnd >= today` OR any
`BookingGuestNight.stayDate >= today` — and the completeness argument written
around it enumerated `Booking.lodgeId` immutability, FK-constrainedness and NOT
NULL columns. All true; none of them about the columns being filtered on. Every
one of those is **mutable**, and the writers that move them hold `lock(1)` plus
their own booking's lodge key and **no** `member-lifecycle:` or
`member-partner-link:` key — the only keys merge still holds:

- `modifyBookingDates` / `adminShiftBookingDates`
  (`booking-date-modification-service.ts`) under `adminOverride`, whose stated
  purpose includes shifting a **fully-past** booking's dates; and
- `modifyBookingBatch` through `buildInProgressGuestRangePlan`
  (`booking-edit-guest-ranges.ts`), which needs **no override and no admin
  role** — extending an in-progress booking's check-out widens every remaining
  guest's `stayEnd` to the new check-out, including a partial-stay guest whose
  own nights had already ended.

Both then call `reconcileBedAllocationsForBookingWithLodgeLockHeld`, which
auto-allocates on the newly-future nights. So a booking at lodge Y holding only
PAST guest-nights when the set was derived was invisible to both reads and could
acquire future ones mid-merge, in a lodge merge held no key for. `Booking.lodgeId`
being immutable never helped: the lodge does not move, the **nights** do.

**What was actually demonstrated against real PostgreSQL, and what was not.** Be
exact here, because an earlier draft of this section claimed more than the
evidence supports. What reproduces, reliably, on the pre-#2672 derivation: with a
merge running and holding its derived prefix, a real `adminShiftBookingDates`
translates a fully-past booking at lodge Y onto a future night **with zero
waiters on lodge Y's capacity key**, and commits. The merge simply never held
that key. That is the defect, and it is now the regression test
(`member-merge-shared-double-races.realdb.test.ts`, "takes the capacity key of a
lodge known only from a guest row whose stay is entirely in the past" and "fences
the admin date shift that used to walk a past stay into an unlocked lodge").

What did **not** reproduce is the *last* step of the four-step interleaving —
the hand-placed second occupant committing inside merge's own read-to-commit
window, leaving a surviving unbacked shared double. It was driven end to end,
with the merge parked deterministically inside the sweep (a row lock on the
allocation the sweep is about to delete, so the candidate read has provably
already happened), and the hand placement never got in. `manuallyAllocateBed`
takes `pg_advisory_xact_lock(1)` as its **first** statement, and in this
interleaving that key is already held — by the date writer's own partner-share
reconcile, which took the global key and is itself queued on a lodge key the
merge holds. Postgres' `log_lock_waits` names all three: the merge waiting on the
sweep's row (the test's park, not a production wait), the date writer's reconcile
holding `[0,1]` and waiting 114s on the merge's lodge key, and the hand placement
waiting 114s on `[0,1]` behind it. A
three-party convoy, no cycle, and the escape is fenced by the global key it does
not itself take.

So the honest statement of the pre-fix residual is **narrower than #2641's own
residual note claimed**: the lodge-coverage gap is real and reproducible, but the
step that would turn it into an unbacked shared double is transitively fenced by
`lock(1)` for as long as a guest-date writer is the thing that opened the gap.
The fix below is justified by the coverage gap being real and by refusing rather
than by a demonstrated surviving share, and nothing here claims otherwise.

Filtering on the guest ROW instead of the guest's DATES removes the class: no
date write can make a guest row stop being a guest row at that lodge.

**What it costs, at the size it actually is.** A member who has ever held a
guest row at every lodge makes merge take **every** lodge's capacity key,
bounded by the club's lodge count rather than by the member's booking history.
For the merge's whole 120s budget, every booking create, confirm, payment
capture, cancel-with-reconcile, board place/move/remove and admin date shift at
a held lodge queues on a key merge holds, on its own 5-second Prisma budget, and
is **rejected with `P2028` having written nothing** — not merely delayed.

How much that costs depends entirely on the deployment's lodge count, and
**this is a per-deployment fact, not a property of the software** — this
repository is a template each club deploys. An earlier revision of this
paragraph reasoned from `docs/multi-lodge/README.md`'s claim that the club ran
**two** lodges and concluded the bound "is the whole club". That claim was
stale. Measured against the live Tokoroa database on 10 Aug 2026 (#2731,
read-only aggregate counts):

| Measure | Value |
|---|---|
| Lodges (total / active) | 1 / 1 |
| Members holding a guest row | 91 of 431 |
| Members holding guest rows at more than one lodge | **0** |
| Member merges ever run | **0** |

On a single-lodge deployment any lodge-scoped lock is club-wide by definition,
so the distinction this section reasons about does not exist there — and the
window has never opened, because no merge has ever run. #2731 records that as an
accepted, quantified risk rather than a defect. **On a genuinely multi-lodge
deployment the worst case above is the right reading**, and that is when the
cheapest mitigation — classifying `P2028` as contention and telling the operator
to retry, as `waitlist-return-contract.ts` and `deletion-request-decision.ts`
already do — earns its keep.

What dropping `lock(1)` still buys is real but **narrower than it sounds**: the
writers it protects are the ones that take the global key and **no** lodge key —
the settlement/cancel claim transactions — because #2593 already made the
allocation-participating confirmed-create and cancellation paths compose
global → lodge (see the header of `adult-member-hosting-coverage-lock.ts`), so
most capacity writers take a lodge key and stall either way. The resulting shape
is the convoy described at the foot of this section, **measured** at ~114s waits.

The distribution above was measured on 10 Aug 2026 and is recorded on #2731.
Re-run these queries against a representative database when a deployment adds a
second lodge, or when merges stop being a rare deliberate action — those are the
two conditions that reopen the question. Run them read-only; aggregate counts
are all that is needed, and no row data or database copy is required:

```sql
SELECT count(*) FROM "Lodge";

SELECT lodges, count(*)
FROM (
  SELECT bg."memberId", count(DISTINCT b."lodgeId") AS lodges
  FROM "BookingGuest" bg
  JOIN "Booking" b ON b.id = bg."bookingId"
  WHERE bg."memberId" IS NOT NULL
  GROUP BY 1
) t
GROUP BY 1
ORDER BY 1;
```

**The alternative that was rejected** was giving the three
guest-date writers a `member-lifecycle:` tier of their own for the members whose
dates they move. It is order-safe on paper (they already take `lock(1)` → lodge,
so → member is the documented order) and it would close the gap at the source
rather than by over-locking — but it puts a member-family key on a Critical money
path, so every date change would contend with every archive, delete and merge,
and it needs its own deadlock pass across three writers instead of none. Widening
one read in one function was the smaller blast radius for the same outcome.

**And the set cannot GROW behind the merge's back either.** Dropping the date
filter fixes what the set contains at derivation time; it says nothing about a
guest row *inserted* at a lodge these members had never booked, between the
derivation at the top of the merge and the sweep. Step 3b closes that positively
rather than by argument: it **re-derives the same guest-row lodge set** and 409s
if the prefix does not cover it — and it does so *after* merge's sorted
`Member … FOR UPDATE`
(`lockMemberMergeHostingCoverageParticipants`). `BookingGuest.memberId` is a real
foreign key to `Member`, so PostgreSQL takes `FOR KEY SHARE` on the referenced
member row for every INSERT naming it and every UPDATE re-pointing onto it, and
`FOR KEY SHARE` conflicts with `FOR UPDATE`. Once merge holds both member rows
`FOR UPDATE`, no such write can commit until merge does — the same property
`adult-member-hosting-queue-participants.ts` already documents from the other
side ("blocks every FK write naming those members, so an uninvolved
booking-create or guest-add can wait behind the tail of a merge"). So the
re-derived set is **frozen for the remainder of the transaction**, and passing
the subset check is a statement about the future rather than about that instant.

**Two checks, deliberately, answering different questions.**
`acquireMemberMergePartnerSharedLodgeLocks` returns the exact lodge ids it locked
and step 3b is handed them:

- the **coverage** check runs first, before any candidate is read and whether or
  not the sweep would find anything to remove, because the hazard is a lodge that
  holds no shared double *yet*; and
- the **per-candidate** check runs second, on each row's own `room.lodgeId`,
  because a legacy allocation whose room has drifted out of its booking's lodge
  partition is invisible to a derivation that reasons from guest rows.

Either raises `UnlockedPartnerShareLodgeError`, which merge maps to a 409
(`partner_share_lodge_drift`, audited as a refused merge) with **nothing
written** — never a bed-inventory write in a lodge this transaction did not
serialise against. What the admin sees is "A lodge booking for one of these
members changed while the merge was running. Nothing was merged — please try
again."; the retry derives the wider set and succeeds. The residual cost of the
owner decision is therefore a rare, safe, retryable refusal, in place of a
guaranteed club-wide stall on every merge.

**Deadlock analysis, re-done for the new edge set.** The edges merge contributes
are now **three**: `adult-member-hosting-policy-set` → per-lodge capacity,
per-lodge capacity → `member-lifecycle`, and `member-lifecycle` →
`member-partner-link`. All three already exist elsewhere in the same direction,
and no reverse edge exists anywhere in the tree:

- `policy-set → lodge` is also configuration transfer's order
  (`config-transfer/apply.ts`: config-import singleton → minimum-stay set →
  hosting set → affected lodge ids, sorted). No transaction anywhere takes a
  lodge key, or the global key, and then the policy-set key: the enforcement
  sites *read* the policy under a global or lodge lock and never take its key,
  live policy CRUD takes only that key, queued incident reconciliation takes it
  first, and the queue drain uses the fail-fast `tryLock` while holding nothing.
- `lodge → member-lifecycle` is the order every partner-share caller and the
  reviewed bed-allocation move already use. No transaction takes a
  member-lifecycle key and then a lodge key, or the global key.
- `member-lifecycle → member-partner-link` is the reviewed bed-allocation move's
  own order (`bed-allocation-move.ts`), so merge adds a second HOLDER of an
  existing edge rather than a new edge. The reverse cannot exist: the
  partner-link service takes the `member-partner-link:` key and no other tier at
  all, so no holder of it is ever waiting on a lodge, global or member-lifecycle
  key that merge might hold. The full justification for taking this tier — the
  per-side CONFIRMED partial uniques, and the *validating* confirm that was
  serialised by nothing before #2595 — is at "Member merge — dual
  member-lifecycle lock" above and at "The counterparts' member rows are not
  locked" below.
- Every multi-key acquisition inside a family is sorted — lodge ids,
  member-lifecycle ids and member-partner-link ids here — so two merges, or a
  merge and any lodge writer, cannot hold each other's next key in any family.
- The edge that DISAPPEARS is `policy-set → lock(1)`. Merge is no longer a holder
  of the global key at all, so the bed-allocation and money writers that take
  `lock(1)` and then a lodge key can never queue behind a merge on the global
  key. They can still queue behind it on a lodge key it holds, while themselves
  holding `lock(1)`; that is a convoy, not a cycle, because merge never waits for
  the global key.

**Re-done again for #2672, against the edge set `main` carries today** — which
now also includes #2636's `DeletionRequest` row lock and this section's own
lodge-only prefix. Widening the derivation and adding the coverage re-derivation
introduce **no new edge at all**, and the derivation is worth stating rather than
asserting:

- **No new key.** The wider derivation takes the *same* family (per-lodge
  capacity) at the *same* point in the order; only the cardinality of the set
  changes. Acquisition inside the family is still sorted, and a cycle inside one
  totally-ordered family is impossible however many members of it a transaction
  takes: a sorted acquirer never requests a key below one it already holds.
- **The coverage re-derivation waits on nothing.** It is a plain MVCC
  `SELECT … FROM "BookingGuest"` with no `FOR` clause, issued under locks merge
  already holds. A read that cannot block cannot be an edge in a wait-for graph.
- **`lodge → Member`-row is not inverted by it.** Merge takes every lodge key at
  the top and the sorted `Member … FOR UPDATE` much later, so when merge is
  holding member rows it is not waiting for any lodge key. A concurrent
  booking-create or guest-add holds `lock(1)` + its lodge key and then blocks on
  the FK's `FOR KEY SHARE` against merge's `FOR UPDATE` — one direction only.
  Widening merge's lodge set changes only *where* that writer stops: at one of
  merge's lodge keys instead of at the member row. Both are convoys bounded by
  the waiter's own budget, ending in `P2028` with nothing written.
- **Against #2636/#2627's `DeletionRequest` row lock.** Merge takes no
  `DeletionRequest` row at any point, and the release path
  (`releaseDeletionRequestApprovalClaim`) takes that row plus an `AuditLog`
  insert and **no** lodge, global or member-lifecycle key — so neither can be
  waiting on anything the other holds. The deletion-approval *finalisation* does
  share two of merge's tiers, but in the same direction merge uses (lodge →
  member-lifecycle → `DeletionRequest` row → `Member` row) and, like merge, it
  finishes the lodge family before reaching a member tier. Two transactions that
  both complete family *n* before entering family *n+1* cannot hold each other's
  next key.
- **Against the #1756 partner-share callers.** They take `lock(1)` first and then
  their own sorted lodge set. A wider merge set makes it likelier that such a
  caller blocks on a lodge key merge holds *while holding `lock(1)`* — the
  club-wide convoy described below, unchanged in kind and bounded by that
  caller's own budget. It is still not a cycle, for the same single reason it
  never was: merge waits for the global key nowhere, so the wait graph
  terminates.
- **That convoy was observed, not just reasoned about (#2672).** Driving the
  interleaving under `log_lock_waits` produced exactly the predicted three-party
  chain and no cycle: the merge holding its lodge keys; the guest-date writer's
  partner-share reconcile holding `lock(1)` and waiting ~114s on one of merge's
  lodge keys; and an admin hand placement waiting ~114s on `lock(1)` behind it.
  Every waiter is bounded by its own transaction budget and expires with `P2028`
  having written nothing. Merge is a **sink** in that graph — it waits on no key
  either of them holds — which is the property the whole design rests on.

`member-merge-execute.test.ts` pins that `executeMemberMerge` issues no
`pg_advisory_xact_lock(1)` at all, and
`member-merge-shared-double-races.realdb.test.ts` proves the same thing against
real PostgreSQL by running a whole merge while another session holds `lock(1)`,
plus the converse — that the merge still queues on the affected lodge key, on the
key of a lodge known only from a future guest-night, and (#2672) on the key of a
lodge known only from a guest row whose stay is entirely in the **past**. The
same suite drives the writer that filter used to let through: a real
`adminShiftBookingDates` moving a fully-past booking forward mid-merge now queues
on that lodge's capacity key, where before it committed with no waiter at all.
It does **not** claim the full four-step escape ever completed — see "What was
actually demonstrated against real PostgreSQL, and what was not" above.

The sweep itself is `sweepUnbackedFutureSharedDoublesWithLocksHeld`, run as merge
step 3b — after `applyMoves` (the guest rows now name the master) and after step
2's `resolvePartnerLinks` (the surviving partnerships are final), before the Xero
teardown. Inside that window it sits after the #2597 participant `FOR UPDATE`
set, the under-lock re-plan and the coverage-owner keys, so it acquires nothing
and runs only once every drift refusal has passed: no bed-night is judged against
a state the merge is about to 409 on. Sitting after the participant `FOR UPDATE`
is what makes its own coverage re-derivation a fence rather than a second look —
see "And the set cannot GROW behind the merge's back either" above. Its candidate
rows are re-read under the locks; the removed rows are returned so the admin
alert can be sent AFTER commit, alongside `settleHostingCoverageAfterCommit`.

Two consequences worth stating plainly, because neither is obvious from the code:

- **A same-lodge bed-allocation writer queued behind a merge may still be
  rejected rather than served.** Dropping the global key removes the club-wide
  stall, not the per-lodge one: merge holds each affected lodge's capacity key
  until it commits, and the writers that block on it run on the default 5-second
  budget. If the merge outlives that budget the waiter is rejected with `P2028`
  having written nothing, and has to be retried. It is fail-safe — a rejected
  transaction rolls back whole, so nothing partial and nothing invariant-breaking
  is ever committed.

  **Do not read that as "the club-wide queue is gone".** Every cohort writer
  takes `lock(1)` FIRST and its lodge key second (the fixed order above), so a
  cohort writer that arrives at one of the merge's lodges blocks on the lodge key
  *while holding the global key*, and the rest of the club queues behind it for
  the length of that wait. The reviewed move
  (`bed-allocation-move.ts`, `{ maxWait: 10_000, timeout: 30_000 }`) and the
  range writer carry the longest such budgets. What the design actually buys is a
  change of shape, and it is still a large win: a **120s direct** hold by the
  merge becomes **transitive bursts bounded by each waiter's own budget** (5s by
  default, 30s for the two explicit ones), each ending in a `P2028` rollback
  rather than in a stall of the merge's own length. It is a convoy, never a cycle
  — merge waits on no global key, so the wait graph always terminates.
  `member-merge-shared-double-races.realdb.test.ts` asserts exactly that
  contract ("THE SAME-LODGE WRITER QUEUED BEHIND A MERGE") for the arms where the
  writer is queued *behind* the merge, and asserts strict must-commit for the arms
  where the writer is queued *first* — those never wait on the merge at all.
- **The counterparts' member rows are not locked; their LINKS to the merged
  members are.** Merge locks the master and the loser, never the ex-partner P or
  the kept partner Q whose eligibility the sweep reads. What it does hold is
  `member-partner-link:{master, loser}` — and that is the tier that matters,
  because `mayShareDoubleBedWith` looks up **only the canonical pair** for each
  bed-night (`double-bed-sharing.ts`: `OR: candidates.map(canonicalPartnerPair)`).
  Every occupant pair the sweep judges has the master (or, before `applyMoves`,
  the loser) on one side, and every writer of an X↔master link takes the master's
  key, so no link write that could change a verdict can interleave with the
  sweep. This closes a real hole: the partner-link service takes **no** lodge or
  global key (it writes no bed rows), so before #2595 took this tier a concurrent
  *validating* confirm was serialised by nothing at all, and — because the
  CONFIRMED partial uniques are per side — could leave the master with two
  confirmed partners and the sweep keeping a share the invariant forbids.

  The remaining unlocked reads are the counterpart's own `Member.ageTier` and
  `Member.active`. Every event that INVALIDATES a share through those columns —
  deactivation, an ADULT→minor correction, a seasonal reassignment, a link
  dissolve — runs the #1756 sweep behind the same per-lodge capacity keys, and a
  counterpart the sweep judges necessarily holds an allocation on the contested
  bed, hence in a lodge merge has locked; so it either commits before this merge
  (and the sweep sees its result) or waits until after it (and sweeps whatever
  the merge left). An event that VALIDATES a share through those columns (a
  reactivation, a minor→ADULT correction) takes no lodge key, so it can commit
  between the sweep's read and merge's commit — and the sweep then removes a
  second-occupant row that has just become legitimate. That is the fail-safe
  direction, not a data defect: the guest returns to the board's
  awaiting-allocation queue, the primary keeps the bed, capacity is unchanged,
  and the removal is audited on both bookings and alerted to officers.

  Finally, `mayShareDoubleBedWith` reads only
  `Member.ageTier`, `Member.active` and CONFIRMED links; the merge's own step-5
  field patch touches none of those three
  (`FILL_IF_BLANK_FIELDS`/`GROUP_FILL_SPECS` carry no `ageTier` or `active`, and
  `mergeMemberFields` is a closed enumeration that can emit no other column),
  which is why judging the bed-nights at step 3b gives the same answer as judging
  them after the field merge.

## The disciplines, by writer class

### Capacity claim → per-lodge lock, read-key → lock → re-read

The per-lodge lock key needs the booking's `lodgeId`, which you only know after
reading the row — so these paths cannot lock before their first read. The safe
pattern is:

1. Read only `{ lodgeId }` (plus any cheap early-bail fields). `lodgeId` is
   immutable, so keying the lock from this read is always safe.
2. `acquireLodgeCapacityLock(tx, lodgeId)` (after `lock(1)` if the writer also
   moves money — see below).
3. **Re-read the full row under the lock** and consume only that post-lock
   snapshot for the capacity check, pricing and claim.

`cron-confirm-pending.ts` is the reference implementation; the same shape is in
`booking-create.ts`, `payment-reconciliation.ts`, `group-settlement.ts`
(`commitChildrenToConfirmed`, keyed on each child's own lodge in sorted order),
the confirm-pending-guests / waitlist-confirm / switch-to-internet-banking
routes, the booking modify/cancel/settlement services, and
`xero-inbound/invoice-paid-effects.ts`. Skipping step 3 (acting on the pre-lock
snapshot) is a TOCTOU.

The admin exclusive whole-lodge hold route follows the same rule even though
the hold flag itself is row-scoped: it reads only immutable `lodgeId`, takes the
per-lodge lock, then re-reads status, hold state and dates. Both set-time
conflict queries and their audit metadata consume that post-lock snapshot, so a
concurrent date move cannot make the hold apply to one range while reporting
conflicts for an older range. Its status-guarded SET remains necessary because
cancel writers use the disjoint global lock and may still race the row update.

Existing bed-allocation moves (`moveBedAllocationsSameDate`, #2366) compose the
global and per-lodge tiers. They do not change booking status or money, but
cancellation prunes a cancelled booking's allocation rows under global
`lock(1)`: a lodge-only move could otherwise read a row, let cancellation
delete it, and then re-upsert it onto the cancelled booking. The
pre-transaction read resolves only the destination bed's immutable lodge key.
The transaction takes **global `lock(1)` first, then that lodge lock**, and
re-reads the source allocation rows and their persisted lodge nights under
both before funnelling every selected row through `manuallyAllocateBed`. If
cancellation won, the post-lock source read returns no row and the move writes
nothing. The row changes, shared-double partner promotions (with each causal
moved-allocation id) and audit rows all remain in that transaction; one
conflict rolls the group back. This writer takes no member lock because it
preserves every member-night footprint. Its custodian-hold counterpart takes
the same lodge key, cancellation takes the same global key, and the fixed
global -> lodge order introduces no inverse.

Reviewed bed-allocation removal (`applyBedAllocationRemoval`, #2594) is the
multi-row destructive counterpart. Its PREVIEW takes no lock and writes
nothing. APPLY resolves the immutable booking lodge plus the reviewed anchor
lodge before the transaction, then takes **global `lock(1)` → those lodge keys
in sorted id order → every selected or causal `BedAllocation` row in sorted id
order with `FOR UPDATE`**. Its first authoritative read refuses a matching or
causal row in any third lodge, so historical drift cannot be deleted under an
unrelated lodge lock.
ID- and bed-night-expanded queries use deterministic chunks of at most 10,000
values, preserving that one global row-id order while staying below
PostgreSQL's 65,535 bind-parameter ceiling. Every chunk remains inside the same
transaction; a later delete or promotion count mismatch rolls back earlier
chunks and their locks.
It re-runs the full preview under those locks and compares the supplied
`v1:<sha256>` digest before delete, partner promotion, or audit. A stale/moved
anchor, newly approved row, changed category, or concurrent lifecycle result is
a 409 refreshed preview with no partial mutation. The reset path never invokes a
planner; the separate explicit `runAutoBedAllocation` writer is merely a
counterpart taking the same global/lodge tiers.

Reviewed bed-allocation moves (`applyBedAllocationMove`, #2595) extend that
topology because a move can change both room occupancy and a confirmed-partner
shared-double consequence. PREVIEW is read-only and takes no lock. APPLY takes
**global `lock(1)` -> the complete sorted source, destination, allocation-booking,
guest-booking, and relevant-occupant lodge union -> sorted member-lifecycle
locks -> sorted canonical member-partner-link locks -> every selected and
causal `BedAllocation` tuple ordered by bed, night, primary/second flag, and
id**. It then re-reads the complete state and recomputes the `v1:<sha256>`
preview digest before any write. A newly discovered lodge or member family is a
stale-preview refusal, never an unlocked expansion. This path deliberately
takes no member-night lock: it preserves each guest's existing lodge-night
footprint and creates no missing guest-night or allocation row.

The authoritative preview covers every existing row for the selected night or
for that booking guest (up to 366 rows), including sparse and off-screen rows,
as well as destination room-night occupants, old-bed promotion candidates,
booking/guest/lifecycle facts, partner links, whole-lodge and custodian holds,
and exact guest-night eligibility. Unchanged rows participate in the digest
but not feasibility checks, promotions, writes, approval reset, or audit. A
changed approved row becomes an unapproved `MANUAL` draft; a vacated
shared-double second occupant is promoted in the same transaction. Guarded
update or promotion count drift rolls the transaction back. All changed rows
are written by one guarded `UPDATE ... FROM (VALUES ...)` statement rather than
up to 366 sequential round trips; the interactive transaction carries the same
explicit 30-second timeout and 10-second acquisition wait as the supported
366-night range writer. The disposable-PostgreSQL rehearsal installs a small
per-UPDATE-statement delay, proves the former sequential/default-5-second shape
times out and rolls back, then moves all 366 rows through the production path.
An all-noop apply
writes no allocation and no audit; a stale digest returns a refreshed preview
with no partial mutation.

The counterpart inventory is deliberate. Legacy same-date move, reviewed move,
explicit auto-allocation,
lifecycle reconcile, cancellation prune, room/bed inventory changes, manual
placement/range assignment, and reviewed removal all share global → sorted
lodge order before their allocation writes. Approval also row-locks the exact
matching allocations after those tiers: a lodge-scoped approval locks that one
lodge; the supported legacy club-wide selector locks the sorted immutable
superset of all current lodge ids before its sorted allocation-row locks, so a
newly matching allocation cannot enter from an unlocked lodge after a mutable
pre-read. Requested-room writes take global then the booking row, re-read the
requested room only after authority is established, and repeat the
"no approved row exists" predicate in the guarded member update. Thus approval,
removal, and requested-room editing cannot cross into a stale lock consequence.
The production-path PostgreSQL race harness exercises removal against move,
explicit auto-allocation, lifecycle reconciliation, cancellation, forced
delete/promotion/audit failures, and requested-room write versus room deletion;
the source contracts also pin approval and requested-room topology.

Bed-allocation mutation boundaries follow the same composition rule (#2593,
#2594, #2595).
The public lifecycle reconciler owns a transaction and takes global `lock(1)`
before resolving and taking the booking's immutable lodge lock; callers already
holding global use `reconcileBedAllocationsForBookingWithGlobalLockHeld`, and
callers holding both use the explicitly named lodge-lock-held seam. Room/bed
inventory update/delete, manual placement/range assignment, reviewed removal,
reviewed move, and approval similarly expose transaction-owning public wrappers plus narrow
`*WithLocksHeld` internals for existing transactions. A caller must never pass a
client into a public wrapper to bypass lock ownership. The explicit board
auto-allocation write takes global first, then the selected lodge lock, and
re-validates that the selected lodge is still active before rebuilding the
complete scoped dashboard and plan through that transaction client and
constructing any insert row. The authoritative under-lock rebuild
re-reads active rooms and beds (including their current lodge/type/bunk shape),
booking/guest nights and eligibility, existing and approved allocations,
whole-lodge holds, and custodian bed holds, so a visible preview is never itself
a write plan. The narrow booking and hold checks are then repeated immediately
beside `createMany` as defence in depth. The planner's per-lodge priority order
changes candidate choice but introduces no lock key and never weakens these
hard predicates.

Two write-path rules on the lifecycle apply come from #2656 and are about
occupancy, not locks. **An eviction releases a bed-night only when no occupant
remains on it**, which matters because a DOUBLE may hold two rows from two
different bookings (#1701): displacing one of them frees nothing, so the planner
never drafts a row for that bed and the apply never writes one. And
**`createMany({ skipDuplicates: true })` is not the safety mechanism.** Against
a surviving PRIMARY it silently swallows the row — a displacement applied and
audited for a placement that never happened — and against a surviving SECOND
occupant there is no duplicate to skip at all, so the row is created and an
unrelated person lands in a double beside someone else's partner. Both payload
writes therefore re-read the live occupancy of their target bed-nights on the
writing client and drop any row whose bed-night is still occupied — logging the
disagreement at error level, since the corrected planner should never produce
one.

That occupancy filter runs **before** the displacements are applied, and it
must. Its exclusion set is asserted in JS against the SOURCE bed of each
planned displacement rather than read back out of the database, so a bed the
plan is about to free already reads as free to it; running it afterwards left
the displacements committed when the filter then emptied the payload, so a
provisional booking was evicted, and audited as displaced "so a capacity-holding
booking could claim it", for an allocation that was never written. The
justification pass (`justifiedDisplacements`) therefore consumes the FILTERED
payload: a row dropped by ANY write-time re-check — unallocatable booking,
custodian hold, whole-lodge hold, or still-occupied bed-night — takes its
displacement down with it. The exclusion is keyed
`sourceBedId:bookingGuestId:stayDate` rather than by guest-night alone, because
a MOVEd row still exists at its NEW bed and a guest-night-only key would forgive
it there, making the MOVE's destination read as free. The same apply also
promotes any second occupant its displacements orphan, on the same client, so
the shared-double invariant `INV-CAP-031`
(docs/invariants/booking-dates-and-capacity.md) holds on this path like
every other.
`existingAllocations` is ordered `(stayDate, bedId, id)` for the same family of
reasons: the planner is pure and deterministic, so its input must be too, and
an unordered read returned a shared double's two rows in either order.

Cron/waitlist counterpart writers keep their guarded claims inside that same
topology. Completion and past-waitlist cancellation re-read each candidate
under global → lodge before the status claim and reconciliation. Cross-lodge
waitlist offer/confirm paths lock affected lodges in sorted order, re-read the
offer/version epoch, and only the winning guarded claim reconciles. A lost
claim performs no allocation side effect. This is why settings or planner
changes must still reconcile against the current writer matrix rather than
assuming a route-local plan is safe to apply.

### Global-cohort money / status transition → global `lock(1)`

Cancel (`booking-cancel.ts`), Stripe capture, the manual cash / off-Xero
mark-paid and its reversal, and the capacity-failed void
(`payment-reconciliation.ts`), the Internet-Banking hold-expiry release
(`internet-banking-payment-cron.ts`), the quote hold-release crons
(`cron-quote-expiry-reminders.ts`), the member-guest consent transitions
(`member-guest-consent-service.ts` — both the member/delegate approve-decline
path and the nightly expiry sweep `cron-member-guest-consent-expiry.ts`, because
a decline or a lapse reprices the booking, can elect account credit, AND releases
a bed, putting it in both cohorts), and the whole group-settlement lifecycle —
settle (`group-settlement.ts` `settleConfirmedChildrenAndNotify`), the reaper
(`cron-group-settlement-reaper.ts`), `markGroupSettlementIntentFailed` /
`markGroupSettlementIntentRefunded`, and the organiser-cancel FAILED claim
(`group-cancel.ts`) — **all take `lock(1)`**, so any two operations on the same
booking or settlement mutually exclude. The group-settlement paths in particular
MUST share `lock(1)`: before #1881 the settle path took a per-lodge (default
lodge) key while the reaper took `lock(1)`, so a settle could race a reap into an
inconsistent settlement/child state. `markGroupSettlementIntentFailed` also
initially skipped the lock; #1881 wrapped it in `lock(1)` to match this claim, so
it can no longer execute between a multi-statement settle transaction's own
statements. Note the FAILED mark and the settle path both leave `FAILED` OUT of
their status-guard `notIn` set BY DESIGN: a settlement marked `FAILED` by a
`payment_failed`/`payment_intent.canceled` webhook whose money is then genuinely
captured (`payment_intent.succeeded` → settle) must still become `SUCCEEDED`, so
settle legitimately overwrites `FAILED` → `SUCCEEDED`. `lock(1)` guarantees the
two run whole-before-whole; it is not a veto on that transition.

**#2700 adds one more, and it is the smallest participant in this cohort.**
`raiseDeletedBookingModificationRefundTask`
(`src/lib/deleted-booking-modification-payment.ts`) creates the OPEN
`ManualRefundTask` for a booking-modification payment Stripe captured against an
already-deleted booking (`INV-ADDPAY-036`). It is a settlement-money writer, so
it joins this cohort rather than minting a keyspace — and specifically the cohort
`booking-cancel.ts` is already in when IT creates a `ManualRefundTask`. It needs
the key because the write is a find-then-create, which is not atomic on its own:
two simultaneous confirms of one capture would otherwise raise two OPEN tasks,
and two operators would refund one payment twice. It takes `lock(1)` and
**nothing else**, holds it across a duplicate-task check, a refund-fence read
and the create, joins no capacity or member-credit tier, and every Stripe call
on that path is made by its caller outside the transaction — so it composes with
nothing and reverses no order.

The middle read is a **refund fence**, and it is why the read must be inside
this lock rather than beside it. The transaction row for this intent is re-read
under the key and the raise is skipped when Stripe has already refunded the
capture — `refundedAmountCents >= amountCents`, which is the field that survives
`markPaymentIntentTransactionSucceeded` writing `SUCCEEDED` back over a
`REFUNDED` status. Read outside the lock it would be stale exactly in the
interleaving it exists to catch: a webhook refund committing between the check
and the create.

Its counterpart writer is the **second `lock(1)` site in that file, and it did
not used to take a lock at all** — read this before assuming the webhook path
holds nothing. Until #2760 it was
`closeDeletedBookingModificationRefundTaskAfterAutomaticRefund`, a status-fenced
`updateMany` on `OPEN`, which is its own claim and needs no key: a webhook
replay, or an operator who closed the task first, simply claimed nothing. That
close covered only one ordering — a webhook arriving after the task exists — so
on every other ordering the automatic refund left no row at all.

It is now `recordAutomaticCancelledBookingRefundTask`, which **closes or
creates**, and that is a find-then-write rather than a single fenced statement.
Two Stripe deliveries of one capture, or a delivery racing the raise above,
would each see no row and each write one. So it takes `pg_advisory_xact_lock(1)`
— joining this cohort rather than minting a keyspace, the same key the raise
above and `booking-cancel.ts` take when they create a `ManualRefundTask` — and
**nothing else**, holding it across an `updateMany`, a `findFirst` and at most
one `create`. No provider call happens inside it: the Stripe refund that
triggers it has already returned before it is called, and the caller re-reads
`Booking.deletedAt` outside the transaction. It composes with nothing and
reverses no order.

**Its budget is `{ maxWait: 5_000, timeout: 10_000 }`, and this is the cohort's
only webhook-triggered participant, which is why the number differs from the
admin precedent.** The advisory wait counts against the interactive-transaction
budget, so Prisma's 2s/5s default is not survivable here: the longest-lived
holder of `lock(1)` in the tree is `assignBedRange`, which runs on
`{ maxWait: 10_000, timeout: 30_000 }` for a range write of up to 366 nights, so
an admin assigning a bed range concurrently with a Stripe delivery would blow a
defaulted budget with a `P2028`. Copying the admin precedent is the wrong fix in
the other direction — a webhook has Stripe's own delivery timeout over it, and a
handler that sits on a lock for 30s trades a lost row for a lost delivery. The
caller must answer 200 (the money is already back with the member, and a 500
replays the whole refund path for a bookkeeping row), so Stripe never
redelivers: a failure here is unrecoverable, and its caller therefore writes a
`critical` `booking.payment.auto_refund_record_failed` audit row rather than
only logging. See `INV-ADDPAY-037`.

**TWO CALLERS SINCE #2773, AND THAT CHANGES THE COHORT'S FOOTPRINT RATHER THAN ITS
SHAPE.** `handleCancelledBookingPaymentSucceeded` — the late-capture handler for a
booking's OWN payment — now goes through the same writer as its booking-change
sibling, via the shared epilogue in
`src/lib/cancelled-booking-late-capture.ts::recordAutomaticLateCaptureRefund`. Same
key, same budget, same single-key acquisition, no new tier and no new ordering: the
only difference is that one more Stripe event type can now be the thing waiting on
`lock(1)`. Both callers make every provider call outside the transaction, and both
re-read `Booking.deletedAt` outside it.

**AND ONE READ THAT IS DELIBERATELY OUTSIDE EVERY LOCK (#2774,
`INV-ADDPAY-039`).** Before refunding, both handlers call
`findCompletedHandBackForLateCapture` — a single unlocked `findFirst` for a
`COMPLETED` `ManualRefundTask` on this capture, which means an operator has already
paid the member back by hand and refunding again would pay them twice. It takes no
lock, and it CANNOT be made to close its own window: `resolveManualRefundTask` (the
hand-completion) holds no advisory key either, so serialising them would require the
webhook to hold `lock(1)` across the Stripe refund round trip — the bounded-exception
rule in this document forbids exactly that. So the fence is documented as a
**window-narrowing** guard rather than a mutual exclusion: it shrinks the exposure
from the hours or days the task can sit `OPEN` to the duration of one Stripe call,
and the residue is detected afterwards by the locked `findFirst` inside
`recordAutomaticCancelledBookingRefundTask`, which reports
`existingStatus: COMPLETED` and is escalated to a `critical` audit row and an alert.
The fence read is NOT wrapped in a catch: a read that cannot answer must not be
turned into either answer, so the rejection reaches the webhook's outer catch, the
processed-event marker is cleared and Stripe redelivers against the same idempotent
refund keys.

Note what `softDeleteCancelledBooking` does NOT do here. It cancels the deleted
booking's in-flight Stripe PaymentIntents **after** its transaction commits,
never inside it, so no provider round trip happens while `lock(1)` is held and a
provider timeout cannot roll back a committed deletion. That ordering is the
bounded-exception rule applied rather than waived.

#### Three-tier composition: global → lodge → member-credit (#2262)

The manual mark-paid path in `payment-reconciliation.ts` is the settlement body's
second entry point, and it derives its own settlement amount from the member's
credit ledger rather than accepting one from a client. Credit writers serialise
on the per-member `member-credit` key, **not** on `lock(1)`, so the path composes
a third tier — `lock(1)` → `acquireLodgeCapacityLock(lodgeId)` →
`lockMemberCreditLedger(memberId)` — taking them in exactly that order and
deriving `effectiveAmountCents = finalPriceCents - appliedCredit` only once all
three are held. This is the same composition (and the same order)
`switch-to-internet-banking` uses, which likewise refuses to rely on other
writers happening to hold `lock(1)`. The reversal takes the first two tiers only:
it writes no amount and reads no credit ledger, but it does restore booking
status and can release capacity.

`lock(1)` also serialises the duplicate-capture adjudication (#1992). When a
Stripe success arrives for an already-PAID booking, `markBookingPaymentSucceeded`
refunds the arriving capture only if it is a DIFFERENT intent from a captured
PRIMARY transaction still holding net cash, AND no duplicate-capture refund
operation (`duplicate_capture_<bookingId>_<pi>`) already exists for the booking
against another intent. That check-then-enqueue is race-free only because every
caller runs it under `lock(1)`: interleaved webhook replays of BOTH captures
would otherwise refund both sides and settle the booking at zero net cash. The
refund itself follows the #1349 enqueue-then-execute shape — the durable
operation (with the slice pinned to the duplicate's own transaction) commits
with the detection, and the Stripe refund executes after commit under the
shared `duplicate_capture_refund_<bookingId>_<pi>` key prefix the recovery cron
replays. Relatedly, the auto-charge cron's pre-charge sweep that cancels
superseded /pay link intents (#1992 Option 1) is a plain Stripe call strictly
OUTSIDE any transaction, after the claim commit: the claim's link revocation
under the lodge lock freezes the set of link intents, and the sweep excludes the
cron's own `pending_hold_auto_charge` transactions because Stripe's shared
`pending_charge_<bookingId>` idempotency key re-returns a prior run's intent.

Organiser cancellation adds a durable veto before it releases the lock:
`group-cancel.ts` writes `GroupBooking.status = CANCELLED` under `lock(1)`
before voiding/refunding Stripe or cancelling children. Settlement apply
re-reads that group status under the same lock and returns `cancelled` without
writing Payments or promoting children. Therefore either settlement wins first
and cancellation observes `SUCCEEDED`/`PAID` and refunds it, or cancellation
wins first and every later capture is refused; a late Stripe capture follows
the deterministic superseded-intent refund path, while a paid Xero invoice is
left unapplied and raises an operator refund alert. Provider calls remain
outside the transaction. Per-child cancellation is also a status-guarded claim,
so a stale child snapshot can never overwrite a terminal transition.

### Writer doing both → `lock(1)` first, then per-lodge

The Stripe capture (`markBookingPaymentSucceeded`), the confirm-pending-guests
zero-dollar and charge branches, the waitlist-confirm $0 PAID claim, the admin
return-to-waitlist repair (#2649), the
switch-to-internet-banking hold, the quote-accept conversion
(`approveBookingRequest`), and every booking modification service
(batch/date/guest-removal) take **`lock(1)` first, then the per-lodge lock**.
`xero-inbound/invoice-paid-effects.ts` is the in-tree precedent for this
composition.

Generic quote acceptance pre-reads only the held booking's immutable concrete
`lodgeId`, then takes global -> that lodge and fully re-reads both request and
hold. It rejects an explicit request/hold lodge mismatch and carries the same
concrete lodge into policy and email context. A null request lodge is never
re-resolved through a default that may have changed after hold creation.

Both held-conversion claims fence optimistically on the request's integer
`BookingRequest.version` (`version: request.version` in the claim `updateMany`
WHERE, mirrored by a JS re-read comparison), not on `updatedAt` (#1923). Every
mutating write of a `BookingRequest` bumps `version: { increment: 1 }`, so a
writer that lands after the converter's locked re-read invalidates the stale
claim. `updatedAt` is `TIMESTAMP(3)` (millisecond precision): two writes in the
same millisecond share a timestamp and would silently defeat a `updatedAt` CAS,
which the integer counter cannot.

School approval has two deliberately different branches. Fresh-create is a
capacity-only admission and takes only the per-lodge lock. Held-reuse converts
an existing AWAITING_REVIEW booking that cancellation/release may claim, so it
takes **global first, then per-lodge**, re-reads the request and hold under both,
and uses a status-guarded `AWAITING_REVIEW -> CONFIRMED` claim before side
effects. A lost claim aborts the transaction.

The linked provisional-child sweep after a parent cancellation follows the
same order. It uses the child's immutable `lodgeId` only to select the lock,
then re-reads the child and conditionally claims `PENDING -> CANCELLED` under
both locks. `cron-confirm-pending` shares the per-lodge lock, so either the
cancel wins and alone runs cancellation side effects, or the cron's confirmed /
charged state survives and the stale sweep runs no side effect.

`switch-to-internet-banking` also recomputes both the locked booking price and
the authoritative `BOOKING_APPLIED` credit aggregate after acquiring global,
lodge, then `lockMemberCreditLedger(memberId)` locks in that order;
the IB payment mirror must never mix a pre-lock price with post-lock credit (or
vice versa). Waitlist offer confirmation resolves only the immutable lodge key
before locking, then re-reads status and expiry under the lodge lock and fuses
those checks with its update. The expiry reaper returns side effects only for
rows whose guarded revert/cancel actually claimed one row.

#### A compensating transaction gets its own budget, its own guard, and an operator door (#2623)

`POST /api/bookings/[id]/waitlist-confirm` is a **two-phase** writer whose two
phases commit separately, and the seam between them is where #2623 T4 lived.
Phase one (`confirmWaitlistOffer`) commits in its own transaction: it nulls
`waitlistOfferedAt`/`waitlistOfferExpiresAt`/`waitlistPosition` and moves the
booking to `PAYMENT_PENDING`. **From that commit the offer no longer exists.**
Phase two — the $0 `PAYMENT_PENDING -> PAID` claim — then takes global `lock(1)`
and the per-lodge lock afresh, so it can lose those locks or hit the participant
`FOR KEY SHARE NOWAIT` fence and roll back. A $0 booking left in
`PAYMENT_PENDING` holds no capacity, has no payment path and has no offer to
replay, so phase two's rollback MUST be compensated by releasing the booking
back to `WAITLISTED` for the ordinary offer worker.

That compensation is itself a `lock(1)` -> per-lodge transaction, and it runs at
the moment contention is by definition highest — the thing that triggered it is
lock contention. On Prisma's defaults (2s `maxWait`, 5s `timeout`) it was
therefore the likeliest step in the route to fail, and it ran **unguarded inside
the `catch`**: its own failure replaced the mapped retry with an unhandled 500
*and* left the booking parked with a consumed offer. Three rules came out of it,
and they generalise to any compensating transaction in this codebase:

1. **Explicit budgets, sized for who is waiting.** The release runs on `maxWait`
   5s / `timeout` 10s, not the interactive defaults: a compensation that inherits
   the defaults is tuned for the quiet case and fails in the only case it exists
   for. It is deliberately *tighter* than the admin precedents (`saveClubTheme`
   10s/15s, `assignBedRange` 10s/30s) because a **member** is watching this
   request — two attempts cap the visible wait near 30s. Raising it further would
   buy little: the longest-lived holder of global `lock(1)` in the tree is
   `assignBedRange` itself (`bed-allocation-range-assign.ts`, whose `runAttempt`
   takes `lock(1)` inside a `timeout: 30_000` transaction), so a budget that
   always beat the worst
   contender would mean a member waiting a minute for a failure they cannot act
   on. Rules 2 and 3 exist instead of a bigger number.
2. **Bounded retry, then a guard that cannot throw.** One retry on P2028/P2034,
   then the outcome is returned as data. A compensation is never allowed to
   throw past the handler and become the response.
3. **Every outcome is a distinct, mapped answer.** Contention maps to **503**
   (the settled convention — see `admin/site-style/route.ts` and
   `admin-bed-allocation-routes.ts`); anything else to 500; and the compensation
   succeeding maps to the participant fence's frozen 409 or a coded 409/503.
   Every one of them carries `offerRevoked: true`
   (`src/lib/waitlist-confirm-recovery-contract.ts`), because the client cannot
   distinguish a *phase-one* refusal — offer intact, retry genuinely available —
   from a *phase-two* refusal on the shared error code alone, and it previously
   invited a second click on an offer that had already been consumed.

The status guard on the release (`updateMany where status: PAYMENT_PENDING`) does
double duty: it makes the release safe to retry, and it makes a phase two that in
fact committed (a commit whose acknowledgement was lost) match no row, so nothing
is undone. `restored.count === 0` is therefore reported as
`bookingStatusUnconfirmed`, never as "your place was restored".

**When the compensation cannot run at all, the state is operator-only** — no cron
sweeps `PAYMENT_PENDING`, and the member has nothing to retry. That is the one
outcome in this route that gets an operator door rather than a self-healing path:
a `critical` / `failure` `AuditLog` row with action
`waitlist.confirm_offer_release_failed` (filterable by action, category and
severity in Admin -> Audit log, carrying the lodge, the stay, and both error
codes) plus a `logger.error` for Sentry, and member copy that names the state
instead of inviting a retry. Swallowing it would have been the worse failure:
silent, unsearchable, and indistinguishable from a booking the member abandoned.

That row is written with an AWAITED `createAuditLog` rather than fire-and-forget
`logAudit`, since #2649 made it the admin repair's entry condition: the repair
refuses any booking without an unresolved report, so a report lost to process
teardown would leave a genuinely stranded member repairable only from a database
session — the thing #2649 exists to remove. The `.catch` guard keeps the previous
failure semantics exactly (a failed write is logged, and the operator-door
response is still returned), and the census manifest records the sink move: this
is the case where `writeSites` does not change at all because one sink loses a
site and another gains one, which is why the per-sink pins exist.

Since #2649 that operator door is a button rather than a database session.
`POST /api/admin/bookings/[id]/return-to-waitlist` (`bookings: edit`, `waitlist`
module) is a fourth `PAYMENT_PENDING -> WAITLISTED` writer and takes the same
protocol as the three that precede it: global `lock(1)`, then the booking's own
immutable lodge capacity key, then a re-read of everything mutable, then a
status-guarded `updateMany` that re-asserts BOTH `status: PAYMENT_PENDING` and
`finalPriceCents: 0` — so a concurrent re-price cannot turn a repair into an
un-confirm of a priced booking. A lost claim `return`s above the allocation
reconcile and above the audit row, and the post-commit block runs on the success
shape only, so the member email and `processWaitlistForDates` cannot fire on a
claim that wrote nothing.

**Why this writer needs the lodge tier at all, since `PAYMENT_PENDING` does not
hold capacity.** It is not a capacity release. `PAYMENT_PENDING` is
BED-ALLOCATABLE (`bed-allocation-lifecycle.ts`) and `WAITLISTED` is not, so the
transition prunes real `BedAllocation` rows through the lock-held lifecycle seam
and must serialise against every per-lodge allocation writer. Capacity is a
separate question, and `booking-status.ts` is the authority on it: a
`PAYMENT_PENDING` booking holds capacity only while `adminCapacityHoldAt` is set
(#1764). Say "bed-allocatable, not capacity-holding" when reasoning about whether
a writer on this status needs the lodge key — the answer is yes either way, but
for the allocation reason, not a capacity one.

That admin hold is itself part of the transition. An officer may set one on any
`PAYMENT_PENDING` booking from the same Admin tools card
(`capacity-hold/route.ts`), so "hold the nights, then repair" is a plausible
order; the claim therefore spreads `RELEASE_ADMIN_CAPACITY_HOLD_UPDATE` and
`RELEASE_WHOLE_LODGE_HOLD_UPDATE` like every other release in the tree and names
what it released in its audit metadata, with the confirmation dialog stating the
consequence before the press. Left in place the flag would be inert at
`WAITLISTED` (enforcement is status-scoped) and then silently RE-ARM under a
different episode's admin and date the moment the booking was re-offered and
confirmed back — with an exclusive hold, re-blocking the whole lodge.

**The guard is provenance, not shape.** `PAYMENT_PENDING` + `finalPriceCents: 0`
+ no `Payment` row is NOT "the stranded shape": **six** other producers reach it,
none of them a waitlist confirmation.

1. The `20260511113000` backfill migration — no price predicate and no "has a
   payment row at all" predicate, and the companion promote migration only
   touches rows that DO have a `SUCCEEDED` payment, so nothing cleans the
   residue up. Its production yield is bounded, though, and the bound is worth
   stating rather than overclaiming: `20260408070000_fix_zero_dollar_confirmed_bookings`
   had already, a month earlier, minted a $0 `SUCCEEDED` payment for every
   `CONFIRMED` free booking that lacked one and promoted it to `PAID`. So the
   rows this backfill can have left in the shape are those created in the window
   between the two migrations — a real class, not a hypothetical one, but not
   "every legacy free booking" either.
2. `modifyBookingDates` — its $0 auto-settle is nested inside
   `if (appliedBeforeClamp > 0)`, so a date change that reprices to zero with NO
   credit applied never reaches the payment upsert. Its sibling
   `booking-modify-settlement.ts` computes `effectivePriceCents` OUTSIDE the
   credit gate and settles the same case to `PAID`, which is what makes this a
   defect rather than a policy.
3. `adminShiftBookingDates` — no $0 settle at all, releasing a free `PENDING`
   non-member hold with every price field left as booked.
4. An admin review approval (`admin/bookings/[id]/review/route.ts`) — no price
   check, and `booking-create.ts` deliberately skips the $0 auto-`PAID` settle
   under `review.blockForReview`, so the booking it releases provably has no
   payment row.
5. The group settlement reaper — a price-blind `CONFIRMED -> PAYMENT_PENDING`
   revert of a never-billed `ORGANISER_PAYS` child.
6. A guest ADD releasing a free `PENDING` non-member hold
   (`bookings/[id]/guests/route.ts`), which mints no payment.

Two near-misses were checked and **refuted**, and are named so the next reader
does not re-add them: guest REMOVAL settles the same case to `PAID` (it reaches
the un-nested settle, because no caller can supply the `ADMIN` actor role its
skip arm needs), and the guest-add route's own
`AWAITING_REVIEW -> PAYMENT_PENDING` arm is unreachable, because an earlier
status gate in the same handler admits only
`PENDING`/`PAYMENT_PENDING`/`CONFIRMED`/`PAID`.

So the route requires an UNRESOLVED
`waitlist.confirm_offer_release_failed` report on the booking
(`findUnresolvedWaitlistStrandReport` in `waitlist-return-contract.ts`), read
under the locks and above the claim, and refuses in plain words when there is
none. "Unresolved" means the newest of that action and
`waitlist.returned_to_waitlist` is the strand rather than the repair: a strand
report is permanent, so without the resolution test a booking that was stranded,
repaired, successfully re-confirmed and later repriced to zero would look
eligible again on a closed incident. The booking row itself carries no waitlist
provenance to read — `confirmWaitlistOffer`'s phase-one claim nulls
`waitlistPosition`, `waitlistOfferedAt` and `waitlistOfferExpiresAt` before a
strand can exist, and `waitlistOfferedLodgeId`/`waitlistOfferedPriceCents` are
set only on the cross-lodge path, which never parks in `PAYMENT_PENDING`.

`waitlist.returned_to_waitlist` therefore carries the id and timestamp of the
strand report it resolves — the row that PROVED eligibility, and which already
holds the lodge, the stay, the price and both error codes — rather than a
snapshot of the four offer columns the claim nulls. Those four are already null
on every reachable strand, for the reason just given, so snapshotting them
recorded four nulls and presented them as evidence.

The post-commit sweep is keyed on `Booking.lodgeId`, **not**
`waitlistOfferedLodgeId`, and this is where it deliberately differs from
`expireStaleOffers`. That path's entry is still `WAITLIST_OFFERED` and holds a
bed at the OFFERED lodge, so the offered lodge is what its revert frees. Here the
lodge key held above, the allocations the reconcile prunes, and any admin hold
released are all `Booking.lodgeId`. Sweeping the offered lodge instead would
process a queue this repair freed nothing at while leaving the nights it did free
unoffered. (The mutable re-read no longer selects `waitlistOfferedLodgeId` at
all, so there is nothing to key off by mistake.)

Its own contention maps to 503 with a retry sentence, not to an opaque 500 — the
same P2028/P2034 set and the same reasoning as the compensation it finishes.
A repair that exists because a lock wait was exhausted must not report its own
exhausted lock wait as "the repair is broken". For the same reason it does not
run on Prisma's 2s/5s defaults, against which the advisory wait counts: it takes
the ADMIN precedent, `{ maxWait: 10_000, timeout: 30_000 }`, matching
`assignBedRange` — the longest-lived holder of `lock(1)` in the tree — rather
than the tighter member budget the compensation uses because a member is watching
that request. It does no adult-member-hosting-coverage work, matching the two
releases above it exactly; whether any of the three should is tracked as its own
decision rather than answered differently for one of them.

One residual window is accepted deliberately: the post-phase-one
`booking.findUnique` that decides whether the $0 branch applies is not itself
compensated. A failure there means the database is unreachable, in which case no
compensating write and no audit row are possible either — the honest answer is
the 500 and the Sentry/health-check path, not a compensation that cannot commit.

`waitlist-confirm-hosting-retry.test.ts` pins all of it, including a compensation
that fails both attempts (503 + the audit row, never a 500) and a contended
compensation that succeeds on the retry.

Because a lost claim `return`s — which **commits** the transaction rather than
rolling it back — the $0 `Payment` row is created strictly *after* the
`PAYMENT_PENDING -> PAID` claim succeeds. `Payment.bookingId` is unique, so a
`SUCCEEDED` $0 row committed onto a booking that never reached `PAID` would both
read as paid and permanently block that booking's real payment row. The general
rule: inside a `$transaction` callback, only `throw` rolls back — a guard that
`return`s must have written nothing it does not want committed.

Group-settlement initiation selects/rejects `GroupBooking.CANCELLED` at entry
and re-checks the durable fence under global `lock(1)` before taking child-lodge
locks or proceeding to either the Stripe or Internet Banking provider path. A
cancelled group cannot mint a fresh PaymentIntent or enqueue a new combined
invoice.

Combined Xero invoice cancellation is a durable compensating workflow. Once an
invoice id is persisted, the same global cancellation fence atomically enqueues
a `GROUP_SETTLEMENT_INVOICE_VOID` outbox UPDATE with an invoice-specific
correlation/idempotency key; this remains replayable even when the original
invoice CREATE operation already succeeded. The create worker does the same if
cancellation wins while `createInvoices` is in flight. To close the otherwise
unavoidable last-check-to-email gap, only the single bounded Xero `emailInvoice`
call spans `lock(1)`: cancellation either commits first (email suppressed, VOID
queued) or waits until the email call finishes and then commits its VOID debt.
No invoice construction, contact lookup, create, or VOID provider call is held
inside that transaction.

The opt-in PostgreSQL race harness is wired into the migration-drift job against
its own `postgres:16-alpine` service on loopback port `55442`, database
`concurrency_race_1881`. Its dedicated-URL, loopback, high-port, and name-marker
guards remain mandatory; ordinary application databases are never valid targets.
Alongside scratch-table lock/CAS probes, the harness seeds the migrated
application schema and races the real group-settlement failure writer against a
locked PaymentIntent re-point, proving a stale webhook cannot fail the new
settlement attempt. It also exercises trusted induction baselining through
separate PostgreSQL connections: the baseline's `SHARE ROW EXCLUSIVE` table lock
holds an ordinary `MemberInduction` insert until commit, and an already-open
ordinary writer makes the baseline wait and then re-read the committed workflow
before refusing to apply. Further probes prove a real database failure during
the post-create audit rolls back both baseline rows and audit, while concurrent
baseline applies serialize into one inserted set and one no-op. These probes are
still opt-in; without the explicit flag the suite runs only its URL safety
guards and never imports or connects Prisma.

### Member-night guard → per-member lock, ACROSS lodges

"A member cannot hold two bookings covering the same night" is enforced by
`assertNoBookingMemberNightConflicts` (`booking-member-night-conflicts.ts`). This
invariant **spans lodges** — the guard query deliberately ignores `lodgeId` — but
capacity claims serialise only per lodge, so two concurrent writers for the same
member at *different* lodges hold different capacity locks and would both pass
the guard. The authoritative assert therefore takes a **per-member advisory lock
for every member-linked guest, in sorted `memberId` order, BEFORE reading**
(`lockBookingMemberNights`). Callers take it after their per-lodge lock, giving a
consistent lodge → member-night order. The advisory (non-authoritative)
`findBookingMemberNightConflicts` pre-check (used by the request-linking UI)
deliberately does NOT lock. `review-findings-contracts.test.ts` freezes that
every same-transaction member-linked guest writer takes the per-lodge lock before
the guard, and that the guard self-takes the per-member lock.

## Capacity: who claims, who releases, under which lock

Capacity is **per lodge** ("beds available on date D at lodge L"; no path sums
across lodges). Claims take the per-lodge lock keyed on the booking's own lodge.
Releases (freeing beds) can never overbook — the worst case of a release not
serialising against a claim is a momentarily conservative capacity view that
self-corrects — but a release that also flips booking status or moves money
(cancel, hold-expiry) takes `lock(1)` for the status/money reason, not the
capacity reason.

### Provisional reservations for held policy-exception requests (#2365)

A held `POLICY_EXCEPTION` `BookingChangeRequest` (see `docs/STATE_MACHINES.md` →
"Booking-policy exception requests") reserves capacity so an eventual approval is
guaranteed to fit: it reserves the incremental beds beyond the unchanged live
booking when that booking is capacity-holding, or the FULL proposed footprint
when the base is **not** capacity-holding (a DRAFT / generic PENDING / un-held
PAYMENT_PENDING / WAITLISTED / BUMPED booking — all editable per
`getBookingEditPolicy` yet outside `capacityHoldingBookingFilter`, so their beds
are not counted for a delta to sit atop) (`computeProposalReservation`,
`src/lib/booking-exception-requests.ts`). It never writes a hold larger than the
lodge's real headroom — the create path runs an admission check under the lodge
lock and refuses an over-capacity hold rather than parking phantom beds. The
reservation ledger keys to a
`BookingChangeRequest` (`PolicyExceptionReservationNight.changeRequestId`), so it
holds **modification** requests. New-booking requests live in the separate
`NewBookingPolicyExceptionRequest` table (#2524's dedicated-table decision) and
do **not** yet hold a provisional reservation — their approval-time capacity
recheck (the NO_HOLD path) is what prevents overbooking until the new-booking
executor and its reservation shape land with the admin approval route (#2526).
`computeProposalReservation` already returns the FULL proposal for a `NEW_BOOKING`
snapshot, so wiring that hold later is additive.

Since #2526 the approval algorithm itself is table-agnostic: it takes a
`PolicyExceptionRequestStore` (`booking-exception-execution.ts`) with a
modification implementation and a new-booking one, and the two share every
concurrency-relevant step — the same pre-read-for-the-lock, the same global →
per-lodge order, the same fresh-role reauthorization, the same guarded `version`
CAS, the same drift gate, the same capacity recheck and the same post-commit
ordering. The new-booking store's `releaseReservation` is a deliberate no-op
returning 0, because that flavour holds no beds; its safety comes from the
approval's own capacity recheck plus the canonical create service's HARD refusal
(`createConfirmedBooking`'s `capacityExceeded` outcome is thrown by
`booking-exception-approval.ts`, which aborts the transaction rather than
committing a claim with no booking behind it). Factoring the store out — rather
than copying the algorithm per table — is what keeps the two flavours from
drifting apart on any of those steps. The binding lock contract every writer
follows:

- **No new advisory-lock family.** A reservation write or release, and the
  approval that turns a reservation into the executed booking, is a capacity and
  (for a modification) money/status transition on a booking, so it composes the
  EXISTING keys in the house order — global `lock(1)` first, then
  `acquireLodgeCapacityLock(tx, lodgeId)`, then the member-night guard's
  per-member key and `lockMemberCreditLedger(memberId, tx)` when credit is
  composed. It introduces no `pg_advisory_xact_lock` **key** of its own, so no new
  key family joins the `advisory-lock-guard.test.ts` inventories — only two
  classified global-`lock(1)` **sites** compose the existing key
  (`booking-exception-request-service.ts` for the request-hold reservation and
  `booking-exception-execution.ts` for the approval / terminal release), each
  minting the key once through a private `acquireGlobalBookingLock` helper.
- **Reservations count as occupancy under the per-lodge lock.** The canonical
  per-night capacity calculation (`capacity.ts`) must count a held request's
  active reservation alongside `capacityHoldingBookingFilter()` bookings, read
  under the per-lodge capacity lock on the booking's own lodge (read-key → lock →
  re-read). A held request never overbooks because the reservation is claimed
  under that same lock.
- **Release is atomic with the terminal transition.** `REJECTED`, `CANCELLED`
  and `SUPERSEDED` release the reservation in the SAME guarded transaction that
  writes the status; a lost `updateMany` claim on `status = REQUESTED` (with the
  integer `version` token) runs no release and no side effect. An `APPROVED`
  request does not "release then create" — the reservation becomes the executed
  booking's own beds inside one transaction, with the canonical booking service
  invoked transaction-aware so there is no mark-approved-then-call gap.
- **NO_HOLD approval rechecks capacity and keeps pending on conflict.** When the
  frozen aggregate is `NO_HOLD` (nothing was reserved), the approval rechecks
  capacity under the per-lodge lock BEFORE the claim; a conflict keeps the request
  `REQUESTED` with a recorded `lastConflictReason` (it does not fail it), so a
  later retry can still succeed.
- **HOLD approval also rechecks capacity — after releasing its own hold.** A HOLD
  request holds its own beds, so the engine cannot recheck it before the claim
  (its own reservation would count against it). Instead it claims, releases the
  reservation, then rechecks under the same lock; if the lodge no longer fits, it
  throws an internal rollback signal that undoes the whole approval (claim +
  release) and surfaces `keptPendingCapacity`, leaving the request `REQUESTED` and
  pending rather than executing an overbooking. The engine asserts capacity itself
  and never relies on the executor seam being a hard refusal.
- **A MODIFICATION approval fails closed without a live-integrity check.** The
  optional `verifyLiveProposalIntegrity` hook is the ONLY gate comparing a
  modification's frozen `base` against the live booking; the tamper hash covers
  only the frozen snapshot. If a `MODIFICATION` reaches the engine without that
  hook it throws `PolicyExceptionIntegrityHookMissingError` (a wiring bug, fail
  loud) rather than executing against a possibly-stale base. New-booking snapshots
  have no live base to drift and legitimately run without it.

The live reservation writer, its `capacity.ts` integration and the transaction-
aware canonical execution are the #2365 execution lane, **built in #2525**. The
wiring, checked against the contract above:

- **Reservation store** — `PolicyExceptionReservationNight`
  (`src/lib/booking-exception-reservations.ts`): one row per held
  `(changeRequestId, night)`, carrying the denormalised `lodgeId` and bed count.
  There is **no `active` flag**: a row exists IFF the request is currently holding
  that night, so release is a `deleteMany` and the capacity read is a plain sum of
  the rows that still exist. `reservePolicyExceptionCapacity` writes the footprint
  (upsert per night, idempotent on the unique key);
  `releasePolicyExceptionReservation` deletes it;
  `buildLodgePolicyExceptionReservationCounter` is the per-night counter added to
  `occupiedBeds` **exactly as the custodian counter is**. Since #2681 it is called
  in exactly one place — `computeNightOccupancy()` in `capacity.ts` — which the
  four capacity engines (`checkCapacity`, `checkCapacityForGuestRanges`,
  `checkCapacityForPartnerSharedAdmission`, `getMonthAvailability`), the
  capacity-warnings cron and the custodian bed-hold write path all read through.
  The lock topology is unchanged — no lock key, acquisition site or acquisition
  order moved, and no read left a lock. Which of those six readers is *under* a
  lock differs, and always did: the three admission engines
  (`checkCapacity`, `checkCapacityForGuestRanges`,
  `checkCapacityForPartnerSharedAdmission`) and the custodian bed-hold write path
  read on the caller's transaction client, so the reservation is still read inside
  the same per-lodge capacity lock the claim is written under;
  `getMonthAvailability` and the capacity-warnings cron read unlocked on bare
  `prisma`, exactly as both did before, because both only display or warn and
  neither admits anyone. Before #2681 the cron and the custodian write path had
  their own occupancy copies and neither counted this term at all — so the
  custodian write path, which does hold the lock, gains one read inside it.
- **Request-hold writer (#2524 service, wired in #2525's integration)** —
  `createModificationExceptionRequest`
  (`booking-exception-request-service.ts`) reserves the incremental hold for a
  `HOLD`-aggregate modification request inside its creation transaction, under
  global `lock(1)` → per-lodge lock, keyed on the new request id. A `NO_HOLD`
  aggregate reserves nothing (the approval rechecks capacity instead), and a
  modification whose footprint does not grow reserves nothing (the live booking
  already holds those beds). The member-owned terminal transitions in the same
  service release atomically under the same lock order:
  `cancelModificationExceptionRequest` (pre-reads the frozen lodge, guarded
  member/booking claim, then `releasePolicyExceptionReservation`) and the
  supersede branch of `createModificationExceptionRequest` (releases the prior
  request's hold before reserving the replacement). A lost claim releases and
  reserves nothing.
- **Abandoned-hold reaper (#2553)** — `reapExpiredPolicyExceptionHolds`
  (`src/lib/cron-policy-exception-hold-reaper.ts`, in the three-hourly general
  cycle) mints **no lock of its own**: it scans candidates outside any
  transaction, then calls `resolvePolicyExceptionRequestTerminal` with
  `to: "EXPIRED"` per request, which takes global `lock(1)` → per-lodge lock and
  makes the guarded `version` claim exactly as the reject/cancel/supersede paths
  do. That is deliberate — a second release implementation, or a job-level lock
  layered on top, would be a new way for the release to drift from the three that
  already work. Concurrency safety therefore rests on the same `version` CAS every
  other transition uses: a decision landing between the scan and the claim wins,
  the reaper's claim matches 0 rows, and it releases nothing. Two overlapping cron
  cycles over the same request produce exactly one expiry and one release, so beds
  can never be credited back twice. The scan is additionally narrowed to requests
  that still have live `PolicyExceptionReservationNight` rows, so the cron's only
  possible effect is returning beds that are genuinely stranded. One consequence of
  leaning on a shared helper: `resolvePolicyExceptionRequestTerminal` returns
  `claimed: false` both for a lost claim and for a row it REFUSES before the claim
  (not a policy-exception row, or an unparsable `proposalSnapshot`), so it now
  reports which — a lost claim self-heals on the next scan, a refusal never does.
  The reaper counts refusals as `unresolvable` in `CronJobRun.resultSummary` and
  logs them at warn, so beds stranded by an unresolvable row surface instead of
  looking like a clean run forever. Its two side effects — the
  `booking-policy-exception-request.expired` audit row and the
  `policy-exception-request-expired` member notice (owner decision, 2 Aug 2026) —
  run only after that helper has returned a claimed outcome, i.e. after its
  transaction has committed and both locks are released, which is the repo rule on
  keeping provider calls outside a transaction. Each is wrapped so it cannot
  throw: a failed send has nothing to roll back and nothing to retry (the beds are
  already in the pool and the request is no longer `REQUESTED`, so a "retry" would
  be a second release), so it is logged and swallowed, `failed` keeps meaning the
  release itself failed, and the rest of the run's candidates are still processed.
- **Transaction-aware canonical services (#2525)** — `createConfirmedBooking`
  (`booking-create.ts`) and `modifyBookingBatch`
  (`booking-batch-modification-service.ts`) each now accept an optional caller
  `tx` via `withOptionalTransaction` (`src/lib/db-transaction.ts`). Standalone
  callers open a self-contained transaction and run their provider work inline,
  exactly as before; a caller that supplies `tx` runs the DB work in that
  transaction and receives a `deferredPostCommit` thunk so email / Xero / Stripe
  work fires strictly AFTER the caller commits. This is what removes the
  mark-approved-then-call-service gap.
- **Atomic approve-and-execute + terminal release**
  (`src/lib/booking-exception-execution.ts`): the approval pre-reads the immutable
  frozen `lodgeId`, then takes global `lock(1)` (one shared
  `acquireGlobalBookingLock` helper, so the advisory-lock inventory sees one site)
  and `acquireLodgeCapacityLock` — the canonical service re-enters the lodge lock
  and takes the member-night / member-credit keys after that, preserving
  global → lodge → member order. It reauthorizes from fresh DB roles, re-reads the
  request under the locks, runs the proposal-hash tamper gate and the
  `classifyPolicyExceptionDrift` gate, rechecks capacity for a NO_HOLD aggregate,
  claims `REQUESTED → APPROVED` with the integer `version` CAS, releases the
  reservation, and invokes the tx-aware canonical service — all in one
  transaction. A lost claim (stale version, or a losing `updateMany`) releases
  nothing and runs no side effect. `resolvePolicyExceptionRequestTerminal` is the
  reject/cancel/supersede sibling: the same global → lodge lock order and the same
  guarded `version` CAS, releasing the reservation atomically with the terminal
  status write.

Every one of these writers composes only the existing keys, so
`advisory-lock-guard.test.ts` gains two classified global-`lock(1)` sites
(`src/lib/booking-exception-request-service.ts` for the request-hold reservation
and `src/lib/booking-exception-execution.ts` for the approval / terminal release)
and no new key family.

### One-open-request slot for exception requests (#2524)

The request-CREATION lane (`booking-exception-request-service.ts`) enforces "at
most one open request per subject" **without any advisory lock** — it adds
nothing to the `advisory-lock-guard.test.ts` inventories. The mechanism is a
DB-enforced NULL-distinct unique column, `openStateKey`, present on both the new
`NewBookingPolicyExceptionRequest` table and the shared `BookingChangeRequest`:

- A `REQUESTED` row holds a deterministic slot value
  (`nbpe:{requestedByMemberId}:{proposalHash}` for a new booking,
  `pe:{bookingId}:{requestedByMemberId}` for a modification); every terminal
  transition NULLs it. PostgreSQL treats NULLs as distinct, so the unique index
  caps the subject at one open row and lets any number of terminal rows — and
  every `LOCKED_PERIOD` row, which never sets the slot — coexist. A losing
  concurrent create raises a `P2002` unique violation, which the service maps to
  a 409; it can never produce a second open row. This is the durable backstop
  behind the application-level open-request check, not a substitute for it.
- **Creation is transactional; the terminal transitions are guarded.** A create
  that supersedes an open request runs in one transaction: it first claims the
  old row `REQUESTED -> SUPERSEDED` (NULLing its slot) with a guarded
  `updateMany`, and only then inserts the replacement — so the new slot value is
  free and a lost claim (`count = 0`) creates NOTHING. Member cancel is the same
  guarded single transition on `status = REQUESTED`, scoped to the owner (and to
  `POLICY_EXCEPTION` on the shared table), with the integer `version` token
  bumped; a lost claim runs no side effect. No live booking is read or written on
  any of these paths.
- **The on-request notification is post-commit and fire-and-forget** — it is
  never awaited inside the request path and its failure is logged, so an alert
  outage cannot fail or roll back a member's request.

## Credit restoration: exactly-once is now STRUCTURAL (#1636)

`restoreCreditFromBooking` (`member-credit.ts`) restores a cancelled booking's
applied credit by inserting one `CANCELLATION_REFUND` row. As of **#1636 (landed)**
that row carries a **nullable-unique `restoredFromBookingId`**, and the insert
goes through `createMany({ skipDuplicates: true })` (`INSERT ... ON CONFLICT DO
NOTHING`). So **at most one restore row per booking can exist REGARDLESS of the
caller's lock granularity** — a duplicate inserts nothing and returns 0, never a
second credit, and never aborts the caller's transaction. This removed the old
cross-path dependence on all restore callers sharing `lock(1)`: moving a
credit-restoring path to a different lock can no longer double a restore.

Each restore caller still runs under `lock(1)` and its status-guarded claim
remains the *primary* single-flight (the claim, not a description string,
guarantees the surrounding side effects run once); the unique key is the
structural backstop underneath it. The Xero inbound applied-credit repair
(`xero-inbound/credit-note-repairs.ts`) takes the **per-member credit ledger
lock** (not `lock(1)`) so its `BOOKING_APPLIED` writes mutually exclude the
credit spend engine, which takes the same key. The orphan-heal repair
(`orphaned-applied-credit-backfill.ts`) also takes the per-member credit ledger
lock and re-derives an "already restored?" predicate.

### Send-bookkeeping on `Payment` → deliberately NO lock (#2350)

`Payment.additionalReminderSentAt` and `Payment.additionalFinalReminderSentAt`
are the only `Payment` columns written outside `lock(1)`. The two writers are
the additional-payment chase cron
(`src/lib/cron-additional-payment-reminders.ts`) and the admin re-send
(`src/lib/additional-payment-resend-service.ts`), and both write **only** those
two columns: no money, no status, no lifecycle. They record "this member has
been emailed about this obligation", so they join no lock cohort — taking
`lock(1)` would serialise a three-hourly mailer behind every cancel, capture and
settlement in the system for no invariant.

Single-flight comes from the guarded `updateMany` instead: the claim re-states
the full owed test (booking status included), pins the exact
`additionalAmountCents`, requires no ADDITIONAL `PaymentTransaction` newer than
the episode being chased, and requires the stamp to be unset for that episode.
Two runners racing therefore leave one winner, and a money writer landing in the
read→claim window makes the claim match nothing rather than producing an email
about a stale obligation. Nothing else reads these columns for a money decision,
so a stamp written concurrently with a locked money write cannot corrupt one.

## Membership cancellation credit notes: one per INVOICE, structurally (#2400)

`createXeroMembershipCancellationCreditNote`
(`membership-cancellation-xero.ts`) credits a subscription invoice's **whole**
remaining balance, and since #2400 it does so only when the leaving member is
the last member that invoice still covers. A family invoice covers several
members, so several different cancellations can each reach that state — and the
outbox's claim is **per operation**, not per invoice. Two overlapping drains
(the approval kick is unawaited, and the reviewer is told to approve a whole
family in a burst) could therefore run two siblings' credit notes at once, both
read an empty covered set, both read the same `amountDue`, and both create a
full-balance credit note. Xero cannot dedupe them: the idempotency key is built
from the *subscription*, so the two keys differ. One allocation lands and the
other is rejected as an over-allocation, leaving unallocated credit on the
family's contact.

The single-flight is a **unique-key claim, not a lock**, following the #1636
credit-restore precedent above: before any Xero call the writer inserts one
`XeroObjectLink` row keyed on the invoice —
`(localModel "MembershipCancellationSubscriptionInvoice", localId <invoiceId>,
xeroObjectType "INVOICE", xeroObjectId <invoiceId>, role
"MEMBERSHIP_CANCELLATION_CREDIT_INVOICE_CLAIM")` — through
`createMany({ skipDuplicates: true })`, i.e. `INSERT ... ON CONFLICT DO
NOTHING`, so the second inserter matches zero rows. The row's metadata records
which subscription holds the claim, so a **retry of the same subscription**
proceeds (and Xero's own idempotency key, identical across that subscription's
retries, dedupes the credit note); a **different** subscription runs no side
effect at all and completes SUCCEEDED with
`skipped: invoice_credit_claimed_by_other_cancellation`.

An advisory lock was rejected deliberately, and this is the reasoning to keep:
the side effect being serialised is a sequence of Xero API calls, and
`pg_advisory_xact_lock` is transaction-scoped, so covering them would mean
holding a transaction open across provider calls — the shape AGENTS.md's
concurrency checklist forbids. No new advisory-lock family is introduced, no
existing key changes, and the claim commits before the first provider call, so
nothing here composes with the booking/capacity/credit cluster.

The claim is taken **only** on the branch that is about to credit (nobody else
covered). A cancellation that skips because other covered members are staying
must NOT claim, or it would fence the sibling who will legitimately credit the
invoice later.

Losing the claim is conservative in the right direction: if the winner
ultimately fails, the invoice simply keeps its balance, and the #2392
archive re-check then refuses to archive the contact over it — that re-check
reads the credit operation's **recorded outcome**, not a recomputed "would this
credit?", precisely so a one-shot operation that already skipped can never
excuse the invoice again.

## Stripe refund-note link repair: deliberately lock-free (#2901)

`applyStripeRefundNoteLinkRepairs` (`src/lib/xero-refund-note-link-repair.ts`,
operator CLI `scripts/xero-refund-note-link-repair.ts`) flips
`XeroObjectLink.active` on a Stripe payment's `REFUND_CREDIT_NOTE` links —
local mirror rows only, no money column, no booking status, no provider call.
Under `INV-LOCK-001` that composes no settlement-money or capacity transition,
so it joins no lock cohort; this section is its registration as an explicitly
lock-free money-adjacent writer (the advisory-lock census only enumerates
sites that DO take a lock, so it is structurally blind to this class).

The counterpart that makes it dangerous anyway is the outbox executor:
`createXeroCreditNote` reads `sumCoveredRefundCreditNoteCents` **outside any
transaction and under no lock**, then spends multi-second provider time before
creating the note. Joining global `lock(1)` here would therefore exclude
nothing — cohort membership only serialises against writers that take the same
key — and holding a transaction open across the executor's provider calls is
the shape this document forbids. The mechanisms that do the work instead:

- **Still-executable-operation refusal**: a payment is refused at plan time —
  and the check repeated inside the apply transaction — while ANY outbound
  `CREDIT_NOTE` operation row that could still drive `createXeroCreditNote`
  exists for it: a `CREATE` in PENDING/RUNNING/WAITING_PAYMENT (the outbox
  executor's lifecycle, which never reads `replayable`), a still-`replayable`
  `CREATE` in FAILED/PARTIAL (manual retry and requeue accept exactly that
  combination, and the credit-note retry branch performs no claim-first
  status flip, so it mints while the row still reads FAILED/PARTIAL), or a
  `REQUEUE` row in PENDING/RUNNING (the background retry drain executes the
  ORIGINAL operation while the original's own row never changes status).
  Every mint path therefore holds a matching row for the whole provider
  call. A FAILED/PARTIAL `CREATE` marked non-replayable is terminally dead —
  nothing can execute it again — and does not block, which matters because
  no operator action ever moves it out of FAILED/PARTIAL;
  SUCCEEDED/CANCELLED rows cannot re-execute and never block either.
- **Exact-count status-guarded claims**: the `updateMany` claims pin
  `active: true/false` and the matched counts must equal the plan exactly; a
  row a concurrent writer already flipped rolls the whole payment back.
- **Post-claim coverage verification**: the transaction re-sums coverage
  through `sumCoveredRefundCreditNoteCents` after its claims and must land on
  the plan's promised total, so a link a concurrent writer *inserted* after
  the in-transaction re-plan (the executor completing) also rolls the payment
  back rather than compounding with it.
- **Operator window**: the runbook has the operator hold the Xero outbox/cron
  drain during `--apply`. The residual sub-second window (executor past its
  coverage read but not yet committed when the repair commits) is accepted and
  is no longer silent: the reconciliation report's
  `overCoveredStripeRefundPayments` drift class flags the outcome for repair.

The tolerated counterpart reads are additive-only: every other refund-note
writer only ever ADDS active coverage, whose worst case (coverage above the
target) suppresses further enqueues and is now reported as drift, never
compounded by this repair.

## Rules of thumb when working here

- **Adding a capacity claim?** Take `acquireLodgeCapacityLock(tx, lodgeId)` on
  the booking's own lodge and follow read-key → lock → re-read. If the same
  transaction also performs a global-cohort lifecycle or settlement-money
  transition, take `lock(1)` FIRST (`INV-LOCK-002`).
- **Adding a global-cohort transition (cancel/capture/settle/refund/hold-release)?**
  Take `lock(1)` and status-guard the write
  (`updateMany({ where: { id, status } })`, bail on count 0). A capacity-only
  admission/status claim follows the per-lodge writer matrix instead; do not
  infer its tier from the fact that it changes a status column. Then register the
  site in `GLOBAL_LOCK_SITE_REGISTRY` with the counterpart it excludes — the
  guard fails by name until you do (`INV-LOCK-003`).
- **Adding a member-night writer?** It runs the guard, which self-takes the
  per-member lock; just make sure it calls `assertNoBookingMemberNightConflicts`
  inside the transaction after any per-lodge lock
  (`review-findings-contracts.test.ts` holds you to it).
- **Touching credit restoration?** The exactly-once guarantee is structural
  (`restoredFromBookingId` unique, #1636); keep the status-guarded claim as the
  primary single-flight and do not remove the unique key.
- **Touching group settlement?** Every settlement-status transition
  (settle/reap/fail/refund/organiser-cancel) must stay on `lock(1)` so they all
  serialise; only the per-child capacity *claim* (`commitChildrenToConfirmed`)
  uses per-lodge locks.
- **Serialising a sequence of PROVIDER calls?** Do not reach for an advisory
  lock — it is transaction-scoped, and holding a transaction open across a
  provider call is forbidden. Take a durable claim that commits first: a unique
  key where one exists (credit restore #1636, the membership-cancellation
  invoice credit #2400) or a status-guarded `updateMany`. A lost claim runs no
  side effect.
- **Composing two locks in one transaction?** Global `lock(1)` before any
  per-lodge lock; multiple same-family locks in sorted key order
  (`INV-LOCK-002`).
- **Writing a compensating transaction?** Give it explicit `maxWait`/`timeout`
  (never the interactive defaults — it runs under the contention that caused it),
  a bounded retry on P2028/P2034, and a guard so it can never throw past the
  handler. Map its failure to a real status (503 for contention) with copy that
  names the state, and if the uncompensated state is operator-only, write a
  `critical` audit row so it is searchable. `waitlist-confirm/route.ts` is the
  reference (#2623).
- **Bailing out of a `$transaction` callback?** Only `throw` rolls back;
  `return` COMMITS everything written so far. A `count === 0` guard that returns
  must sit above every write it does not want committed.
- **Deciding which client a read uses, or censusing that with a grep?**
  `INV-LOCK-004` is the rule: a read taken while a lock is held goes through the
  caller's transaction client. When you audit it, remember a transaction is
  opened **three** ways here and a scan keyed only on `prisma.$transaction(`
  under-reports. `withOptionalTransaction(callerTx, async (tx) → ...)`
  (`src/lib/db-transaction.ts`) either reuses a caller's `tx` or opens its own,
  so its callback body always runs inside a transaction while containing no
  opener itself → `modifyBookingBatch` and `createConfirmedBooking` both reach
  their locked work through it. And a transaction-scoped helper that merely
  *receives* a `tx` or `db` parameter contains no opener at all, so a lexical
  scan cannot see it either; `applyLifecycleTransitions`,
  `calculateModificationSettlementOptions` and `calculateModificationChangeFee`
  are that shape. #3110's census read two sites short until the first was
  accounted for and three short until the second was.
  `cancellation-policy-client-contract.test.ts` covers both, without an
  allowlist, and is the model to copy rather than a grep.
- **Writing raw SQL for a row lock?** Take it with `$executeRaw` on a statement
  that selects a constant, then read what you need through the Prisma model
  under that lock (#2289). Never type a `$queryRaw` result and read it: the
  generic is an unchecked cast and a column that does not exist arrives
  `undefined`, not as an error. If a statement genuinely cannot be a model read,
  validate its rows with `decodeRawRows` (`src/lib/raw-sql-rows.ts`).
