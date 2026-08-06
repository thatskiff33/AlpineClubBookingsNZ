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

### Tier 1 — per-lodge capacity claims

`acquireLodgeCapacityLock(tx, lodgeId)` (`capacity.ts`) serialises **bed/capacity
claims for ONE lodge**. Bookings at different lodges never contend, so two
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

### A writer that does BOTH takes BOTH — global first

Many writers do both tiers at once: a Stripe capture claims capacity **and**
moves money; a date modification reprices/refunds **and** re-checks capacity; a
quote-accept flips booking status **and** holds a bed. Every such writer:

1. takes the **global `lock(1)` FIRST**, then
2. takes the **per-lodge lock**.

The global-before-per-lodge order is fixed everywhere so composing the two can
never deadlock. Writers that compose several *same-family* locks (multiple
per-lodge locks, or multiple per-member locks) acquire them in **sorted key
order** for the same reason.

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
| **Global booking / money** | `1` (literal) | inline `tx.$executeRaw` | 2 | Booking-status + money side effects that must exclude across the whole booking regardless of lodge: cancel, capture/settle, hold-release, group-settlement reaper/settle/refund/organiser-cancel, refunds, credit restore. |
| **Per-lodge capacity** | `hashtextextended(<lodgeId>, 0)` | `acquireLodgeCapacityLock(tx, lodgeId)` (`lodge-capacity-lock.ts`, re-exported by `capacity.ts`) | 1 | Capacity claims/checks for one lodge; roster eligibility snapshots; and direct or config-transfer chore-template changes, which serialize active-template validation for that lodge. |
| **Per-member night footprint** | `hashtext("booking-member-night"), hashtext(<memberId>)` | `lockBookingMemberNights(tx, guests)` (`booking-member-night-conflicts.ts`) | cross-lodge | Serialises the person-night guard ACROSS lodges (see below). |
| **Per-member credit ledger** | `hashtext("member-credit-ledger"), hashtext(<memberId>)` | `lockMemberCreditLedger(memberId, tx)` (`member-credit.ts`) | — | A member's credit-ledger balance operations (spend, negative-adjustment validation, orphan-restore repair, the Xero inbound applied-credit repair, and the F20 pre-payment-reduction applied-credit clamp `clampAppliedCreditToBookingPrice`, taken inside the modification transaction only when the booking carries applied credit, and the #2265 stored-election consumption `consumeStoredCreditElection`, taken inside the `create-payment-intent` pay transaction and the Internet Banking switch transaction only when the booking carries an outstanding election). |
| **Member lifecycle** | `hashtext("member-lifecycle:<memberId>")` | inline (`member-lifecycle-actions.ts`, `nomination.ts` approval mapping, `admin-family-group-requests-service.ts`, `member-merge.ts`) | — | Archive/delete of one member; overwrite of one member by application-approval mapping (E10, #1936); linking/removing one member into/from a family group on admin request review; and **member merge** (dual-lock on master + loser, E11 #1937, see below). |
| **Membership application** | `hashtext(<application key>)` | `membershipApplicationLockKey` (`nomination.ts`) | — | State transitions of one membership application. |
| **Membership applicant** | `hashtext(<applicant-email key>)` | `membershipApplicationApplicantLockKey` (`nomination.ts`) | — | Per-email applicant dedup at submit time. |
| **Roster-date writers** | `hashtext("roster:<date>")` | `lockRosterDate(tx, date)` / sorted `lockRosterDates(tx, dates)` (`roster-lock.ts`) | date | Serialises whole-roster save/regenerate/confirm/auto-suggest, kiosk confirm and complete/uncomplete, and booking/guest cleanup that can remove suggested rows for the same lodge night. |
| **Config-transfer import** | `hashtext("config-transfer-import")` | `acquireConfigImportLock(tx)` (`config-transfer-lock.ts`) | — | Single-flights configuration-bundle apply and excludes lodge create/rename while an import resolves bundle slugs to immutable lodge ids. |
| **Minimum-stay policy set** | `hashtext("minimum-stay-policy-set")` | `lockMinimumStayPolicySet(tx)` (`minimum-stay-policy-set.ts`) plus the migration's `MinimumStayPolicy_lock_set` statement trigger | policy config | Serialises every live CRUD and config-transfer replacement across the small club/lodge policy set. The database trigger puts draining old-colour DML behind the exact same key before any tuple lock. |
| **Adult-member hosting policy set** | `hashtext("adult-member-hosting-policy-set")` | `lockAdultMemberHostingPolicySet(tx)` (`adult-member-hosting-policy-set.ts`) plus the migration's `AdultMemberHostingPolicy_lock_set` statement trigger | policy config | Serialises the admin write route and the config-transfer replacement over the one club row plus one row per lodge (#2364). Unlike its minimum-stay sibling the trigger is NOT a blue/green drain boundary — the table did not exist before its own migration, so no old colour writes it — it is there so advisory-before-tuple order holds for every writer, operator psql included. |
| **Membership subscription billing** | `hashtext("membership-subscription-billing:<seasonYear>")` | `confirmSubscriptionBillingPreview`, `reconcileSubscriptionBillingExceptions` (`membership-subscription-billing.ts`) | — | Annual/approval charge snapshot creation for one membership year; the #2148 refresh-reconciliation holds the same key so exception auto-resolution serialises with confirm and never resolves rows a concurrent confirm is regenerating. The #2161 operator family-marker writers (MARK/UNMARK on the subscription-billing route) deliberately take **no** advisory lock: they only insert/release a `FamilyGroupSeasonInvoiceMarker` row (single-active enforced by a partial unique index, so a concurrent double-mark is a benign no-op), and confirm re-derives suppression from the live marker rows under this same lock inside its transaction, so a mark landing mid-confirm either is seen by the in-tx re-preview or shifts the confirmation token — never a torn snapshot. |
| **Authoritative fee schedule** | `hashtext("fee-schedule:<domain>:<key>")` | `lockFeeSchedule` (`authoritative-fees.ts`) | — | Serialises effective-dated membership or entrance-fee schedule changes for one configured key. |
| **Member partner link** | sorted `hashtext("member-partner-link:<memberId>")` keys | `lockPartnerMembers` (`member-partner-link.ts`) | — | Serialises partner-link invariants across every member touched by a link; same-family keys are sorted. |
| **Xero member contact link (legacy key)** | `hashtext(<memberId>)` | short local-link transactions (`xero-contacts.ts`) | — | First-writer-wins local `Member.xeroContactId` linking after provider work. This legacy unnamespaced key is shared by both Xero contact-link writers; do not copy it for new domains. |
| **Diagnostics budget reserve (per month)** | `hashtext("diagnostics-budget-reserve"), hashtext(<month>)` | `reserveDiagnosticsBudget` **and** `settleDiagnosticsRoundtrip` (`ai-diagnostics-usage.ts`, AID-2 #2371) | — | Serialises every AI Diagnostics budget RESERVE **and** SETTLE for one billing month so the reserve's read-check-insert (sum live reservations + settled spend, compare to budget, insert reservation) is atomic against concurrent reservers AND against a settle's reservation-delete + `settledCents` increment. A burst of paid diagnostics roundtrips therefore cannot push `settled + reserved` over the monthly budget, and a settle can never commit mid-reserve to under-count committed spend; a lost claim (over budget) inserts nothing and denies the paid call. Different months do not contend. Held only for the milliseconds of each short transaction; the provider call runs entirely OUTSIDE both. Both take ONLY this key (no second lock), so no ordering cycle is possible. See "Composition: diagnostics budget reserve" below. |
| **Backup run claim** | `hashtext("backup:run-lock")` | `claimBackupRun` (`backup-run.ts`, #2095) | — | Single-flights managed database backups across containers (nightly cron vs admin run-now). Held only for the milliseconds of the reap-stale → active-check → insert-RUNNING claim transaction; the `pg_dump`/upload pipeline runs entirely outside any transaction, so a crashed run can never wedge the lock (a dead RUNNING row is reaped by heartbeat age on the next claim). Single-lock holder; composes with no other family. The config-transfer pre-apply safety backup deliberately bypasses this claim (it must run inline; concurrent dumps are independent snapshots writing uniquely-named files). |

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
one sorted set containing every night in the old and proposed half-open stay
ranges plus any exceptional stored assignment dates before changing a Booking
or BookingGuest tuple. Guest removal likewise takes global → lodge → sorted
stored roster dates before its post-lock re-read and guarded deletion. Member
guest consent and admin booking-review claims share global → lodge; guest add
shares the immutable lodge tier. Those common tiers serialize eligibility
changes with roster validation without making every booking writer enumerate
every possible roster night.

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
member's settlement delta) is a money error rather than a nuisance. See
`docs/DOMAIN_INVARIANTS.md` → "Subscription-lockout booking pricing".

### Composition: application-approval mapping (E10, #1936)

The membership-application approval transaction is the one writer that composes
the application and member-lifecycle families. Its fixed acquisition order is:

1. `member-application:<applicationId>` (the existing approval lock), THEN
2. every mapped target's `member-lifecycle:<memberId>`, in **sorted key order**.

Counterpart analysis — no cycles are possible:

- Every other `member-lifecycle` holder is single-lock in that family:
  member archive/delete approval (`member-lifecycle-actions.ts`) locks exactly
  one member and takes no application lock; the admin family-group request
  review transactions (`admin-family-group-requests-service.ts`) lock exactly
  the one pre-existing member being linked into (or removed from) a group
  before writing `FamilyGroupMember` — required because a `FamilyGroupMember`
  insert does not bump `Member.updatedAt`, so only the lock (not the mapping
  preview token) can serialise it against the mapping approval's
  in-any-family-group collision guard. (The group-create *reject* transaction
  takes no member lock: it links nobody into a group.)
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
- `admin-bed-allocation.ts` locks the owning `LodgeRoom` row with `FOR UPDATE`
  before checking and changing one room's bunk-group membership. This protocol
  is independent of the booking/capacity/credit lock cluster.
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

  **The same refusal covers the family links (#2437).** The four Member
  self-relation columns (`parentMemberId`, `secondaryParentId`,
  `inheritEmailFromId`, `detailsConfirmedByMemberId`) are written by admin
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
  every other merge refusal (`merge_blocked`, `preview_drift`, the field-drift
  arm, self-merge, missing member, confirmation mismatch). It records the actor,
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

Do not add or compose a row lock without updating this inventory and documenting
its order against every advisory- and row-lock counterpart.

### Member merge — dual member-lifecycle lock (E11 #1937)

`executeMemberMerge` (`member-merge.ts`) is the only writer that holds **two**
`member-lifecycle:<memberId>` advisory locks at once — one for the master, one
for the loser. Both are acquired at the very top of the single merge transaction
in **sorted id order** (`[masterId, loserId].sort()`, smaller id first) so a
merge and its mirror (a merge started from the other direction, or a concurrent
archive/delete of either member) can never deadlock. Because the keys share the
`member-lifecycle:` namespace with `member-lifecycle-actions.ts`, a merge also
mutually excludes any archive or delete of either the master or the loser.

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

Bed-allocation mutation boundaries follow the same composition rule (#2593).
The public lifecycle reconciler owns a transaction and takes global `lock(1)`
before resolving and taking the booking's immutable lodge lock; callers already
holding global use `reconcileBedAllocationsForBookingWithGlobalLockHeld`, and
callers holding both use the explicitly named lodge-lock-held seam. Room/bed
inventory update/delete, manual placement/range assignment, allocation delete,
and approval similarly expose transaction-owning public wrappers plus narrow
`*WithLocksHeld` internals for existing transactions. A caller must never pass a
client into a public wrapper to bypass lock ownership. The explicit board
auto-allocation write takes global first, then all affected lodge locks in
sorted id order, and re-reads booking eligibility, whole-lodge holds, and
custodian bed holds before inserting. The planner's per-lodge priority order
changes candidate choice but introduces no lock key and never weakens these
write-time re-reads.

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
zero-dollar and charge branches, the waitlist-confirm $0 PAID claim, the
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
  `buildLodgePolicyExceptionReservationCounter` is the per-night counter the four
  capacity engines add to `occupiedBeds` **exactly as they add the custodian
  counter** (`checkCapacity`, `checkCapacityForGuestRanges`,
  `checkCapacityForPartnerSharedAdmission`, `getMonthAvailability`).
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

## Rules of thumb when working here

- **Adding a capacity claim?** Take `acquireLodgeCapacityLock(tx, lodgeId)` on
  the booking's own lodge and follow read-key → lock → re-read. If the same
  transaction also performs a global-cohort lifecycle or settlement-money
  transition, take `lock(1)` FIRST.
- **Adding a global-cohort transition (cancel/capture/settle/refund/hold-release)?**
  Take `lock(1)` and status-guard the write
  (`updateMany({ where: { id, status } })`, bail on count 0). A capacity-only
  admission/status claim follows the per-lodge writer matrix instead; do not
  infer its tier from the fact that it changes a status column.
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
  per-lodge lock; multiple same-family locks in sorted key order.
- **Writing raw SQL for a row lock?** Take it with `$executeRaw` on a statement
  that selects a constant, then read what you need through the Prisma model
  under that lock (#2289). Never type a `$queryRaw` result and read it: the
  generic is an unchecked cast and a column that does not exist arrives
  `undefined`, not as an error. If a statement genuinely cannot be a model read,
  validate its rows with `decodeRawRows` (`src/lib/raw-sql-rows.ts`).
