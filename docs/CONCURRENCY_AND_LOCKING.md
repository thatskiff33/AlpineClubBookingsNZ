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
request approval converts a held booking **and** claims its beds. Every such writer:

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

### Organiser bank-transfer extra invoices (#4299)

Extras are money writers in the existing global cohort (`INV-LOCK-001`).
Each edit queues its change-anchored invoice after writing the change history,
inside its existing global → lodge → member locks, then takes the existing
supplementary-anchor key last (`INV-LOCK-002`). Historical repair uses that
same anchor protocol without booking or payment mutations. Contact resolution,
invoice creation and app email delivery happen outside these transactions.

`syncOrganiserExtraInvoiceCash` takes global then the child's Payment row,
materialises its original combined-invoice share before introducing extra cash
transactions, and records only the cash delta. Cancellation and reduction
planners reserve waived amounts and invoice-specific refund notes under their
existing global claims; group cancellation freezes this plan under global and
re-reads each Payment under its row lock. Raced cash's compensating
hand-backs (`reserveOrganiserExtraRacedCash`) also take global: every plan's
share is a delta over the rows re-read under it, backed by unique scope and
occurrence keys. A queued invoice
waived whole is retired by a status-guarded `updateMany` inside the reserving
claim, only while never attempted (`PENDING` or `WAITING_PAYMENT`, no
`startedAt`), so a `RUNNING` or `FAILED` create keeps its invoice and the
waiver is reserved against it. The supplementary enqueue refuses a change so
retired under its anchor key, and the create re-asks in a short transaction
holding that key alone, just before its Xero call, so neither an edit's
after-commit re-enqueue nor an officer's retry raises it.
The group cancel records each child's refund on its payment rows under the
child's claim (global, then the Payment row in `applyLocalRefundAllocation`).
These new sites are registered under `INV-LOCK-003`; no new advisory namespace
is introduced.

Provider execution uses the committed outbox's guarded RUNNING claim and
claim token. Invoice reads, voids, credit creation, allocation and refund-note
settlement run outside database transactions. Refund notes wait for the
matching bank-transfer hand-back's completion; a lost outbox claim cannot save
its outcome. This composes with the existing cancel/capture/refund cohort and
with the supplementary-anchor protocol rather than holding a lock across Xero.

### One refund credit note in flight per payment, by claim order (#3880)

A delta refund note sizes itself off the notes already recorded on its payment
and keys its Xero create on the resulting watermark, so two runs that read
before either records get Xero's one deduped note for two refunds. No lock is
held across that Xero call. Instead every run already holds a RUNNING row on
the payment before it reads - the outbox row its worker claimed, or the
operator's `REQUEUE` row - and `assertNoRefundCreditNoteInFlight`
(`xero-refund-note-in-flight.ts`, called by `createXeroCreditNote` in delta
mode) refuses while any other live (younger than the stale threshold)
refund-note create or credit-note requeue on the payment is RUNNING. Each run
commits its claim and then reads, so of two concurrent runs at least one sees
the other; both seeing each other is safe. The refusal is a busy error, and the
outbox and the retry queue return the row to PENDING with the reason kept. It
adds no advisory key and no row lock. Since #3880 a bank-transfer hand-back on
a cancelled booking - a review's, and a `CANCELLED_BOOKING_HAND_BACK` - also
queues its refund note INSIDE the completion transaction: an outbox row insert,
after the completion's
`lock(1)`, its member-ledger key and the `Payment` row
(`lockPaymentForRefundedTotal`), with no provider call. Proven against real
PostgreSQL by `edit-financial-review-cancelled-refund-xero.realdb.test.ts`.

### A Xero retry claims the original row it writes (#2262 H3, #3462, #4256)

A retry that writes the original operation row - the booking invoice replay,
the PARTIAL invoice payment repair, and the PARTIAL and FAILED refund-note
repairs - first claims it with a status-guarded `updateMany`
(`runWithClaimedOriginal`, `xero-operation-retry.ts`): FAILED/PARTIAL
(PARTIAL only for a PARTIAL repair) -> RUNNING, unresolved and replayable. The
resolve route refuses a RUNNING row, and the mark non-replayable route writes
only onto a FAILED or PARTIAL row (a status-guarded `updateMany`, 409 and no
audit otherwise), so either mark lands before the claim, which then loses with
no write and no Xero call, or is refused. Two retries of one row: one claims,
the other gets 409. The repairs complete onto their claim only
(`completeXeroSyncOperation(claim, ..., { retryClaim: true })`), so one finishing
after an operator's Mark failed writes nothing. A throw gives the row back
guarded on the claim (still RUNNING, still its `startedAt`): FAILED for the
replay, PARTIAL with its payload for a PARTIAL repair. A PARTIAL repair's claim
carries `lastErrorCode = PARTIAL_REPAIR_RUNNING`, so if its process dies the
stale reset and Mark failed return it to PARTIAL rather than FAILED. No
advisory key and no lock is held across the Xero call. The booking invoice
replay hands its claim to `createXeroInvoiceForBooking`, whose completion is
written under it (#4373). A repair whose process died after its payment was recorded is
closed by the next retry from the payment's link (live, this invoice, this
amount), with no second Xero call.
During a blue/green overlap the old version's stale reset sends a stuck repair
to FAILED, which then needs Resolve in Xero or a by-hand payment check. Proven against real PostgreSQL by
`xero-partial-repair-claim.realdb.test.ts`.

### Two callers on one Xero operation row: guarded outcomes (#4356)

A start that loses the insert race on the one-ACTIVE-row index (#1354) is
handed the winner's row, so two callers make the same keyed Xero call and each
records its outcome on that one row. No lock is held across either call, and
none is added: the outcome writers themselves are status-guarded
(`INV-INT-029`). `failXeroSyncOperation` is always a guarded `updateMany` that
never lands on SUCCEEDED or PARTIAL, and `completeXeroSyncOperation` guards
every outcome but SUCCEEDED the same way (PARTIAL only off SUCCEEDED). A
refused write answers null and raises no repeated-failure alert, so whichever
order the two calls return in, a recorded success stands. The guard composes
with the claim guards above: `retryClaim` still writes onto its own RUNNING
claim only, and no other outcome but SUCCEEDED lands on a repair's claim, which
the PARTIAL repair (`PARTIAL_REPAIR_RUNNING`) and the FAILED refund-note repair
(`REFUND_NOTE_REPAIR_RUNNING`) mark.

Since #4373 every outcome also carries the claim it was made under - the
row's id and the `startedAt` its RUNNING claim was stamped with - from the
start (`startXeroSyncOperation`'s row), the outbox or REQUEUE claim
(`claimXeroSyncOperationToRunning` answers it) or a retry's claim
(`runWithClaimedOriginal`). The writers take it in place of a bare id, so a
call without one does not compile. No outcome, a success included, lands on a
RUNNING row whose `startedAt` is another claim's: after a stale reset or a
failure, the earlier attempt's late outcome is refused on the retry's claim
(null, no link, no alert, an info log), and the row stays RUNNING for the
retry and the booking invoice retry's settle-time fence. A refused SUCCEEDED
or PARTIAL still upserts its `extraLinks` (idempotent) and logs a warning,
leaving the row's status and claim as they are, so a Xero object the earlier
attempt created is recorded even if the retry then fails; a refused FAILED or
CANCELLED writes nothing. The outbox's and the
REQUEUE queue's hand-backs to PENDING are fenced on their own claim the same
way. Two claims of one row share a token only if made in the same
millisecond; a second claim follows the first's failure (after a Xero round
trip, a pre-HTTP cooldown refusal or a CAS requeue) or its stale reset, each
many milliseconds after the first was stamped, so that does not happen. No advisory key, row lock,
schema change or new participant. Proven against real PostgreSQL by
`xero-shared-operation-outcome.realdb.test.ts`.

### The Xero token refresh uses a row lease, shared across colours (#3454)

`xero-token-store.ts` composes no booking, capacity, membership or money
mutation and takes **no advisory lock**. One rotating refresh token may be
spent only once, so a refresh first claims a lease with a status-guarded
`updateMany` (`NULL` or expired → this lease). PostgreSQL re-evaluates that
predicate after the row lock, so of two simultaneous claimants exactly one wins.
The losers wait out the lease and re-read. The Xero call runs outside any
transaction (`INV-INT-003`).

**Since #3806 R2 there are two lease rows, claimed together.** The previous
release (#3454) claims only `XeroToken.refreshInProgressUntil`, so this release
claims that one first — that is where the two releases exclude each other — and
then `XeroConnection.refreshInProgressUntil`, the lease that stays when
`XeroToken` is dropped (R3). If the second is held, the first is rolled back:
no process holds half a lease. Release and save clear both. While no
`XeroToken` row exists, only `XeroConnection`'s is claimed.

**Lock order: `XeroToken`, then `XeroConnection`.** A statement trigger on
`XeroToken` syncs `XeroConnection` at the end of each `XeroToken` statement, so
every writer of either release that touches both tables touches `XeroToken`
first. The token store's claim, save, release, connect and delete keep that
order, so no cycle forms with the previous release's writers. The sync is ONE
statement, reading one snapshot taken once its `XeroConnection` lock is
granted, so a refresh, connect or disconnect committing while it waits is
never half-seen and written back stale. It row-locks the connection only to
change its tenant or expiry, so a lease claim (which changes neither) waits on
no `XeroConnection` writer; otherwise it waits only for a row another
transaction is writing or inserting at the same moment. Two connects at the
same moment can still leave two `XeroToken` rows, as under #3454: every reader
takes the most recently written one, and the next connect or disconnect
deletes both (`saveXeroTokens`).

**The claim takes the leases first and reads the tokens second, in the same
transaction.** The winning `updateMany`s hold both rows' locks until the claim
commits, and every writer of the token set (a connect, a refresh save, a
disconnect, a verify-reset, of either release) takes one of those rows first. So
the store copy the claim then reads is the one that belongs to its lease.
Reading first and claiming second let a reconnect commit between the reads, and
the refresh then overwrote it (#3454 review).

**Before the Xero call, the refresh proves its save can succeed**
(`assertXeroTokensCanBeStored`: the auth-secret capture gate). Otherwise it
refuses without spending the refresh token.

The save is one short transaction with three fences: the lease-guarded
`XeroToken` update (when a row was claimed), the lease-guarded `XeroConnection`
update, and a compare-and-set on the credential-store copy against the version
the claim read under its locks. A reconnect, a later claim or a writer that
bypassed the leases makes it lose, and losing any rolls back all three.
`xero-token-credential-store.realdb.test.ts` proves the dual claim and the
fences against real row locks, including against the previous release's own
claim statement, and forces both of the trigger's interleavings with a queued
table lock.

## The lock families

All keys below are the argument(s) to `pg_advisory_xact_lock`. Two-argument keys
use `(namespace, subject)`; single-argument keys hash a descriptive string or
are the literal `1`.

| Lock | Key | Helper / where | Tier | Serialises |
| --- | --- | --- | --- | --- |
| **Global booking / money** | `1` (literal) | inline `tx.$executeRaw` | 2 | Booking-status + money side effects that must exclude across the whole booking regardless of lodge: cancel, capture/settle, hold-release, group-settlement reaper/settle/refund/organiser-cancel, refunds, credit restore; plus bed-allocation inventory/placement/move/range/auto/approval/removal writers that must serialize with lifecycle prune; and, since #2698, the hut-leader ACCEPT path only — a custodian bed hold the officer has explicitly accepted narrowing an existing whole-lodge hold, which must exclude that hold's release (`INV-CAP-038`). Gated on the acceptance AND on a bed being involved, so a bedless write cannot take the club-wide key by asserting a flag. The hut-leader routes are otherwise not in this cohort: the detect-and-refuse path writes nothing and takes the per-lodge key alone. Member merge is the one bed-allocation writer that deliberately does NOT take this key — see "Merge joins the bed-allocation cohort" (#2595). |
| **Per-lodge capacity** | `hashtextextended(<lodgeId>, 0)` | `acquireLodgeCapacityLock(tx, lodgeId)` (`lodge-capacity-lock.ts`, re-exported by `capacity.ts`) | 1 | Capacity claims/checks and bed-allocation mutations for one lodge; booking admission versus lodge deactivation; hut-leader overlap, optional bed-hold writes and assignment DELETE (#2698: removing a custodian hold widens every overlapping whole-lodge hold's represented set); roster eligibility snapshots; and direct or config-transfer chore-template changes, which serialize active-template validation for that lodge. |
| **Per-member night footprint** | `hashtext("booking-member-night"), hashtext(<memberId>)` | `lockBookingMemberNights(tx, guests)` (`booking-member-night-conflicts.ts`) | cross-lodge | Serialises the person-night guard ACROSS lodges (see below). |
| **Per-trip hosting coverage** | `hashtext("hosting-coverage-group"), hashtext(<GroupBooking.id>)` | `lockHostingCoverageGroup` / `lockHostingCoverageGroups`, with `tryLockHostingCoverageGroup(s)` tried first (`adult-member-hosting-coverage-lock.ts`) | cross-account | Serialises `SAME_GROUP_TRIP` coverage (#3039, epic #2943). The owner key cannot do this job: it is `Booking.memberId`, the DEPENDENT's own account, while every Group Trip source belongs to somebody else — so two writers changing two bookings in one trip hold two DIFFERENT owner keys and are not serialised at all. Not the lodge key either: one lodge holds many unrelated trips. Taken immediately BEFORE the sorted owner keys, because the trip's membership is what decides which owners the reconciliation fan-out will name. Several trips are taken in sorted order, and EVERY acquisition is tried with `pg_try_advisory_xact_lock` before the blocking form — one transaction can discover two trip keys (a booking in one trip whose same-owner dependent sits in another), so sorting within a call cannot order keys discovered in two, and a conflict rolls the whole outer transaction back with the stable `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409 rather than waiting inside a booking transaction. Taken only where the lodge has `SAME_GROUP_TRIP` enabled AND the booking is in a trip. |
| **Per-owner hosting coverage** | `hashtext("hosting-coverage-owner"), hashtext(<Booking.memberId>)` | `lockHostingCoverageOwner` / `lockHostingCoverageOwners` (`adult-member-hosting-coverage-lock.ts`) | cross-booking | Serialises `SAME_BOOKING_OWNER` coverage (#2576 §9): one booking's compliance depends on another booking of the SAME owner, so the key remains authoritative even though #2600 made allocation-participating confirmation and cancellation compose global → lodge. Taken LAST among the application lock families a caller composes, EXCEPT that since #3039 the per-TRIP hosting coverage key above sits immediately before it — so it is the second of the last two rather than the last. Roster-aware modification paths take global → lodge → roster-date → any applicable member keys → sorted queue-participant `Member FOR KEY SHARE NOWAIT` rows → coverage-group → coverage-owner; queued incident reconciliation takes hosting policy-set → sorted claimed member-lifecycle keys → sorted claimed `Member FOR KEY SHARE` rows → coverage-group (only where the reconciled booking is in a Group Trip at a lodge with `SAME_GROUP_TRIP` on; the evaluator takes it fail-fast before it reads a sibling as cover) → coverage-owner. Paths that do not use roster or member keys omit those tiers. Ordinary producers try sorted owner keys before re-entering the blocking helper, while merge takes its sorted owner keys only after its one sorted participant `FOR UPDATE` statement. The key is taken only when the lodge actually has the scope enabled. |
| **Per-member credit ledger** | `hashtext("member-credit-ledger"), hashtext(<memberId>)` | `lockMemberCreditLedger(memberId, tx)` (`member-credit.ts`) | — | A member's credit-ledger balance operations (spend, negative-adjustment validation, orphan-restore repair, every applied-credit restore (`restoreCreditFromBooking`, taken inside the caller's transaction after its `lock(1)` and lodge locks, #3792), the Xero inbound applied-credit repair, and the F20 pre-payment-reduction applied-credit clamp `clampAppliedCreditToBookingPrice`, taken inside the modification transaction only when the booking carries applied credit, through its give-back `giveBackAppliedCredit`, which a credit-paid booking's review share also goes through (#3791), taken inside an `EDIT_FINANCIAL_REVIEW` completion after its `lock(1)`, its claim and its re-price, only on the account-credit route with no captured payment, and by a paid booking's price reduction (#3809, `giveBackPaidReductionCredit`), taken inside the batch, date-change and guest-removal transactions (the consent decline and expiry included) in `applyPaymentAdjustments`, after `lock(1)`, the lodge key and any roster-date keys and before any `Payment` row write, only on a PAID or COMPLETED booking with credit applied and a reduction the captured money's basis cannot return, and the #2265 stored-election consumption `consumeStoredCreditElection`, taken inside the `create-payment-intent` pay transaction and the Internet Banking switch transaction only when the booking carries an outstanding election)., and the member whole-lodge approval's credit application (`approveMemberWholeLodgeRequest`, #4019: `applyCreditToBooking` under this lock inside the approval transaction after its `lock(1)` and lodge key and BEFORE the adult-member-hosting reconcile that may take Member rows and the coverage keys). |
| **Member lifecycle** | `hashtext("member-lifecycle:<memberId>")` | inline (`member-lifecycle-actions.ts`, `app/api/admin/deletion-requests/[id]/route.ts`, `nomination.ts` approval mapping, `admin-family-group-requests-service.ts`, `member-merge.ts`, `adult-member-hosting-coverage-drain.ts`) | — | Archive/delete of one member; account-deletion approval (the #1756 partner-share prefix — global cohort `lock(1)` + every affected lodge, sorted — and only then member lifecycle → shared standing-subject `Member FOR UPDATE NOWAIT` → exact queue-participant `Member FOR KEY SHARE NOWAIT` rows → coverage-owner before deactivation and guest unlink); overwrite of one member by application-approval mapping (E10, #1936); linking/removing one member into/from a family group on admin request review; **member merge** (dual-lock on master + loser, E11 #1937, see below — merge takes the merge-only partner-share prefix, so every affected lodge key is held BEFORE this tier while the global cohort key is deliberately NOT taken at all, and the two `member-partner-link:` keys immediately AFTER it, #2595); and the queue-drain handshake that prevents a claimed hosting item from using identities while merge re-points them. |
| **Membership application** | `hashtext(<application key>)` | `membershipApplicationLockKey` (`nomination.ts`) | — | State transitions of one membership application. |
| **Membership applicant** | `hashtext(<applicant-email key>)` | `membershipApplicationApplicantLockKey` (`nomination.ts`) | — | Per-email applicant dedup at submit time. |
| **Roster-date writers** | `hashtext("roster:<date>")` | `lockRosterDate(tx, date)` / sorted `lockRosterDates(tx, dates)` (`roster-lock.ts`) | date | Serialises whole-roster save/regenerate/confirm/auto-suggest, kiosk confirm and complete/uncomplete, and booking/guest cleanup that can remove suggested rows for the same lodge night. |
| **Config-transfer import** | `hashtext("config-transfer-import")` | `acquireConfigImportLock(tx)` (`config-transfer-lock.ts`) | — | Single-flights configuration-bundle apply and excludes lodge identity mutations while an import resolves bundle slugs to immutable lodge ids. A lodge update/deactivation then takes its immutable target-lodge capacity key before re-reading the lodge and active-lodge/dependency predicates. |
| **Minimum-stay policy set** | `hashtext("minimum-stay-policy-set")` | `lockMinimumStayPolicySet(tx)` (`minimum-stay-policy-set.ts`) plus the migration's `MinimumStayPolicy_lock_set` statement trigger | policy config | Serialises every live CRUD and config-transfer replacement across the small club/lodge policy set. The database trigger puts draining old-colour DML behind the exact same key before any tuple lock. |
| **Adult-member hosting policy set** | `hashtext("adult-member-hosting-policy-set")` | `lockAdultMemberHostingPolicySet(tx)` / `tryLockAdultMemberHostingPolicySet(tx)` (`adult-member-hosting-policy-set.ts`) plus the migration's `AdultMemberHostingPolicy_lock_set` statement trigger | policy config | Serialises the admin write route and the config-transfer replacement over the one club row plus one row per lodge (#2364), fences the drain's policy read before incident reconciliation, and excludes member merge while policy reconciliation enumerates bookings and inserts queue rows. Unlike its minimum-stay sibling the trigger is NOT a blue/green drain boundary — the table did not exist before its own migration, so no old colour writes it — it is there so advisory-before-tuple order holds for every writer, operator psql included. Policy writers and merge take the blocking form. The drain takes the fail-fast form, releases a contended exact queue claim without consuming an attempt, and otherwise composes policy-set → sorted member-lifecycle → sorted `Member FOR KEY SHARE` rows → coverage-owner. |
| **Membership subscription billing** | `hashtext("membership-subscription-billing:<seasonYear>")` | `confirmSubscriptionBillingPreview`, `reconcileSubscriptionBillingExceptions` (`membership-subscription-billing.ts`) | — | Annual/approval charge snapshot creation for one membership year; the #2148 refresh-reconciliation holds the same key so exception auto-resolution serialises with confirm and never resolves rows a concurrent confirm is regenerating. The #2161 operator family-marker writers (MARK/UNMARK on the subscription-billing route) deliberately take **no** advisory lock: they only insert/release a `FamilyGroupSeasonInvoiceMarker` row (single-active enforced by a partial unique index, so a concurrent double-mark is a benign no-op), and confirm re-derives suppression from the live marker rows under this same lock inside its transaction, so a mark landing mid-confirm either is seen by the in-tx re-preview or shifts the confirmation token — never a torn snapshot. The #4098 close-as-already-paid writer (`closeAlreadyPaidSubscriptionCharge`, `membership-subscription-charge-close.ts`) also takes **no** advisory lock, like the #2147 void release it mirrors: in one transaction it claims the charge with a status-guarded `updateMany` (`CONFLICT` + `SUBSCRIPTION_ALREADY_PAID` + no invoice), then re-checks PAID in the `WHERE` of the subscription write that bumps `voidGeneration` (a short count rolls back), then releases the coverage claims. It refuses while an invoice operation for the charge is queued or running, which covers an old pod's worker during a rollout. It does not rely on that refusal against a new worker: every charge-status write in the invoice pipeline (`liveChargeWhere` in `subscription-charge-already-paid.ts`, shared by the enqueue, the worker and the outbox failure handler) matches only live charges, so a worker whose Xero call was in flight when the close landed loses its `INVOICE_CREATED` write, links and emails nothing, and leaves `STRAY_INVOICE_AFTER_CLOSE` on the closed charge naming the invoice to void, written in the same transaction as the lost claim (only when that attempt raised or adopted the invoice; a voided charge or a resumed invoice just finishes as skipped). A concurrent close loses the claim and reads the charge closed; a manual reversal committing first rolls it back; the members are PAID, so a concurrent confirm never bills them either way. A later re-bill of a closed or voided family (#4110) runs inside confirm under this season key, and the family/type/season partial unique index (live charges only) still refuses a second LIVE family charge if two confirms ever raced past it. |
| **Authoritative fee schedule** | `hashtext("fee-schedule:<domain>:<key>")` | `lockFeeSchedule` (`authoritative-fees.ts`) | — | Serialises effective-dated membership or entrance-fee schedule changes for one configured key. |
| **Member partner link** | sorted `hashtext("member-partner-link:<memberId>")` keys | `acquireMemberPartnerLinkLocks` (`member-partner-lock.ts`), called by `lockPartnerMembers` (`member-partner-link.ts`), existing-member parent-link writers, nomination mapping, the reviewed move (`bed-allocation-move.ts`) and member merge (`member-merge.ts`) | — | Serialises partner-link invariants across every member touched by a link, including the direct parent/partner exclusion in `INV-LIFE-024`; same-family keys are sorted. The CONFIRMED partial uniques are per side (`memberAId`, `memberBId`), so "at most one confirmed partner" is enforced by this key alone — every writer of a partner link, every existing-member writer that adds a direct parent, and every reader whose relationship read decides such a write must hold the complete affected set. Partner-only service paths take ONLY this family. Parent writers take any member-lifecycle keys first, then this family; the reviewed move and merge likewise take it after member-lifecycle, so the edge remains one-way (#2595, #3271). Create-new-member paths are structurally outside this cross-table race because the generated child id cannot already own a partner row; the closed-world writer census records those sites rather than silently exempting them. |
| **Xero member contact link (legacy key)** | `hashtext(<memberId>)` | short local-link transactions (`xero-contacts.ts`) | — | First-writer-wins local `Member.xeroContactId` linking after provider work. This legacy unnamespaced key is shared by both Xero contact-link writers; do not copy it for new domains. |
| **Diagnostics budget reserve (per month)** | `hashtext("diagnostics-budget-reserve"), hashtext(<month>)` | `reserveDiagnosticsBudget` **and** `settleDiagnosticsRoundtrip` (`ai-diagnostics-usage.ts`, AID-2 #2371) | — | Serialises every AI Diagnostics budget RESERVE **and** SETTLE for one billing month so the reserve's read-check-insert (sum live reservations + settled spend, compare to budget, insert reservation) is atomic against concurrent reservers AND against a settle's reservation-delete + `settledCents` increment. A burst of paid diagnostics roundtrips therefore cannot push `settled + reserved` over the monthly budget, and a settle can never commit mid-reserve to under-count committed spend; a lost claim (over budget) inserts nothing and denies the paid call. Different months do not contend. Held only for the milliseconds of each short transaction; the provider call runs entirely OUTSIDE both. Both take ONLY this key (no second lock), so no ordering cycle is possible. See "Composition: diagnostics budget reserve" below. |
| **Xero inbound cycle run claim** | session `hashtext("cron-run-claim"), hashtext(jobName)` | `withCronRunClaim` through `runXeroCronTaskList` (#4432) | — | Scheduled inbound, HTTP cron and whole-club sync-now share one dedicated autocommit connection's fail-fast claim. It wraps the cycle without an open transaction; domain writers retain their own transaction locks. Connection death recovers it, with no expiring live-holder lease. See the Xero inbound cycle run claim section below. |
| **Backup run claim** | `hashtext("backup:run-lock")` | `claimBackupRun` (`backup-run.ts`, #2095) | — | Single-flights managed database backups across containers (nightly cron vs admin run-now). Held only for the milliseconds of the reap-stale → active-check → insert-RUNNING claim transaction; the `pg_dump`/upload pipeline runs entirely outside any transaction, so a crashed run can never wedge the lock (a dead RUNNING row is reaped by heartbeat age on the next claim). Single-lock holder; composes with no other family. The config-transfer pre-apply safety backup deliberately bypasses this claim (it must run inline; concurrent dumps are independent snapshots writing uniquely-named files). |
| **Xero supplementary invoice per anchor** | `hashtext("xero-supplementary-invoice"), hashtext(<BookingModification id, or ManualRefundTask id for a second ask, or Booking id for the change-capture receipt's planning gate and plan store and the enqueue's booking-first key, #3953>)` | `enqueueXeroSupplementaryInvoiceOperation` (`xero-operation-outbox.ts`, #3170) | anchor | Single-flights "does this booking change already have a supplementary invoice going out?" so one edit can never send two. Held only for the milliseconds of the link-check -> queued-check -> raise-or-create transaction; the Xero round trip happens later, in the outbox worker, entirely outside it. No holder of this key takes a new lock after it, so wherever it composes it is the LAST lock of its transaction; three holders take more than one of these keys (the supplementary ENQUEUE, booking then change, #3953 round 7 below; the SUPERSEDED-INVOICE MOVE, #3403 below; and since #4324 a #3980 GAP invoice's enqueue, every anchor it bills, sorted, below). FOUR callers compose it after other locks. #3947's (owner decision 22 Oct 2026, option 2): an officer's review charge on the `invoice` route queues its edit's supplementary invoice INSIDE the completion's transaction through `enqueueEditReviewChargeInvoiceInTransaction`, after that transaction's `lock(1)` and member-credit keys and as its last lock, so the order there is global -> (member-credit) -> this key and no cycle is possible; only the outbox row is written, the kick runs after the commit, and the invoice commits with the share, so the next share of the edit, behind it on `lock(1)`, always sees it (`supplementaryInvoiceStillComingWhere`). A unique violation there aborts the completion, which leaves the task OPEN. And since #4324 (`INV-PAY-144`) three after a #3639 approval task's row, set out below: the KEEP'S DECISION (task row -> anchor), the APPROVAL's settlement (task row -> anchor) and the PAID-ANOTHER-WAY CLOSE (lock(1) -> Payment -> task row -> anchor). Its other FOURTEEN callers - the six enqueue callers below, the LATE-CAPTURE RE-QUEUE, the CHANGE-CAPTURE RECEIPT, its PLANNING GATE, its PLAN STORE, its UNSENT-INVOICE SWITCH, the OFFICER RETRY's re-check after them, the SUPERSEDED-INVOICE MOVE and its RETURN (#3403) - arrive holding nothing, save the CHANGE-CAPTURE RECEIPT's enqueue where the keep's decision calls it on its own transaction (`store`), holding the task row and the anchor it re-takes: the edit-settlement callers reach it post-commit through a fire-and-forget `queueXeroBookingEditSettlement`; the booking-vs-Xero repair pass (`xero-booking-repair-passes.ts`, `QUEUE_SUPPLEMENTARY_INVOICE`) calls it DIRECTLY from an operator-driven admin/CLI action that opens no transaction and takes no advisory lock; and since #3181 the payment-recovery worker calls it through `completeDeferredXeroSupplementaryInvoice` when it raises the supplementary invoice a failed additional-payment mint deferred - that worker claims its recovery row with a status-guarded `updateMany` rather than a transaction and holds no advisory lock, and its Stripe round trip has completed before this line; and since #3193 the SECOND ASK (`raiseSecondEditReviewChargeInvoice` -> `enqueueXeroSecondSupplementaryInvoiceOperation`) takes it on a review task's id, from the settlement's own fire-and-forget continuation after that settlement has committed, so it too holds nothing and takes exactly one; since #3954 the RE-ISSUED ASK's invoice (`queueReissuedAskInvoice`, `reissued-ask-invoice.ts`) is queued by the minter after its Stripe round trip and by the payment-recovery replay, neither inside a transaction nor holding an advisory lock; and since #3955 the PRIMARY-INVOICE CHANGE-FEE GAP (`queuePrimaryInvoiceChangeFeeGap`, `xero-primary-invoice-fee-gap.ts`) is queued by the outbox worker's booking-invoice handler after its Xero call returns, on the module client with no transaction or advisory lock open. Since #3641 (`INV-PAY-104`) the key has ONE spelling, `lockSupplementaryInvoiceAnchor` (anchor = the operation's `localId`), called by the enqueue and by the LATE-CAPTURE RE-QUEUE (`releaseXeroSupplementaryInvoiceForCapturedPaymentIntent`, `xero-supplementary-invoice-late-capture.ts`), which takes it on a reaper-retired operation's anchor for covered-check -> link-check -> queued-check -> revive, so a revived invoice and a fresh enqueue can never both go out (since #3953 round 8 the revive also asks `anchorCaptureHasReceipt` under that lock and revives the invoice unpaid where the capture's own receipt is linked, RUNNING or holding a stored decision - which it stores under this same key - so the capture keeps one recorder; proven against real PostgreSQL in `additional-capture-receipt.realdb.test.ts`, the revive queueing behind a plan store holding the anchor); its callers, the Stripe webhook's additional-payment handler, the confirm-modification-payment route and the waiting-invoice reaper (`xero-waiting-invoice-reaper.ts`, for an invoice whose payment already arrived), reach it after the capture is recorded, holding no transaction and no advisory lock, and no provider round trip runs inside it (the reaper's Stripe reads run in its plain loop, before and outside). Since #3953 (`INV-PAY-139`) the CHANGE-CAPTURE RECEIPT (`enqueueAdditionalCaptureReceiptOperation`, `additional-capture-receipt-enqueue.ts`) takes it on the change the capture pays for (`PaymentTransaction.bookingModificationId`, else the booking - anchors it already serialises, so no new key) for find-by-correlation-key -> who-records-this-capture (`readCaptureRecorder`, on the transaction's client) -> create of the capture's one `ADDITIONAL_CAPTURE_RECEIPT` row, so it serialises with the change's own supplementary-invoice enqueue on the same anchor; it is reached from that same release's `none-queued` branch, after the capture is recorded, from the primary invoice create's link save before its gap check (`queueReceiptsForUnrecordedCaptures`, after the link's own transaction has committed), and from the repair pass's `QUEUE_ADDITIONAL_CAPTURE_RECEIPT`, all holding nothing (and, since #4324, inside the keep's decision, below). The worker plans one receipt per booking at a time through a PLANNING GATE (review round 4, `passPlanningGate` in `additional-capture-receipt-gate.ts`): on a transaction of its own it takes this lock on the BOOKING's id - an anchor the lock already serialises, so no new key - and there looks for a LIVE receipt row on the booking already stamped `ADDITIONAL_CAPTURE_RECEIPT_PLANNING`; it waits (back to `PENDING`) for one, or stamps its own RUNNING row with that code, status-guarded, and commits. Whichever takes the lock second sees the first's stamp, so exactly one passes whatever order the outbox's claims committed in, and there is no both-wait to break (round 3's `(startedAt, id)` order read the app's clock, which is not commit order). It arrives holding nothing, holds the lock for the check and the stamp only, and runs every Xero read and write after committing; the stamp ends with the row (a wait, failure or refusal writes its own code, success clears it) and a dead row stops counting past the staleness threshold (`liveRunningXeroOperationFilter`). It also waits while a LIVE invoice create for the booking runs. Round 6: the receipt STORES its decision in a further short transaction under this lock on the change its capture pays for (else the booking), after reading who records the capture again there, and the supplementary ENQUEUE, under the same anchor, raises its invoice unpaid where a capture of the change (or the one it names) has a receipt that is linked, RUNNING or carrying a stored decision (`anchorCaptureHasReceipt`), so the two serialise on one key and one capture never gets two recorders whatever a repair sweep read. A retry whose own payment is in Xero and finds another invoice that would record the capture switches that invoice, if it has not sent, to unpaid in its own transaction under that invoice's anchor (`switchUnsentRecorderUnpaid`). Each of these transactions holds its one anchor key and nothing else - the gate's and the plan store's booking key is never held with a change's key - and no Xero call runs under any of them. Round 7 (the change a capture pays for, where its ledger row carries no stamp): REACHABLE, so settled here. Two such captures can meet an enqueue asking to record a payment - an officer's review charge (reason `edit_financial_review_charge_<change>`, no stamp), whose change the repair pass queues paid and naming the capture through `planEditReviewChargeInvoicePayment`'s `covers-ask` plan (`xero-booking-repair-classify.ts`, `queue:supplementary-invoice:<change>`); and an older member ask from before the #3954 stamp, whose change nothing records, for which the same arm with no review queues the invoice at the enqueue's default (`recordPayment` true, naming nothing). A review charge's change is read from its reason (`captureChangeId`, `additional-capture-receipt-link.ts`), so its receipt enqueue and plan store take that change's key and `anchorCaptureHasReceipt` finds it by the reason. A capture no change can be read from (`bookingHasUnattributedCaptures` - a fixed set, since every mint stamps its row, so read before any lock) stores its plan under the BOOKING's key and refuses (`change-unknown`, an officer told) where a paid supplementary invoice on the booking names no capture (`bookingHasPaidUnnamedSupplementary`); a paying, non-gap supplementary ENQUEUE on such a booking takes the BOOKING's key first and then its anchor's, and `anchorCaptureHasReceipt` counts every such capture on the booking. Round 9: only an invoice NAMING NO capture can record such a capture, so only that enqueue takes the booking's key first and only it counts them - an invoice naming its capture records that one alone. The unsent-invoice switch sets unpaid only the change's own invoice or one naming the capture, never a #3980 gap invoice (which may pay for other captures), and an officer's inline Retry of a change's invoice (`xero-operation-retry.ts`) asks again, in its own short transaction under this key on the change and holding nothing else, whether the row is now unpaid or a capture's receipt records it (`supplementaryReplayMayRecordPayment`), before its Xero call, outside the lock; round 11: where a receipt records it, that transaction sets the row itself unpaid, guarded on the unsent statuses (round 12: FAILED or PARTIAL, and only a receipt that linked its payment or stored its decision counts - a bare RUNNING one reads the row again under this key before it decides), and the late card charge's change-invoice requeue asks the same before it requeues, keeping the stored payload rather than writing back the one it read. That enqueue is one of three transactions holding more than one of these keys: it, booking -> change; #3403's move, below, booking -> change or two changes sorted; and the #3980 gap enqueue, next, its anchors sorted. No holder of a change's key takes a booking's, so no cycle. Since #4324 (4384-R2, `INV-PAY-144`) a #3980 GAP invoice's enqueue takes the key of EVERY racing edit its combined amount bills (`primaryInvoiceGap.billedChangeIds`, its anchors), sorted - the one order - and never the booking's, then asks of each whether a kept capture's own invoice bills it (`keptInvoiceBillsChangeCapture`), refusing (the treasurer's UNDERBILLED task, naming that change) where one does; every other holder of a change's key holds that one alone (the keep, the approval and the paid-another-way close, each after its task row, as its last lock) or takes the booking's key first and then change keys in that same sorted order (the supplementary enqueue, #3403's move), so the sorted set cannot cycle with them, and a keep on a non-first anchor serialises with the gap that bills it. Proven against real PostgreSQL by `kept-change-capture-record.realdb.test.ts` (the keep holding the second anchor, the gap check queued behind it). Since #4324 (`INV-PAY-144`) the KEEP'S DECISION for a kept change capture on a cancelled, invoiced booking (`planKeptLateCaptureXeroRecord`, `late-capture-kept-xero.ts`) takes this key on the change (else the booking) AFTER the #3639 approval task's row (see "Kept late-capture task row") and as its last lock - inside the dismissal's claim, and in the repair tool's `QUEUE_KEPT_LATE_CAPTURE_RECORD` transaction - and there finds the capture's receipt or kept-capture invoice, reads the change's evidence and queues one recorder (the receipt's enqueue on the same transaction, re-taking the key it holds); the APPROVAL's settlement (`settleKeptLateCaptureRecordOnApproval`) takes it the same way, after its claim and before its first outbox write (`lockKeptCaptureAnchor`), to withdraw a receipt that has stored no decision; a PAID-ANOTHER-WAY CLOSE takes it after `lock(1)`, the Payment row and the task row, inside its plan (`paidAnotherWayXeroPlan`, review CONC-1), so what records a change capture is read under it and its kept-capture invoice queued under it (`queuePaidAnotherWayXero`): lock(1) -> Payment -> task row -> anchor; and the receipt's worker, where its unlocked read finds the capture no longer kept, decides again in its own short transaction under it before any Xero call, and in every case its PLAN STORE reads the approval task again under it and, where the capture is no longer kept, closes its row CANCELLED in that same transaction (a status-guarded `updateMany` on its RUNNING claim), so a re-keep queued behind the key finds no live receipt and queues a fresh one. The supplementary ENQUEUE raises no invoice under it for a change a live kept-capture invoice bills (`keptInvoiceBillsChangeCapture`). Task row -> anchor, never the reverse, and no anchor holder takes a task row, so no cycle. Proven against real PostgreSQL by `kept-change-capture-record.realdb.test.ts`. #3947's in-transaction caller passes `recordPayment: false`, so it never takes the booking key and stays global -> (member-credit) -> one anchor key. Proven against real PostgreSQL by `additional-capture-receipt-unattributed.realdb.test.ts`: a review charge's planned receipt makes its change's paid invoice unpaid, and the enqueue queues behind a holder of the booking's key, then raises its invoice unpaid. The gap invoice never pays itself from a capture a receipt row claims, the gap invoice naming the captures it does take. It writes only the outbox row; the worker's Xero reads and payment run later, in the outbox, outside any lock or transaction. Proven against real PostgreSQL by `additional-capture-receipt.realdb.test.ts`: an enqueue queueing behind a holder of the anchor, the webhook and the confirm route racing through it, and - for the planning gate - two receipts driven through the outbox's real claim and the real worker from one barrier, of which only one reaches Xero while the other waits for it, with a dead create blocking neither and a live one blocking both. Its guarded `updateMany` writes (status CANCELLED and code `STALE_WAITING_PAYMENT`) are what make the racing callers revive once and alert at most once. Proven against real PostgreSQL by the "FORCES the revive-versus-enqueue interleaving" case in `edit-financial-review-races.realdb.test.ts`. Since #3403 (`INV-PAY-140`) the SUPERSEDED-INVOICE MOVE (`followSupersededAskInvoicesToCarrier`, `superseded-ask-invoice-carry.ts`) takes it on each change whose `WAITING_PAYMENT` invoice it re-points at the request carrying that change's balance, AND on that carrier's own key - the change its capture pays for (`captureChangeId`), else the booking - so the cover check over everything naming the carrier and the decision whether its capture's receipt already records it are one act with every other move onto it and with that receipt (review C2, C3). Order: the booking's key first, else the two changes' keys sorted; one key where they are the same change. One short transaction per change, holding those keys and nothing else, for re-read ledger and booking -> link-check -> queued-check -> carrier-cover check -> an `updateMany` guarded on `WAITING_PAYMENT`, the intent it waited on, the correlation key it read, no error code and no resolve mark. Its callers - the supersede's cancel step in the recovery worker and the Stripe webhook's cancel completion (each after its FAILED write, before the recovery row completes, or after the captured hand-off's claim committed), every superseding minter after its cancels (`cancelSupersededAdditionalIntentsNow`, after the minter's Payment-row-locked writes have committed), an edit's Xero leg after its own enqueue committed (`followSupersededAskInvoicesForIntentSafely`) and the waiting-invoice reaper's loop - hold no transaction, advisory key or row lock there, and a captured carrier's late-capture release runs after the move commits. Its RETURN (`returnMovedInvoicesToCapturedIntent`, `superseded-ask-invoice-return.ts`) runs inside that release for a kept capture of the FIRST intent, before the release reads: one short transaction per change holding that change's key alone (where such a capture's receipt decides), which asks `anchorCaptureHasReceipt` for that capture there, the same guarded write back. The unlocked restate (`restatePendingSupplementaryInvoiceAmount` from the review charge's post-commit caller) guards its write on the intent it read, and the move its write on the correlation key a raise rewrites, so neither writes the other's payload back (review C1). A price reduction's retire (`retireUnpaidAskChain`) holds the Payment row, not this key: the move's guard and the retire's `WAITING_PAYMENT` filter over every intent of the chain (re-evaluated on the moved row) decide, so whichever writes second matches nothing or retires the moved row, and the retire attributes a moved invoice by the intent it first waited on (`parkedFromPaymentIntentId`). Proven against real PostgreSQL by `superseded-ask-invoice-carry.realdb.test.ts`, each order FORCED on the key: against that retire and against the repair pass's enqueue, both orders; the move against the captured carrier's real receipt plan store on the carrier's key, both orders; and the carrier's capture and release landing while the move waits on the change's key. The retire's read-then-write and the move's in-transaction read-then-commit are not split by a hook: their exclusion rests on the guarded writes above, which the unit suites drive by landing a writer between read and write. So no ordering cycle is possible. This enumeration is written to be audited, so a new caller belongs in it before it belongs in the tree. It exists because #3170 made two review settlements of ONE edit contribute to one combined total: both restate first, both find nothing queued, and the queued-operation lookup deduped on a `correlationKey` BUILT FROM THE AMOUNT - so $200 and $30 were two keys, two operations and two invoices. The lookup is now scoped to the anchor, and an operation asking for less is RAISED through `restatePendingSupplementaryInvoiceAmount`, which refuses to lower. Note that `startXeroSyncOperation` runs on this transaction's client, so its P2002 fallback (re-read the winner's row) cannot run here - a unique violation aborts the surrounding transaction. Under this key that fallback is unreachable rather than needed: a concurrent enqueue for the same anchor is serialised behind us and finds our row through the queued-check. Residual, stated: a share settled AFTER the worker has claimed the operation (RUNNING) or after the invoice has been sent cannot join it, so the invoice bills the earlier figure and the difference is collected by hand. The enqueue reports that as `outcome: "short-sent"` (the invoice exists) or `outcome: "short-in-flight"` (the worker has merely claimed the row) and the settlement writes `booking.editFinancialReview.chargeShareUncollected` (leg `xero-invoice`) so an officer can find it - one invoice, never two, and never a silent shortfall. Proven against real PostgreSQL by the "FORCES the two-settlement interleaving" case in `edit-financial-review-races.realdb.test.ts`, which the #1881 harness runs in CI. Since #3193 that stated residual is BILLED rather than collected by hand, and the way it is billed does not add a lock site: `enqueueXeroSecondSupplementaryInvoiceOperation` is a named wrapper over this same enqueue, so the link-check -> queued-check -> write stays the one place that decides whether an ask already has an invoice going out. What widens is the KEYSPACE - the anchor is now the `BookingModification`, or the `ManualRefundTask` whose settled share the invoice bills. A second ask therefore contends with nothing: it is fenced against its own replays and invisible to every read that decides whether the booking change already has an invoice going out, which is what stops the change's own restate raising a $30 follow-on to the $230 combined total on top of an invoice already sent. One read is scoped by PAYLOAD rather than by anchor and so could have seen it - `attachPaymentIntentToWaitingSupplementaryInvoiceOperations`, which matches `requestPayload.bookingModificationId`; since the #3193 fix round it also filters `localModel: "BookingModification"`, so the separation is structural rather than a consequence of the wrapper's call-site flags. It bills that ONE share, never a difference, so two shares settling concurrently after the invoice went out queue two independent invoices for two different amounts rather than two copies of one difference. ONLY `short-sent` buys a second ask (#3193 fix round). A RUNNING row can be returned to PENDING un-attempted by exactly one route - a process-global Xero cooldown refusal, which `processXeroOutbox` un-claims because nothing was sent (an operator Requeue, and the repair pass's `REQUEUE_XERO_OPERATION` through the same helper, leave the original FAILED and replay a separate `REQUEUE` row inline; the stale-RUNNING reset writes FAILED) - and the next settlement then raises it to the COMBINED total, which already contains any share billed separately in the meantime. Since the second ask is anchored elsewhere by design, that restate cannot see it and cannot cap itself, so shares of $200/$30/$50 would bill $310 for a $280 edit. `short-in-flight` therefore raises nothing and takes the recorded-shortfall path, and the record tells the officer to compare the booking against Xero rather than to bill. |

The `MemberParentPartnerExclusion` rows are the database serialization layer for
the member-partner-link family (#3271). They are not a new advisory-lock family.
After any required member-lifecycle locks, application writers acquire every
sorted `member-partner-link:<memberId>` key, then UPSERT each canonical unordered
pair row in C order with `ON CONFLICT ... DO UPDATE` so an existing row is really
locked. Only then do they re-read parent and partner facts and write. Merge derives
the complete prospective pair set before taking this layer. The source-table
statement triggers take no advisory lock; they net all old/new edge deltas, update
pair rows in the same C order, and make a direct-SQL bypass serialize on the pair
primary key. Thus the only composed direction is member lifecycle → partner
advisory → pair row → relationship rows. The real-PostgreSQL #1881 suite covers
application/application, application/direct-SQL, direct-SQL/direct-SQL, reversed
pair lists, multi-row updates, endpoint changes, cascades, and unlink recovery.

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
  overlap and optional bed-availability checks all re-run under the key. A
  bed-holding write additionally asks, under the key, which existing whole-lodge
  holds the bed would narrow (`INV-CAP-038`, #2698) and refuses with
  `409 CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD` unless the officer has accepted.
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

**The custodian/whole-lodge-hold amendment composes TWO tiers, and only on the
accept path (#2698).** When the officer re-sends `amendOverlappingHolds: true`,
the create and the edit take the global cohort key `pg_advisory_xact_lock(1)`
**first** and `acquireLodgeCapacityLock` second — the same order the exclusive-
hold route uses (`INV-LOCK-002`) — and re-read both the assignment row and the
blocking whole-lodge holds under them before writing the assignment and the
audited acceptance in that one transaction. The global tier is what makes the
amendment decidable: the hold RELEASE path is booking cancel's
`RELEASE_WHOLE_LODGE_HOLD_UPDATE`, which serialises on the club-wide key and
never on this lodge's, so the lodge key alone would let a hold be released
between the read and the audited acceptance of an amendment to it.

Whether that tier is taken is decided from the REQUEST, before any lock —
`amendRequested` is read off the parsed body — so the order can never invert
into lodge-then-global. The detect-and-refuse path therefore keeps the narrower
pre-#2698 topology: it writes nothing, so a hold released underneath it costs
the officer a retry rather than a wrong write, and hut-leader writes as a class
do not join the global cohort.

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
- `[id]/pin/route.ts` rotates a PIN on the base client outside any lock. It
  cannot create an overlap — it changes no dates and no lodge — so it does not
  need the key.
- `[id]/route.ts`'s DELETE removes a row, so it cannot create an overlap either
  and still runs no overlap read. It **does** hold the per-lodge key since
  #2698, for a different reason: removing a custodian bed hold WIDENS the
  represented bed set of every overlapping whole-lodge hold (`INV-CAP-038`),
  because that exclusion is derived from the live holds at read time. That is a
  capacity move, and it ran on the base client outside any transaction until
  then. It now takes the key from the pre-lock row's `lodgeId`, re-reads the row
  under it, refuses with 409 if the row moved lodges in between, and deletes and
  audits in one transaction. **That 409 is new** — the delete's response
  contract gained one refusal, and the Hut Leaders page surfaces it as a
  page-level error rather than leaving the officer clicking Delete with nothing
  happening.

**The cron's coverage probes are a fifth decision point, and they are
deliberately NOT the same rule** (#2926). `cron-hut-leader-auto-assign` asks two
questions per (lodge, night): *is this night already covered?* — since #3818
`isHutLeaderNightCovered` from `hut-leader-night-cover.ts` (an assignment claims
the night AND its leader is staying it, `INV-DATE-031`), asked once cheaply on
`prisma` and once again on `tx` under the key; it is two reads and takes no lock
of its own — and *would this assignment overlap?*, which is the shared predicate. The
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
write, which is why they are named above, but `hut-leader-coverage.ts` (all of
them now through the one `hut-leader-night-cover.ts` helper, where a teacher row
is present on its school booking's nights), the
admin page's uncovered-dates panel and the `eligible-members` suggester all ask
the same "is somebody on site that night?" question, and all of them should keep
counting a teacher. The consequence to know about is a conservatism, not a
defect: on a night a school group occupies, the suggester still reports the
member as fully covered and offers no range, even though the POST would now
accept one. An officer who wants a leader beside the teachers adds the
assignment directly and is no longer refused. Anything NEW that refuses a write
on the strength of an overlap belongs behind `findHutLeaderOverlapRefusal`
rather than behind its own read.

**The custodian exemption reads the cover under the same key (#3821).** When a
clash pairs a custodian row with an ordinary one — either may be the existing
row or the proposed row the caller passes as `candidate` — the predicate loads
`hut-leader-night-cover.ts` on the client it was given and leaves out the
school nights the custodian does not cover and the ordinary row does, then
applies the one-night rule to each remaining run. Two custodians are never
exempted from each other. These are reads on the transaction client after
`acquireLodgeCapacityLock`, like the overlap read itself: no new key, no new
order, and nothing is read unless a custodian clashes with an ordinary row.
The cron passes its ordinary CRON row as `candidate` and writes no custodian;
its span is cut to the nights the member may lead (`leadableNightRun`),
re-read on `tx` under the key before the locked overlap ask.

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

**One sorted set per call is not one sorted set per transaction (#3232).**
`lockRosterDates` sorts the dates it is given, so any two writers that each take
ONE set are safe against each other. A caller that composes two booking writes
into one transaction takes TWO sets: `runLinkedDateMove` moves a member's booking
and the booking of theirs that was relying on it for adult supervision, and each
`modifyBookingBatch` derives its own envelope. It can therefore hold a later date
from the first booking's set and then ask for an earlier one from the second
booking's — an inverted acquisition against a writer arriving from the other
direction. What makes that safe is the global key, and it is a constraint on new
writers rather than a happy accident: **every writer in the tree that acquires
more than one roster-date key holds `pg_advisory_xact_lock(1)` for the whole
transaction first** — both booking modification services, guest removal, the
kiosk departure route, and `chore-cleanup`, which is only ever called from inside
the first two. Two multi-key roster acquisitions therefore cannot interleave, and
a writer holding a single roster key cannot complete a cycle in this family. A new
multi-key roster writer that skips the global key would break this, so it must
take it.

The three roster-aware booking modification paths continue into the optional
member-night and member-credit tiers only after their roster-date set is held,
then call the same-owner hosting reconciler last. Guest removal likewise reaches
the hosting reconciler only after its sorted roster-date locks, guest deletion
and any applicable member-credit write. Thus their concrete composition is
global → lodge → roster-date → applicable member keys → coverage-group →
coverage-owner. This is
not a claim that every booking writer takes every tier: create, confirm, cancel,
membership fan-out and drain paths omit the roster and/or member keys they do
not use. The invariant is that a path which does compose them never takes a
roster-date or member key after the coverage-group or coverage-owner key.

**The coverage-group tier is different, and it is NOT ordered by that rule
(#3039).** An earlier draft of this paragraph said the tree "never takes the
coverage-group key after the coverage-owner key". That is untrue at a live site:
`inspectSameOwnerDependents` runs inside `settleSameOwnerDependentCoverage`, which
already holds the coverage-owner key, and it evaluates a same-owner dependent that
may sit in a DIFFERENT Group Trip — reaching a coverage-group key with an owner key
held. The claim was unenforceable as well as false, which is why it has been
replaced by the property that actually holds and actually makes the tier safe:

> **No transaction ever WAITS on a coverage-group key.** Every acquisition is a
> `pg_try_advisory_xact_lock` that returns immediately, and only after it succeeds
> is the blocking form called — where it is a re-entrant no-op, because an advisory
> xact lock cannot be released before commit. A lost try rolls the whole outer
> transaction back with the stable `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409.

A tier nobody waits on cannot appear in a wait-for cycle, whatever order it is
taken in relative to any other family. That is why there is no deadlock. The
documented `coverage-group -> coverage-owner` order still matters, for a different
reason: the trip's membership is what decides WHICH owner keys the fan-out will
need, so taking the owner keys first would take them against a sibling set that
could still move. Order buys a stable fan-out; the fail-fast try buys
deadlock-freedom. `acquireHostingCoverageGroupKey` is the single function that
composes the two calls, and
`adult-member-hosting-coverage-lock.test.ts` censuses that no other site may.

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

**Acquisition order: the coverage-owner key is last among the application locks a
caller actually takes, and since #3039 it is the second of the last two.** It
follows `pg_advisory_xact_lock(1)`, `acquireLodgeCapacityLock`, roster-date locks,
`lockBookingMemberNights` and member-credit locks wherever those families
participate, and it follows the per-TRIP `hosting-coverage-group` key — see "Group
Trip coverage takes a per-trip key, above the owner key" below. This paragraph
said "always last" until #3039 added that key; the sentence was rewritten rather
than left standing, because an ordering claim that no longer describes the tree is
what makes the next lane compose a new key on the wrong side of it. The roster-aware batch,
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

**Since #3039 that fence spans OTHER ACCOUNTS, which widens one counterpart
interaction and it must be declared rather than discovered.** Under
`SAME_GROUP_TRIP` the fence's planned source set is the changed booking plus every
dependent booking in its Group Trip, so the one `FOR KEY SHARE NOWAIT` statement now
locks up to `GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT` + 1 `Member` rows belonging to
people the actor has no relationship with.

`FOR KEY SHARE` is self-compatible, so this does NOT serialise two trip members
editing their own bookings concurrently — that was the reason for choosing it and it
still holds. It DOES conflict with `FOR UPDATE`, and the standing-subject barrier
`lockHostingCoverageMemberLifecycleTarget` takes `FOR UPDATE NOWAIT`. So the widened
set creates a two-way interaction that did not exist before:

- an admin **deactivating, archiving, deleting or merging any member of a Group
  Trip** can be refused with the stable retry 409 by an unrelated member's booking
  edit in that trip;
- and the reverse: a member's booking edit in a trip can be refused while such an
  admin action holds one of the trip's `Member` rows.

Both are transient, both are the stable `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409
telling the caller to reload, and neither can half-write: the whole outer transaction
rolls back. It is the accepted cost of the epic's requirement that the queue name
every affected sibling owner in bounded form — an item naming a `Member` row this
transaction never locked is exactly what
`assertHostingCoverageQueueParticipantsLocked` exists to refuse. The bound matters
here as well as in the queue: it is what stops a trip-sized fence becoming a
lodge-sized one. A club that has not enabled `SAME_GROUP_TRIP`, and any booking in no
trip, locks exactly the rows it locked before.

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
session-level setting the caller had made. **On the connections this code runs
on, `DEFAULT` still resolves to `0`**, so restoring it is byte-for-byte the old
behaviour and remains hardening against a deployment that adds a bound rather
than a live bug. Since #3377 one connection in this deployment DOES carry a
`lock_timeout` — the `migrate` service's, described under
["The migration lock timeout"](#the-migration-lock-timeout-3377) below — but
that service runs `prisma migrate deploy` and no application code, so it never
reaches this helper. PostgreSQL raises a `lock_timeout` cancellation as
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

#### Group Trip coverage takes a per-trip key, above the owner key (#3039)

`SAME_GROUP_TRIP` (#3038) makes one booking's compliance a function of a booking on
ANOTHER ACCOUNT, so it gets its own advisory-lock family: `hosting-coverage-group`,
keyed on `GroupBooking.id`.

**The owner key cannot do this job, and #3038 said so at the point where it declined
to invent half of one.** The owner key is `Booking.memberId` — the DEPENDENT's own
account. Every Group Trip source belongs to somebody else, so two transactions
changing two different bookings in one trip hold two DIFFERENT owner keys and are
not serialised by them at all; at READ COMMITTED each can then observe a state the
other has already invalidated, one removing the last qualifying adult while the
other reads that adult as cover, with the outcome decided by commit order. That is
the non-determinism #2576 §9 forbids, one account further out.

**Not the lodge key, and not the organiser.** One lodge holds many unrelated trips,
so a per-lodge key would serialise all of them against each other for a rule that
concerns one party. The organiser's member id is a person, who may hold other
bookings in no trip. `joinCode` is a credential and never an identity. The
contention domain is the trip, so the key is the trip (`INV-LOCK-001`).

**Order: group BEFORE owner — and the order is about a STABLE FAN-OUT, not about
deadlocks.** The composed order at a booking writer is global →
lodge → roster-date → member-night → member-credit → queue-participant
`Member FOR KEY SHARE NOWAIT` rows → **coverage-group** → coverage-owner, with every
path omitting the tiers it does not use. Group first because the trip's membership is
what decides WHICH owners the reconciliation fan-out will name: the owner set is not
known until the trip key is held, so taking the owner keys first would take them
against a sibling set that could still move. This is why the owner key's "always
last" is now "the second of the last two" everywhere it was stated.

**That order is not a global invariant, and must not be written as one.** One live
site takes the group key with the owner key already held:
`settleSameOwnerDependentCoverage` holds coverage-owner and calls
`inspectSameOwnerDependents`, which evaluates a same-owner dependent booking that may
sit in a DIFFERENT trip, and that evaluation takes that trip's key. It is harmless
— see the fail-fast paragraph below, which is the whole reason — but a document
claiming the reverse order never happens would be claiming something the tree
contradicts, and the next lane composing a new key would compose it against a rule
that is not real.

**Every acquisition is tried fail-fast before it is taken blocking**, and here that
is the primary form rather than hardening. A trip key is shared with other accounts,
so a blocking wait is one member's booking transaction stalled by another member's
edit — and, worse, one transaction can legitimately need two trip keys (a booking in
one trip whose same-owner dependent sits in ANOTHER trip), which sorting within a
single call cannot order. `pg_try_advisory_xact_lock` turns that hold-and-wait edge
into an immediate loss: the caller rolls its WHOLE outer transaction back and answers
the stable `HOSTING_COVERAGE_PARTICIPANT_RETRY` 409. The blocking call that follows
is re-entrant on the same session, so it costs a round trip and no wait; it is
retained because it is the acquisition the lock inventory recognises, and because on
a client with `$executeRaw` but no `$queryRaw` it is the call that actually takes the
key. Several trips within one call are taken in sorted order, the same discipline the
owner and member-night keys use.

**This, and not the acquisition order, is the deadlock argument for the coverage-group
tier, and it is a STRONGER guarantee than an order could give.** The try never waits;
an advisory xact lock cannot be released before commit; so the blocking call after a
successful try is a re-entrant no-op. Therefore **no transaction ever waits on a trip
key at all**, and the coverage-group tier cannot appear in a wait-for cycle regardless
of where it is taken relative to any other family. Delete the try from
`acquireHostingCoverageGroupKey` and a real deadlock exists: T1 (a drain item for
owner M1, trip G) takes group(G) and blocks on owner(M1), while T2 (a writer on M1's
booking in trip H) takes group(H), wins owner(M1), and reaches group(G) through
`inspectSameOwnerDependents`. PostgreSQL kills one with `40P01`, which is neither
`55P03` nor the retry error — so it surfaces as a raw 500 rather than the stable
409. `acquireHostingCoverageGroupKey` is the ONE function permitted to acquire this
key, precisely so that `if` exists in exactly one place; the census in
`adult-member-hosting-coverage-lock.test.ts` fails on any other acquisition site and
on the deletion of that `if`.

**Plan, then lock, then re-verify, then retry.** The trip's dependent bookings are
planned BEFORE the participant fence, because the fence has to lock every owner the
queue will name and those owners are exactly what the plan discovers — so the plan is
necessarily unlocked, and therefore a hypothesis. `lockAndVerifyGroupTripCoverageDependents`
takes the trip key and re-reads the same bounded, ordered set; a changed fingerprint
(booking id, owner or lodge) is the stable retry rather than a guess. This is the
same protocol `enqueueHostingCoverageReevaluationForMember` uses for its own
candidate set, deliberately, because a second protocol for one hazard is a second
thing to get right. Rereading WITHOUT the shared key would not do: that is the case
#3039 was opened to close.

**Where the key is taken.** `evaluateBookingAdultMemberHosting`, before it reads a
sibling booking as cover, and only when the lodge has `SAME_GROUP_TRIP` enabled and
the booking resolves to a trip; and the two enqueue seams,
`reconcileAdultMemberHostingReviewWithSiblings` and
`enqueueOwnHostingCoverageReevaluation`, which take it before the owner key and hold
it across the fan-out. Both spellings are minted only in
`adult-member-hosting-coverage-lock.ts`, registered in
`SCOPED_ADVISORY_LOCK_INVENTORY` (`INV-LOCK-003`), and taken by no other module. A
club that has not enabled the scope never takes the key, and neither does an ordinary
booking at a club that has: a booking in no Group Trip has no key to take.

**Compatibility with #3038's write-skew argument.** That child established that the
eleven writers which can add or remove group cover all already hold
`pg_advisory_xact_lock(1)` AND the per-lodge key, and that a trip is confined to one
lodge, so the two-member skew cannot occur today. The trip key orders the fan-out
#3039 introduces; it does not plug a hole #3038 opened. **A lane that later narrows
one of those writers off the global key onto a scoped key must take the trip key
first**, or it re-opens the skew that serialisation is currently preventing.

**Group cover is same-lodge by construction, which is why the mode gate needs no
group widening.** Every group read composes `groupTripMembershipWhere` INSIDE the
shared coverage envelope, whose first clause is `lodgeId: booking.lodgeId`. So a
Group Trip sibling that can supply or receive cover is always at this lodge, under
this lodge's policy, and the changed booking's own resolved mode speaks for the whole
trip. A #738 split sibling is different — `hostingSiblingWhere` carries no lodge
clause — which is why #3209 teaches the same gate to consider a related booking's
lodge. The two are independent: #3209's widening is correct, and a group clause
beside it would be dead code no group read could exercise.

**The fan-out itself, and what the actor is told**, are `INV-HOST-046` rather than a
locking rule, and are stated there: one bounded item per dependent booking naming
that booking as its own source, cause `SYSTEM_CHANGE`, no refusal of any kind, and no
sibling identity in the actor's answer.

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
`modify-quote` (at #2543, seven or more pricing passes, two differenced into the
member's settlement delta) is a money error rather than a nuisance. See the
`INV-LOCKOUT` rules in `docs/invariants/subscription-lockout-pricing.md`.

#### Which client reads the Xero lock dates (#3232)

Not a database client at all, which is why it is the sharpest case of this rule.
The ordinary date-edit guard (`assertProposedDateEditClearsXeroLockDate`, #1729)
consults the club's persisted timezone, its module flags, its Xero connection
and — on a cold or expired cache — `getXeroLockDates()`, a live HTTPS request to
Xero with a possible OAuth refresh. It has always been documented as a call that
must sit outside any transaction, and it did: `modifyBookingBatch` calls it in
its preamble, above `withOptionalTransaction`.

**Above `withOptionalTransaction` is not outside the transaction for a caller
that supplies one.** That helper runs its callback on the caller's `tx`, so on
the caller-transaction path the global money key and the per-lodge capacity key
are already held when control enters the service — and the preamble's three
reads, the provider request among them, ran under both. #2525's approve-and-
execute path had that exposure from the start; #3232's linked move made it a live
member API on both date doors, twice per transaction, and this file's own rules
forbid a provider call there outright.

The remedy is the same "resolve first, pass a value" shape as the two sections
below, with one addition the linked move forces. It composes TWO booking writes
and discovers the second **under its locks**, so "call the guard for each booking
beforehand" is not available to it. The guard is therefore split: the club and
provider facts (`resolveXeroLockDateFacts`) resolve outside any transaction into
ONE value that covers every booking, and the per-booking decision
(`assertDateEditClearsXeroLockDateFromFacts`) is synchronous arithmetic over the
booking row, which a caller may safely run under its locks — and does, against
the post-lock row rather than a pre-read one. A caller that can enumerate its
check-ins passes them and usually pays nothing, because only a retroactive
check-in is guarded at all; a caller that cannot resolves the facts over EVERY
booking instead.

**And a caller-transaction caller has no choice about that, by construction.**
Given an enumerated candidate set the resolver short-circuits to
`not-applicable` when none of them is retroactive, and the decision then returns
without looking at the booking at all — so enumerating on a path that discovers a
booking under its locks would hand the guard a set that does not contain the
booking it is about to judge, and a retroactive invoice would be re-dated into a
closed accounting period with no refusal at all. The only function that can build
the caller-transaction value, `prepareBatchModificationForCallerTransaction`,
takes no candidate set, and its result is branded so nothing else can construct
one. The audience the refusals are worded for rides on the facts for a related
reason: the captured read-failure error is worded at resolve time and cannot be
re-worded later, so a decision taking its own audience would honour it for the
locked-period refusal and ignore it for the other — disclosing the club's Xero
connection state to a member.

Alongside it, `modifyBookingBatch` now **refuses a caller-supplied transaction
without a `preTransaction` value** carrying those facts, the member-guest add
policy and the subscription-lockout mode. That refusal is the enforcement: there
is no position inside a transaction-aware function that is outside the
transaction on every path, so the only safe rule is that the answers arrive from
whoever owns the commit. `lock-bound-club-zone-outside-transaction.test.ts` bans
the resolvers themselves from every such module except its one named
pre-transaction function — the frame that census was previously stopping one
short of, which is how three indirect readers sat in a preamble under two locks
with a green suite. Its list of banned resolvers includes the guard's own
module-client booking read (`readXeroLockGuardDateEditBooking`), which was missing
from it: a second pooled connection taken under both keys is the same hazard as
the settings reads beside it, and the only thing stopping it being called from
inside a transaction was that nobody had.

#### Which client reads the club's timezone (#2870)

The same rule again, and the one place it decides whether a member keeps a bed.
A payment link expires at the end of the check-in day in the club's **persisted**
timezone (`INV-CONFIG-002`), and four decisions read that one boundary: the mint
in `payment-link-reissue.ts` / `payment-link-split-guest.ts` /
`booking-request.ts` / `group-booking.ts`, the refusal to
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
inbound reconcile's late capacity cancel (#3792) does the same: the reconcile
takes its lodge key and then the member key at the top of its transaction
(global → lodge → member), before its first `Payment` write, and the cancel
throws the busy error, so the inbound event retries after its backoff, and
restores the applied credit under the member lock. Hold
expiry also re-reads the booking's invoice-payment links recorded since its
live Xero read, under both locks before its first write, and keeps the hold if
one exists (`INV-PAY-107`, #3643). The inbound link write takes no booking
lock, so this narrows the race rather than serialising it; the clearing-note
builder's shortfall refusal is the backstop. The live read runs before the
transaction, never inside it. The paid cancel path's claim may now also record
a part payment Xero showed (read before the claim) as the payment's captured
row and queue the unpaid rest's clearing-note outbox row, under the same
lock(1) and lodge lock it already holds; it first re-checks, the same narrowing
way, for payment links recorded since its read, and throws to roll back on any
change. No lock is added. The
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
`settled + reserved` can never exceed the budget at a fixed rate. Since #3354 the
same locked transaction also reads `AiSpendCurrencySettings` through `tx`, in the
same snapshot as the budget, and sizes the reservation at that rate; an
administrator changing the rate between one roundtrip's reserve and its settle
can therefore overshoot by that one roundtrip scaled by the change (budget
10000, settled 9000, a 900 reservation at 0.90, the rate raised to 5.00
mid-call, a 400 NZD-cent settle books 2000 → 11000), and by nothing more. A lost
claim (over budget) inserts nothing and denies the paid call (no side effect),
exactly like the status-guarded `updateMany` claims elsewhere in this document.

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
only where the lock key can change under you. Booking creation used to lock on
`PromoCode.code` and check the count for this reason; since #3827 it resolves
the code to its immutable id first and refuses a row whose code changed in
between, so every site below keys on an immutable cuid (or materialises its
singleton before locking) and cannot see a row appear between the two
statements, except the message-board mirror's post lock (#4586), which keys on
the mutable `ClubPost.serverPostId` and reads a zero count as not found.

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

- **Held-party guest rows before a dietary rebuild** —
  `src/lib/booking-guest-row-lock.ts` (`lockBookingGuestRowsForUpdate`, #3029
  C3): when a booking-request approval deletes and recreates a held party
  because its head-count changed, `planHeldPartyRebuildDietary` first takes
  `SELECT 1 FROM "BookingGuest" WHERE "bookingId" = … ORDER BY "id" FOR UPDATE`,
  then reads each row's dietary/allergy value through the model and carries it
  by identity. Counterpart writer: the admin guest-dietary edit
  (`PATCH /api/admin/bookings/[id]/guest-dietary`), a single-row occupant-matched
  `updateMany` that holds no advisory key. An edit that committed first is read;
  one that arrives later waits on the row lock and, once the rebuild commits,
  matches no row and is refused — never lost while audited as a success. Order:
  the approval already holds `pg_advisory_xact_lock(1)` and the lodge capacity
  key, so global -> lodge -> BookingGuest rows; rows are taken in id order.
  The in-place rewrite (same head-count) takes the same lock before it reads
  the stored values it keeps or replaces (#3029 F1). `bookingId` never changes
  on a guest row, and every writer that INSERTS a guest into a party takes the
  global key first, so no row can appear unlocked between the lock and the
  read. Member merge takes no global key; it never inserts a guest — it
  re-points existing rows' `memberId` — and it serialises with the approval on
  the lodge capacity key.

- **Booking-ledger back-post** — `src/lib/booking-ledger-back-post.ts`
  (`lockBookingForBackPost`, #3583): the operator back-post posts a historical
  booking's ledger lines on a live database, one booking per transaction. It
  takes `pg_advisory_xact_lock(1)` (the key every settle, cancel, edit and
  closure posts under), then `SET LOCAL lock_timeout = '5s'` so no later wait
  holds the global key for long (a booking that times out is rolled back and
  listed `LOCK_TIMEOUT` for a re-run), the booking's lodge key, then reads the
  owner — only now, because member merge re-points it holding the lodge key
  (the settle's order since #3792) — the member credit-ledger key of every
  member its credit rows name (sorted), then `SELECT 1 FROM "Payment" …
  FOR NO KEY UPDATE` and `SELECT 1 FROM "Booking" … FOR NO KEY UPDATE`, and
  re-reads everything under them. Payment before booking is the order of the
  one settlement writer that reaches the ledger without lock(1), the card-refund
  writer (`lockPaymentForRefundedTotal`); `NO KEY UPDATE`, not `UPDATE`, so the
  foreign-key share lock a concurrent writer's ledger line takes on the booking
  is never refused. Taken booking-first with `FOR UPDATE`, the back-post and a
  live card refund deadlocked on real PostgreSQL; either change alone cleared
  it in the race suite, and both are kept.
  Both statements may match nothing (no payment), which reads as nothing to
  lock. Raced against a live date shift and a live card refund in
  `booking-ledger-back-post.realdb.test.ts`.
- **Kept late-capture task row** — `src/lib/xero-kept-late-capture-invoice.ts`
  (`lockKeptLateCaptureTask`, #3635): `SELECT 1 FROM "ManualRefundTask" WHERE
  "id" = … FOR UPDATE` on the #3639 approval task. Taken by the kept-capture
  enqueue (inside the dismissal's claim, which already holds the row through
  its status-fenced `updateMany`, and by the repair tool in a transaction of
  its own) around its re-read and find-and-create, and by the outbox worker
  around its send-time decision and the withdrawal it commits with it. Since
  #4324 (`INV-PAY-144`) the keep's decision (`planKeptLateCaptureXeroRecord`)
  takes it FIRST - a no-op inside the dismissal, which holds it - re-reads
  the task there (still DISMISSED), and for a change capture on an invoiced
  booking then takes the change's supplementary-invoice anchor as its last
  lock; the repair tool's `QUEUE_KEPT_LATE_CAPTURE_RECORD` runs it on a
  transaction of its own, so the dismissal and the repair serialise here
  (proven in `kept-change-capture-record.realdb.test.ts`).
  Counterpart writers: the dismissal, reopen and approval claims, which write
  the same row. So a re-keep either finds the live row or, once the worker has
  withdrawn it, queues a new one, and two enqueues can never both insert (the
  active-correlation index therefore never raises inside an interactive
  transaction). Since #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then
  credit") two more take it. A "Paid another way" close of the capture's
  approved card refund takes it third - after `lock(1)` and the Payment row -
  BEFORE it reads whether Xero has the capture's receipt, and queues the
  receipt under it when there is none; since #4324 (review CONC-1) a change
  capture's close takes the change's supplementary-invoice anchor right after
  it, so that read and the queue are made under both. The worker, once its invoice is in Xero,
  takes it again in a short transaction that writes the receipt's link, and
  again in a second that queues a waiting close's bank-transfer note (#3924
  round 7). A change's supplementary invoice released for the capture takes it
  for the same note step once the invoice is sent (round 8), after its own row
  completes - also when an officer's retry of a FAILED one runs it again from
  its own row through the outbox (round 9). The repair tool's
  `QUEUE_PAID_ANOTHER_WAY_REFUND_NOTE` (round 8) and the nightly credit
  check (round 9) run the same step, each in a transaction of its own.
  So a close either reads the receipt in Xero and queues its own note, or
  commits first and is found by the note step; neither can miss the other. It
  adds no cycle: inside the dismissal it is a lock that transaction already
  holds, the worker takes no other lock while holding it, the repair tool
  (and, #4324, the keep's decision and the approval's settlement) take only
  the change's anchor after it, and the close takes it after `lock(1)` and the
  Payment row - and, #4324, re-takes it just before a change capture's
  kept-capture invoice and then that change's anchor. The approval
  task's own resolution and reopen claims take `lock(1)` first or not at all,
  never after the task row (`resolveManualRefundTask#1`,
  `reopenManualRefundTask#1`); no holder takes
  `lock(1)` or the Payment row after the task row. No provider call is made
  while it is held.

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

- `booking-create-promo.ts` (`resolvePromotionsInTransaction`) takes every code
  a create applies through the same id-keyed protocol as the modification paths
  (#3827): it resolves the typed codes to ids UNLOCKED, locks the rows with
  `lockPromoCodeRowsForUpdate` in ONE sorted-id call, and re-reads them by id
  under that lock (lock raw, read typed — #2289). A row whose `code` no longer
  reads as typed — renamed between the resolve and the lock — is refused as
  "Promo code not found", and a code created or renamed TO the typed text after
  the resolve is never locked, never read and likewise not found; that is the
  outcome the former code-keyed `FOR UPDATE` gave its zero-match case. Booking
  creation has already taken `pg_advisory_xact_lock(1)` and the per-lodge
  capacity lock, so the order is lodge -> promo rows in sorted-id order, and a
  two-code create orders its rows exactly as every other writer does
  (`multi-promo-pricing.test.ts` pins it). No counterpart writer may take a
  promo row and then a lodge lock. The waitlisted create prices before its
  transaction, unlocked, as it always has; the offer re-prices under locks.
  Inside its transaction it holds the lodge key but not `lock(1)`, and each
  redemption's counter write row-locks its code, so it locks every code row
  in one sorted call after the lodge key, before the first redemption (#3827):
  two waitlisted creates naming the same codes in opposite orders would
  otherwise deadlock. No cap is re-read there; the counter write is an atomic
  increment and the offer decides the caps.
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
  lodge -> promo row. Since #3827 the four share ONE re-price
  (`repriceBookingPromotions`, `src/lib/booking-promotions.ts`): a booking
  carrying several codes has every code row locked in one sorted call before the
  first cap read, then each counter re-read under it; the batch path locks its
  outgoing, kept and incoming codes in one sorted call. A guest's acceptance
  (`booking-guest-acceptance-reprice.ts`) re-prices the same way inside the
  consent transaction, after its `pg_advisory_xact_lock(1)` and lodge lock. The
  in-progress arm of `applyPromoCodeChanges` re-prices no code (#4317 review
  round 4): where its plan capped a carried promotion it scales the stored
  redemptions (`capCarriedPromotionRecords`, `src/lib/carried-promotion-cap.ts`),
  locking every code row in one sorted call first, under the same `lock(1)` and
  lodge key, because the shared writer may lower a counter; it reads no cap. The reprice wrapper also **re-reads
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

- **Alpine Central Server connection and version recorder** —
  `withServerNzConnectionTransaction` (`src/lib/servernz-config.ts`, #4436)
  runs request capture, address replacement (`saveServerNzConnectionSettings`,
  the settings route) and key replacement (`setServerNzApiKey`, the credentials
  route) under `lockServerNzSettings`. It materialises the singleton
  with `createMany(skipDuplicates)` before locking, then reads mutable state.
  Order: settings row first, credential row second, credential audit last;
  there is no advisory key (`INV-LOCK-001`, `INV-LOCK-002`, `INV-LOCK-003`).
  Address replacement commits the new address, credential deletion (and its
  audit) and answer reset together. Key replacement likewise resets answers
  in its credential transaction. The fence hands its work a branded
  `ServerNzConnectionTx`, and the address write, key removal and answer reset
  require that type, so a call outside the fence does not compile. Request
  builders read the address and uncached decrypted credential through that
  transaction client, release the lock, then send HTTP using the captured
  identity. A warmed cross-process credential cache cannot pair an old key
  with a new address.
  Every request therefore serialises on the settings row's `FOR UPDATE`; the
  hold is short, two reads and no HTTP, so requests queue only briefly.
  `recordServerVersionIfCurrent` (`src/lib/servernz-version-record.ts`, #4366)
  takes the same settings lock after HTTP, re-reads the address and credential
  version and records only for the captured identity. A recorder first has its
  answer cleared by replacement; a replacement first makes the recorder reject
  the old identity. Both transaction boundaries allow a 150s timeout and 10s
  pool acquisition maxWait, including a bounded wait behind a lodge merge.
  The recorder alone can see an absent row and then records nothing. Other
  settings writers take no credential lock, so cannot invert this order.
  Since the #4262 review the fence is one helper,
  `withCurrentServerNzConnection` (and `serverNzAnswerWriter`, which throws
  `ServerNzConnectionChangedError` on a refusal), in the same module: the
  version recorder and every write of the Other lodges download (below) run
  through it, in the same order. No HTTP runs inside these transactions
  (`INV-INT-027`), and they remain disjoint from booking/capacity/credit and
  money clusters. The #4436 race suite forces a sync and address move in both
  orders, including a warmed old-key cache, and a sync holding the old address
  while the move and a new key's save queue behind it.
  Since #4470 four more writers join, with no new lock. Key replacement
  carries the address its setup page showed and, after the settings lock,
  re-reads the stored address. It refuses with `ServerNzAddressChangedError`
  (the credentials route's 409), having written nothing, when another save
  moved it, so a key issued by the old server never lands beside the new
  address. A key saved first is removed by the move queued behind it.
  Address replacement also deletes the old server's `push_secret` in its
  transaction, after the API key (settings row, `api_key` row,
  `push_secret` row, audit); key replacement deletes it after the new key
  (settings row, `api_key` row, `push_secret` row, answer reset, audit). `ensurePushRegistration` stores a newly issued
  secret through `serverNzAnswerWriter` for the identity its registration
  was sent on (settings row, credential read, `push_secret` write, audit),
  so a registration in flight across a move stores nothing and the next pass
  registers with the new server. The message-board mirror (`runMirrorSync`)
  writes each page through `serverNzAnswerWriter(page.sentOn)`: post
  create/update/removal, failure count, cursor and last-sync time, each one
  short transaction (settings row, credential read, then the `ClubPost` row
  lock and re-read before any `ClubPostImage` row, or the settings write; see
  "Message-board posts and their images" below). Every cursor and
  failure-count write also re-reads the stored cursor pair and failure count
  under the lock and refuses if any moved since the pass read or last wrote
  them (`writePosition`). A refusal stops the pass; its single-flight claim
  (`commsSyncStartedAt`) stays on the global client. Since #4586 the release
  is an `updateMany` matching the exact stamp the claim wrote, so a pass whose
  claim went stale and was taken over clears nothing, and the second pass's
  claim stands until it ends. Since #4588 every page write also re-reads that
  stamp under the settings-row lock and refuses once another pass holds the
  claim, so a taken-over pass writes nothing more and stops as
  `claim-taken-over`. The three recorders in
  `servernz-settings.ts` (download, upload watermark, version) require a
  branded `ServerNzAnswerTx`, which only `withCurrentServerNzConnection`
  mints after its identity check, so calling them outside the fence does not
  compile. The download's and the mirror's other writes are held to the fence
  by source censuses (`servernz-version-record.test.ts`,
  `club-post-mirror.test.ts`), not by type. The race suite forces a key save
  against a move in both orders, an address move under an in-flight download
  and under an in-flight mirror page, a push registration across a move, and
  a key replacement removing the push secret.
- **Owned-lodge list writer, and every Other lodges download write** —
  `src/lib/servernz-settings.ts` (`lockServerNzSettings`, #64), through the
  connection fence above (#4262 review): `downloadOtherClubsFromServer` builds
  one `serverNzAnswerWriter` for the identity its pull was sent on
  (`OtherLodgesPullResult.sentOn`: the stored address and API-key credential
  version captured before the request), and EVERY write it makes from the
  answer goes through it: the hides of deleted lodges with their unlinks and
  audit row (one transaction), each merge's create, keying and guarded update
  (`mergeDistributedLodge`), and the record step. Each is one short
  transaction that takes `$executeRaw`SELECT 1 FROM "ServerNzSettings" WHERE
  "id" = $1 FOR UPDATE`` first, re-reads the address and credential version,
  and writes only while both are unchanged; otherwise it throws having written
  nothing and the download stops, recording nothing. So an answer from a
  connection replaced while the request was in flight hides, unlinks, creates
  or renames nothing, not only its cursor and owned list. Order: settings row,
  credential read, then `OtherLodge`/`Amenity`/`Lodge` rows and the audit row;
  the admin other-lodge writers take no settings lock, and the Central lodge
  writer takes the settings row before its `Lodge` row, so none inverts it.
  The record step also re-reads the cursor and keyed
  marker under the lock, so a download that ran while another recorded writes
  nothing back. Since #69 the owned list is stored by central id as the server
  sent it, so an admin's rename of the club's own lodge no longer rewrites it
  and no longer takes this lock. Singleton-keyed; no advisory lock; disjoint
  from the booking/capacity/credit and money clusters. A missing settings row
  refuses every fenced write (no stored address matches).
- **Other lodges upload watermark** — `uploadOtherClubsToServer` (#4485)
  records through `serverNzAnswerWriter` using the identity from the sender
  captured by `prepareOtherLodgesUpload`. Row selection uses its settings snapshot,
  so replacement before capture cannot carry an old watermark
  onto the new connection. The provider call finishes before the settings-row
  fence is taken; the order is settings row, credential read, watermark write.
  A replaced connection refuses the write. Connection replacement clears both
  Other lodges transfer positions and the shared-feed cursor and poison tracking
  in the same transaction as the address or key change.
- **Central lodge link writer** — `PUT /api/admin/lodges/[id]/central-lodge`
  (#62; #4262 review): in one transaction it first takes the settings row lock
  (`lockServerNzSettings`) and re-reads the owned-lodge list under it, so a
  download recording a new list (which unlinks deleted ids under the same
  lock) cannot land between the ownership check and the write; then it takes
  `$executeRaw`SELECT 1 FROM "Lodge" WHERE "id" = $1 FOR UPDATE``, re-reads the
  link it is replacing, writes the new `Lodge.centralLodgeId`, and writes its
  `LODGE_CENTRAL_LINK_UPDATED` audit row on the same transaction client. Order:
  settings row, then `Lodge` row — the Other lodges download's own order (its
  hides and record-step unlink), so neither can wait on the other in reverse.
  Two saves serialise, the second reads the first's link as its "before", and
  no audit row describes a transition that never happened. A save refused for
  ownership (400) writes nothing; one refused by the unique index (409) rolls
  back; neither leaves an audit row.
  The transaction uses the settings fence's bounded wait
  (`SERVERNZ_TRANSACTION_OPTIONS`). No advisory lock; disjoint from the
  booking/capacity/credit and money clusters.
- **Message-board posts and their images** (#4586, #4588): every writer that changes
  both a `ClubPost` row and its `ClubPostImage` rows takes the **post row
  first**. `ClubPostImage.postId` cascades on delete, so a post delete reaches
  the image rows after the post. Taking the images first deadlocked an admin
  removal against a mirror tombstone or retention on the same post.

  | Writer | Order |
  | --- | --- |
  | Mirror upsert and tombstone (`club-post-mirror.ts`) | Settings row (the page's fence, which since #4588 also refuses unless `commsSyncStartedAt` is still this pass's claim stamp), then `$executeRaw`SELECT 1 FROM "ClubPost" WHERE "serverPostId" = $1 FOR UPDATE`` (`lockMirroredPost`) and a re-read under it; create or update, or delete, then image rows. A zero count is not found. A row this club removed is never rewritten; a "hidden" tombstone scrubs it to a marker (author and origin name blanked, its reports and image rows deleted under the post lock), and a "removed" one deletes it (#4588). |
  | Admin removal (`removeClubPost`, `club-posts-admin.ts`) | Status-guarded `updateMany` (`removedAt: null`) takes the post row; images and share state re-read under it, then the image rows deleted. A lost claim is a no-op, or not found when the row is gone. Files deleted after commit. |
  | Retention (`runClubPostCleanup`, #4588) | Batches of 200: `$executeRaw`SELECT 1 FROM "ClubPost" WHERE "id" IN (…) ORDER BY "id" FOR UPDATE``, the images re-read under those locks, the posts deleted (image rows by cascade); the files after commit. Its single-flight claim (`cleanupStartedAt`) is released, since #4590, only while it still holds the stamp this pass wrote. |
  | Share send and stamp (`shareOnePost`, `stampShare`, `club-post-sharing.ts`, #4588, #4590) | Before the send, the CLAIM (#4590 review, #4592): `clubPost.updateMany` taking `shareRequestedAt` off our post, guarded on the value read and on no `sharedAt`/`serverPostId`; a count of 0 sends nothing. So the remote send is at most once: a second caller, a failed stamp, a database outage or a process killed mid-send leaves no request to re-send. Only a share the server did NOT take puts the request back (a retryable failure, or a version pause); if that write fails the share is lost, never duplicated. After acceptance, the stamp: settings row (`lockServerNzSettings`), then, only when the mirror already copied our own post under the server's id, our post and that copy (`SELECT 1 … WHERE "id" IN (…, …) ORDER BY "id" FOR UPDATE`), the copy deleted (image rows by cascade, files after commit) and our post stamped while it holds no id or this one. Retried with the id already returned: the locked stamp, then `clubPost.updateMany` of our post alone while its `serverPostId` is null (no settings lock; the unique `serverPostId` refuses it while a mirror copy holds the id), then the locked stamp again. Every exit names the server id: a copy that is not ours, or a different id already held (never overwritten), is a final failure whose `shareError` names it; all three attempts failing records it in `shareError`; a post deleted meanwhile, or that last write failing, leaves it in the error log only. No screen shows `shareError` yet (docs/guides/message-board.md, Troubleshooting). |
  | Member post create (`createClubPost`) | One transaction since #4590: inserts the new post, then claims the member's unclaimed images (`updateMany`, `postId: null`), and rolls back, refusing the post, when fewer are claimed than the body names (an upload the orphan sweep deleted first). Nothing else can hold the new post. |

  Retention and the share stamp take two or more posts in id order. Two other
  writers update many posts in scan order, not id order, and take no image
  row: member merge, which moves `ClubPost.authorMemberId` from the loser to
  the master in one `updateMany` (`member-merge-relations.ts`,
  `member-merge.ts`), and member deletion, whose `onDelete: SetNull` clears
  the same column. Either can meet a retention batch in the opposite order on
  two posts; PostgreSQL detects that deadlock and aborts one transaction, a
  risk the single `deleteMany` retention used before #4588 carried too.
  Making those writers id-ordered is not done here. Post-only writers (hide, edit, the
  share's failure record, the withdrawal stamp, the mirror's own-post takedown)
  take no image row. The image-only writers touch no post row: upload, and the
  orphan sweep, which since #4588 deletes one row at a time and only while
  `postId` is still null, deleting a file only for a row it deleted, so a
  claim committing first keeps its image and a single-row delete cannot
  deadlock against the claim's multi-row update. No advisory key; disjoint
  from the booking/capacity/credit and money clusters.
  `club-post-mirror-concurrency.realdb.test.ts` holds a tombstone and an admin
  removal of one post after their first lock in both orders (neither
  deadlocks; the images-first order deadlocks in both), and since #4588 a
  pass taken over mid-pass, a claim queued ahead of the orphan sweep on one
  upload, and a mirror update adding a picture to a post retention is
  expiring.

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
for the loser. It next pre-derives every member who participates in the merge's
prospective parent or surviving-partner topology and acquires that complete,
sorted set of `member-partner-link:<memberId>` keys. All are acquired at the top
of the single merge transaction, before any read that decides a write, and each
lock family is acquired in **sorted id order**
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
  → pre-derive every prospective parent/partner participant
  → member-partner-link:<each participant>, sorted               member links
        (#2595 — the sweep READS confirmed links to decide which
        shared doubles it deletes; #3271 — the merge re-reads the
        complete participant/topology set under these locks; same
        relative position as the reviewed move's own
        lifecycle→partner-link pair)
  → MemberParentPartnerExclusion:<each prospective pair>, C order pair rows
        (#3271 — no-op UPSERT locks existing and absent canonical pairs;
        complete this layer before the authoritative topology re-read)
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
the confirm-pending-guests / charge-saved-method (#3267) / waitlist-confirm /
switch-to-internet-banking routes, the booking modify/cancel/settlement
services, and
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

**#4442: an additional ask's queue excludes a capture of the balance it carries.**
A replacement ask carries the unpaid balance of the live ask it supersedes
(`INV-PAY-098`), sized before its Stripe mint; its row and its supersede's
cancel rows are written after. Every writer of that row - the inline mint
(`withAdditionalAskQueueTransaction`: the edit doors, a review charge and the
currency re-issue), the re-issue's completion (`writeReissuedAskUnderRecovery`)
and the recovery runner's claim hold (`holdAdditionalIntentRecoveryClaim`) - first
takes `lockAdditionalAskQueue`: the existing global key, then the `Payment`
row, before any recovery-row claim (`INV-LOCK-002`; registered once,
`lockAdditionalAskQueue#1`, `INV-LOCK-003`). Each runs on
`ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS` (`maxWait` 10s, `timeout` 30s, the
`additional-payment-withdraw.ts` budget), because its intent already exists at
Stripe. Under the locks it re-reads the live balance through
`outstandingAdditionalAskCents`, the rule every ask constructor recorded it with
(`AdditionalAsk.paymentBalanceCents`, from the `Payment` the caller read), and
refuses any change with `CarriedAskChangedError`, rolling back the whole queue:
the minted secret was never offered, and the recovery row re-plans from the
`Payment` as it then stands. The pay page's currency re-issue answers that
refusal 409 `ADDITIONAL_PAYMENT_CHANGED` (reload). The capture's settle
(`markPaymentIntentTransactionSucceeded`) writes under the same `Payment` row,
so a capture committed first is read and refused. A capture landing later is
owned by the cancel row the queue committed: the webhook's or the runner's
superseded-capture hand-off refunds it, and the late-success release reads that
cancel row (`lateCaptureRefundState`) and leaves the invoice unsent, even where
the webhook's unlocked cancel-row check ran before the queue committed. Folded
waiting re-issues are not that live balance and stay owed. A frozen replay (no
figure it can re-derive) is fenced the same way on the balance its own read
saw. If an additional capture is already on the ledger, a frozen replay refuses
before minting on every attempt: its amount cannot distinguish the paid balance
from this change's own debt. The existing retry exhaustion alerts an officer to
reconcile the payments and collect only what remains owed. This includes fully
or partly refunded captures, whose effect on the frozen debt is also unknown.

The runner's re-stamp after the Stripe cancels writes nothing and fences only a
reduction, which orders on the `Payment` row, so it takes that row alone, not
the global key. A retry whose attempt wrote its row and then failed (that
re-stamp timing out, say) finds its OWN row - the intent the recovery recorded -
and resumes the post-write steps (the waiting invoice's attach, the deferred
invoice, completion) instead of reading the row as a later edit's overtake.
Stripe mint and cancel calls stay outside these transactions; no new key
(`INV-LOCK-001` through `INV-LOCK-003`). Proved against a real server in
`superseded-ask-invoice-carry.realdb.test.ts` (including a capture committing
while the queue waits on the global key, and a frozen replay) and
`additional-ask-reduction.realdb.test.ts` (the re-issue's door and runner).

**#3653 adds the organiser child's refund out of the combined card payment
(`INV-PAY-114`).** Three writers join this cohort and mint no keyspace. The edit
doors write a child's refund debt (`reserveOrganiserChildModificationRefund`)
inside the transaction that already holds `lock(1)` and the per-lodge key; a
joiner's own cancel writes its one debt (`reserveOrganiserChildRefund`) in the
paid-cancel claim, after that claim's `lock(1)`, per-lodge key, the joiner's
member credit-ledger key (#3792) and `Payment` row lock - global, lodge, member,
row, the claim's existing order, adding no key of its own; and the organiser cancel
freezes one debt per child plus the settlement's plan in a `lock(1)` transaction
of its own (`planOrganiserCancelChildRefunds`). The payments cron's
`reconcilePendingOrganiserChildRefunds` reads a pending refund back from Stripe
with no transaction open, then takes `lock(1)` and the `Payment` row, in that
order, to take a failed refund back out and reopen its debt with a
status-guarded update. Both read
the combined headroom - refunds recorded on the intent plus debts still owed -
and insert in the same transaction, so two reductions cannot both spend the same
captured cents (proven by `organiser-child-refund.realdb.test.ts`). The recorder
(`processOrganiserChildRefundOperation`) runs the Stripe call with no
transaction open, then takes `lock(1)` and the child's `Payment` row
(`lockPaymentForRefundedTotal`) - global, then row - and commits the refund row,
mirror, Xero note, settlement status and the debt's close together, so a
concurrent headroom read sees the debt either owed or recorded. The status-
guarded recovery claim is the guarded claim before the provider effect.

**#3956 adds a fourth writer of a child refund debt, and no key: a refund
appeal's approval (`INV-PAY-123`).** `PUT /api/admin/refund-requests/[id]#1`
already holds `lock(1)`, then (#4124) the child's Payment row. Under them the approval first re-reads the
request's status, so one another review settled while it waited answers
"already reviewed" rather than a cap refusal. On a booking the organiser paid
for by card it then reads the same headroom (`organiserCardAppealCap`), refuses
past it before the claim, claims the request with its status-guarded
`updateMany`, and reserves the debt (`reserveOrganiserChildAppealRefund`) in
that transaction - so a reduction, a cancel or a second approval queues behind
it and reads the debt as owed (proven by
`organiser-child-refund.realdb.test.ts`). The cap is zero while the group
cancel's own combined refund is unmade - a pre-#3653 plan on a settlement still
`SUCCEEDED`, or its `group_settlement_refund_recovery_` retry not yet
`SUCCEEDED` - because `executeGroupSettlementRefundPlan` records that refund
without reading this headroom. Stripe is called after the commit through the
recorder above, never by the route; the debt, not an inline refund, is the
durable record, so the approval's release path (`#2`) is never reached on this
branch.

The appeal's debt is keyed `organiser_card_appeal_refund_<request>`, outside
the `organiser_child_refund_` prefix a pre-#3956 worker routes to the executor.
During a blue/green window such a worker takes the row for an ordinary
modification refund, meets the allocation that names no real transaction, and
fails it before any Stripe call; the retry, with backoff, lands on a current
worker. Every current reader counts both prefixes (`isOrganiserChildRefundKey`,
`ORGANISER_CHILD_REFUND_KEY_WHERE`). A pre-#3956 headroom reader does not count
an appeal debt; each child's own room still bounds its refunds, and the
approval runs its debt inline on the new code.
On a rollback to that code an appeal debt also counts as an ordinary
modification refund: the old `listDeadCardRefunds` and its "paid another way"
close can act on it once it has used its attempts, and the old headroom readers
ignore it, with each cancelled child's own room still bounding it. That is
accepted for a short window; a rollback drains or closes these debts first.

**#3854 adds booking-ledger lines to this cohort and no lock.** The settle
posts each child's confirmation and share after its `lock(1)` and the sorted
child-lodge keys, beside the PAID flips; the organiser cancel's per-child claim
posts its plan refund and kept figure after its `lock(1)`; the plan's recovery
replay posts beside the mirror's conditional update; and the #3653 recorder and
pending-refund sweep converge the child's refund lines after `lock(1)` and the
`Payment` row. Each is an insert after the locks the transaction already holds
(global, lodge, row), keyed so a replay inserts nothing; no key, order,
participant or provider call changes.

**#3954 adds the retirement of an unpaid ask to every reduction door, and no
key** (`INV-PAY-120`). `applyPaymentAdjustments` already runs after the door's
`lock(1)`, its lodge key and, on a credit give-back, the member's credit-ledger
key; the retire (`retireUnpaidAskChain`) runs after the give-back, so the
member key still precedes every `Payment` row write. It writes the ask's
ADDITIONAL rows, queues their cancellations and retires a parked Xero operation
in the same transaction, then reconciles the mirror; the Stripe cancel runs
after commit. The counterpart writer is the webhook capture
(`markPaymentIntentTransactionSucceeded`), which takes no advisory key; so the
retire is a status-guarded `updateMany` re-asserting "still unpaid": a capture
committed after the read matches nothing and the edit rolls back (409); one
landing after the retire waits, and the committed cancellation hands it to
`REFUND_SUPERSEDED_PAYMENT`. Since #4217 the capture is no longer autocommit:
it takes the `Payment` row and then the ask's row in one short transaction. So
the retire takes the `Payment` row too (`lockPaymentForRefundedTotal`), first:
before it closes waiting recoveries and before it stamps the first row.
Stamping first and reaching the `Payment` row only at the reconcile would
deadlock that capture (40P01; proved, and closed, by the #4217 race in
`additional-ask-reduction.realdb.test.ts`). No key or provider call changes.
Its second counterpart (owner decision 9 Oct 2026) is the lockless recovery
runner replaying a failed mint (`CREATE_ADDITIONAL_PAYMENT_INTENT`): a waiting
recovery the reduction nets off is closed by a status-guarded `updateMany` on
the exact status and attempts it read, and the runner's claim is itself a
status-guarded `updateMany` that moves both. A claim first fails the close and
the edit rolls back (409); a close first leaves the claim matching nothing,
whether it was already waiting on the row or comes later. Review round 4: the
door reads the ask ONCE and hands that read to the options and the save, so a
capture between them meets only the fence. A recovery claimed within two
minutes rolls the edit back (409, "try again in a moment"); an older claim is
closed under its attempts and claim time, and the runner writes its row, its
intent id and its supersede's durable rows only while it still holds that
claim (`holdAdditionalIntentRecoveryClaim`, one transaction that re-stamps
`processingStartedAt`), so whichever commits first wins. A re-issued ask's
recovery is written in the edit's transaction; the door's own mint completes it
fenced the same way (`writeReissuedAskUnderRecovery`). An increase folding a
waiting re-issue in closes it with the same fence. #4052: when the door's write
loses that fence and the recovery ended SUCCEEDED without the door's intent (a
net-off, a fold, or the runner writing another intent under an amount-suffixed
key), and no row or recovery names it, the door cancels that intent at Stripe
after commit, under no lock; a runner's live claim, or one that wrote the same
intent, leaves it alone. No lock or key changes. All proven on real Postgres.
Round 6: the retire closes waiting recoveries before it stamps the rows - the
runner's own order (its claim hold writes the recovery, then its row; since
#4217 both take the `Payment` row before either) - and a
deadlock or write conflict there is the same 409; the runner re-checks its
claim after its Stripe cancels, before queueing any invoice on its intent. The
billed-offset invoice-correction note is enqueued inside the edit's
transaction, after its locks, under the enqueue's own-key dedupe and no
advisory key; it is raised after the edit's own note, waiting while that note
is queued or running and - round 7 - while the edit expects one its Xero leg
has not queued yet (recorded on the note's payload), for up to six hours, after
which the repair pass hands it to a person. Round 8: while it waits for a note
not yet queued it is requeued under `BILLED_OFFSET_AWAITING_OWN_NOTE`, and the
outbox scan leaves it out for five minutes at a time rather than give it an
oldest-first slot on every kick; "the edit's own note" is one predicate
(`isOwnModificationNoteOperation`) for the wait and the repair pass, either
kind, a FAILED one counting as present. Round 7 also: the door's mint
re-reads its new intent's row after its Stripe cancels and queues no invoice,
and offers no client secret, when a reduction withdrew it meanwhile (a retire
landing after that read leaves an invoice parked on a cancelled intent, which
the stale-wait reaper retires). Round 8: only a retired row is "retired"
there - a paid one, one not found or a failed re-read is live; #4052: retired
is withdrawn, or FAILED with a queued Stripe cancellation, the supersede stamp,
or Stripe reporting the intent cancelled or gone, so a declined card is live -
and
the door still returns the intent's id, so the increase's Xero leg parks its
invoice on it rather than raising it unpaid; the reduction names the
increase from the edit its mint stamped on the row
(`PaymentTransaction.bookingModificationId`), so the repair pass never bills
it again. An increase's recovery that folded re-issues in
is settled only by its own row, so a later ask cannot overtake that money; and
both minters of a re-issue resolve its Stripe customer one way
(`resolveAskCustomerId`). A deadlock mapped to the 409 is logged and kept as its
cause. Deploy window: the previous release's recovery runner, still draining,
can replay a re-issue's recovery this release wrote; it mints under the same key
with its own request and no metadata stamp. If it writes its row, that intent is
the ask and this release's mint of the key writes nothing. If it dies between
mint and row, this release's replay meets an `idempotency_error` the metadata
lookup cannot answer, retries, and fails for an officer, as any exhausted
recovery does. (Round 8: the lookup scans the resolved customer's intents,
then the account's, so a different customer does not hide it; an intent with
no metadata stamp still cannot be found.) The draining release's outbox can
also take a billed-offset note this release queued: it raises it with no wait,
possibly before the edit's own note - which is still raised beside it, the
scoped link refusing it nothing (round 6) - and its inbound credit-note sync,
which does not know the scope, can fold that note into
`Payment.refundedAmountCents` as cash. The booking-vs-Xero repair pass does not
touch that total: it finds the scoped note present and queues nothing. This
release's next inbound sync of a credit note on the payment recomputes the
total without it - lowering it for a bank payment; for a card payment the
raise-only floor (#1353) keeps the higher figure and sends the
refund-ledger-divergence alert, so a treasurer corrects it by hand. A stated
limit of the window, not of the release. An ORDINARY increase's door and
replay share one request (`INV-MOD-060`, #4036), so in the window an old
door's row replays byte for byte under this runner, a new door's row the old
runner replays is refused and backs off until this runner replays it, and an
intent the old runner minted under its own reason was adopted only as the one
unrecorded match no other in-flight recovery of the booking could own. #4079
removed that case once no pre-#4036 recovery row remained. Intents under the
runner's reason are still minted, by a row whose key names no door and by a
currency re-issue of a row the runner recorded; in #4079's deploy window the
#4077 release's runner treats those exactly as it always did, and the #4079
runner never adopts one.

**#4316 adds the edit minter's retirement of an ask on a booking that has
ended, and no key** (`INV-ADDPAY-044`). The ordinary doors decide the ask under
their `lock(1)`, but `createModificationAdditionalPaymentIntent` runs after
their commit holding nothing, and the paid cancel's claim (global, lodge,
member, then the `Payment` row) retires only the intent the mirror it reads
under that row names. The ROW LOCK orders the two writers. The minter's row
write (`upsertPaymentIntentTransaction`) takes the `Payment` row before it
writes, as the claim does before it reads the mirror: a claim that held the row
first committed before the row was written, so the minter's plain re-read of the
booking after the write sees CANCELLED; a claim that took it after reads the new
intent on the mirror and retires it itself. So the re-read needs no lock of its
own, and neither writer can miss the other. On CANCELLED or BUMPED the minter
retires through the claim's own routine (`failOutstandingAdditionalAskInClaim`,
moved to `booking-payment-cleanup.ts` and shared) in a short transaction that
takes the `Payment` row first, then writes the mirror, the intent's row
(`markPaymentIntentTransactionFailed`) and the recovery row - the claim's own
order after its advisory keys, with none before it. It takes no `lock(1)`: the
status it acts on is terminal, so `lock(1)` would exclude nothing it needs
excluded, and the capture it might race takes only the `Payment` row. The Stripe
cancel runs after that commit (`runPaymentRecoveryOperationNow`), and the
recovery's key is the claim's (transaction and intent), so the two writers queue
one row. A minter that finds the ask already FAILED leaves it to the cancel's
Phase 2. The check before the provider call is a plain read too: a booking
cancelled first is asked nothing.

**The never-captured cancel branch is a counterpart too** (review round 2). A
fully REFUNDED payment reads captured to the minter but cancels down that
branch, which used to read its payment with no row lock and queue no
cancellation, so the two could both miss. Its claim now takes the `Payment` row
FOURTH - `lock(1)`, the per-lodge key, the member credit-ledger key, then the
row, the paid claim's own order (`INV-LOCK-002`). Under the row it re-asks the
paid-path question (`paymentEligibleForPaidCancelPath`, review round 3): an
ask's capture webhook takes only that row, so a REFUNDED payment read before it
may hold captured cash again, and the claim then refuses with the 409 and the
retry takes the paid path. Only a won status-guarded claim then retires the ask
(`failOutstandingAdditionalAskUnderRowLock`, the same routine) and flips the
payment FAILED - a lost claim writes nothing - and the ask is cancelled at
Stripe after commit.
Nothing it calls after the row takes a key the paid claim takes before it (the
hosting reconcile comes after the row in both), so no new order exists.

**A retirement is durable before it runs.** After its booking re-read finds the
booking ended, the minter queues the intent's `CANCEL_PAYMENT_INTENT` row on its
own, autocommit and under no lock, before the retirement transaction; the
transaction's write of the same key lands on that row. A transaction that fails
(a deadlock, a timeout) therefore still leaves the cron to cancel the intent and
mark its row FAILED. The recovery runner's replay of a failed mint
(`processCreateAdditionalPaymentIntentOperation`) runs the same two guards: its
row write is inside its claim hold (`holdAdditionalIntentRecoveryClaim`), which
takes the `Payment` row before either write since #4217, so the same ordering
holds. It re-reads after that transaction commits, retires through the same
routine and closes its recovery row; a failed retirement THROWS, so the row
backs off and retries, and its check before the mint - ahead of the settled
check, which would read that ask's own row as settling the debt - retires the
ask the failed attempt left outstanding. A currency re-issue
(`reissueAdditionalIntentInClubCurrency`) writes its row through the same
`upsertPaymentIntentTransaction` and runs the same two guards. Proven - cancel
before the mint, between the provider call and the row write, queued on the
`Payment` row in both orders (the never-captured branch's included), and the
runner's replay - by `ended-booking-ask-mint-race.realdb.test.ts`.

**#4042 adds the organiser's hand-back to the same claim, and no key.** An
Internet Banking settlement's per-child claim, after its `lock(1)` and the
joiner's mirror, books that joiner's share on the one `ManualRefundTask` keyed
`group-organiser-hand-back:<settlement id>` (`recordGroupOrganiserHandBackShare`,
`INV-PAY-124`): the first share creates it, each later one sets it, by a
status-guarded `updateMany` while OPEN, to the total derived under the lock
(the joiners whose refund lines are on the ledger, those a group task records,
and its own, less closed group tasks), and one booked after it closed creates
a supplementary task keyed per joiner. That per-child claim is the ONLY raise
site - it runs on the first cancel and on the reaper's resume, both through
`settleGroupBookingOnOrganiserCancel` - and the plan's recovery replay never
raises it (an Internet Banking plan is never replayed). Each step is a
find-then-write made single by the claim's `lock(1)`, with the unique key as
the backstop; it reads ledger lines and children under that lock and makes no
provider call. **Its alert adds one `lock(1)` participant,
`updateGroupHandBackAlertRecord`** (registered as
`updateGroupHandBackAlertRecord#1`, `INV-LOCK-003`). Once the children loop
ends - and from the reaper's own task-keyed sweep of OPEN group tasks older
than the resume grace (by `updatedAt`, which every growth moves) with no alert
sent, skipping a group that still has an active organiser-settled joiner - a
run CLAIMS each unsent alert: a short transaction takes `lock(1)` first, reads
the database's time, re-reads the task and writes a 30-minute lease
(`alertClaimedAt`), but only on an OPEN, unsent task with no unexpired lease.
Only the winning run sends, after that commit, so two runs never send at once;
it then records the send (`alertSentAt`, lease cleared, retried three times)
through the same writer, or, when the send reached nobody, gives the lease back
and counts it (three and no run tries again). The guarantee is AT LEAST ONCE:
a crash, or a record that never lands, between the send and the record lets
the lease expire and the alert repeat. Every write to `reviewContext` - the
lease, its release, the record and a claim's growth of the task - takes
`lock(1)` and re-reads first, so none drops another's fields; the growth's
`updateMany` is fenced on status only, since a fence miss there would raise a
supplementary task. It takes the key ALONE, holds it for a read and an
update, and makes no provider call inside. Its
COMPLETION joins the cohort too: `resolveManualRefundTask` takes `lock(1)`
first for this task (as for an edit review and a non-cancellation hand-back,
`resolveManualRefundTask#1`), so a growth and a completion never interleave,
and a completion must name the total its screen showed; a grown one is
refused. No new key
or order.

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

**#3639 adds its sibling on the webhook side.** `holdLateCaptureForTreasurerIfRequired`
(`src/lib/late-capture-refund-hold.ts`) raises the treasurer-approval
`ManualRefundTask` for a late capture when the club has chosen approval over an
automatic refund (owner decision 26 Sep 2026) — from either late-capture handler
or the superseded-intent hand-off (webhook hook or recovery cron). Same shape, same
reason: a find-then-create keyed on the payment intent, which must also see the
#2700 raise's OPEN task for that intent (and marks it rather than raising a second).
It takes `lock(1)` and nothing else, makes no provider call inside, and the #2700
raise also matches this task's `lateCaptureApprovalIntentId`, so whichever writer is
second finds the first's row. From the cron it runs after the operation's claim and
outside any other transaction, so it composes with nothing.

The middle read is a **refund fence**, and it is why the read must be inside
this lock rather than beside it. The transaction row for this intent is re-read
under the key and the raise is skipped when Stripe has already refunded the
capture — `refundedAmountCents >= amountCents`, which is the field that survives
`markPaymentIntentTransactionSucceeded` writing `SUCCEEDED` back over a
`REFUNDED` status. Read outside the lock it would be stale exactly in the
interleaving it exists to catch: a webhook refund committing between the check
and the create.

**#4097 adds creates inside the paid cancel's own claim, and no key.** When an
own-card cancel's frozen card refund plan carries less than the refund due,
`raiseCancelCardShortfallHandBack` reads the payment's captured non-card
charges and inserts up to two hand-backs for the rest in the claim
transaction, after the plan's recovery row, under the locks the claim already
holds (`lock(1)`, the lodge key, the member's credit-ledger key, the `Payment`
row), in that order. Each is an insert on no conflict under a unique
`occurrenceKey`, not a find-then-create, and the claim's status flip is already
single-flight. Completing one takes no advisory key, as a cancellation
hand-back's never has; before its claim it takes the `Payment` row
(`lockPaymentForRefundedTotal`) and reads the cancel's card refund recovery
row, refusing while that row is not SUCCEEDED, so a completion and the card
refund's recording are serialised by the row every refunded-total writer takes
first. Its Xero refund note is an outbox row queued inside the completion
transaction, with no provider call (`INV-PAY-129`).

**#4154 adds one more create, inside the capacity void's claim, and no key.**
Where the race's frozen card refund plan is short of the charge, the settle
inserts the part to check of the same task (`raiseCapacityRaceRefundShortfallTask`)
after freezing the plan, under the locks it already holds (`lock(1)`, the
lodge key, the member's credit-ledger key where it takes one), on no
conflict under its unique
`occurrenceKey`. A key already held is logged, never thrown, so the webhook's
settle never rolls back on it. Its completion is the one above, reading the
race's own recovery rows (one per intent, on the booking) beside the cancel's,
and it reads the race intent's captured charge under the same `Payment` row
lock its allocation then writes, on that charge alone (`INV-PAY-135`).

**#4154's guarded correction is a new writer of a charge's refunded total, and
takes no new key.** Where the race's charge holds too little for the task, the
completion lowers that one charge's `refundedAmountCents` to its recorded refund
rows before allocating, inside the same transaction and under the `Payment` row
lock (`lockPaymentForRefundedTotal`) - the lock every writer of that column
takes before touching it (`INV-PAY-103`), and which the writer
(`capacityRaceChargeForHandBack`) takes itself as well as its caller. It runs
after the card refund gate, which refuses only while the race's own card refund
recovery row, or a card refund on the payment that Stripe failed later, is not
SUCCEEDED. No other refund reaches the race's charge meanwhile: the booking is
cancelled, so no member cancel or edit refunds it; the correction refuses while
the booking or payment has any other refund task, which shuts out every
hand-back and "Paid another way" close; and a refund made in the Stripe
dashboard is checked before the transaction against Stripe's own
`amount_refunded` (read outside it, bounded, no retries), while its later
`charge.refunded` recording (`recordStripeRefundsAgainstTransaction`) queues on
the same row lock. Two completions of one task serialise on that lock too, and
the second loses the task's status claim. It writes through the shared compare-and-set
(`compareAndSetRefundedAmount`) taking the smaller of the row's total and the
rows' sum, so a writer that slipped past cannot be undone into a raise. The
payment's aggregate is re-derived in the same transaction
(`reconcilePaymentAggregates`). No `lock(1)`: a cancellation's hand-back
completion never takes it, and the correction moves no booking status or
capacity. A refusal anywhere later in the completion rolls the correction back
with it. **One window remains, and is stated rather than closed:** a refund made
in Stripe after the completion's Stripe read but recorded only after its commit
can still pay the member twice, since the read is outside the transaction and
no lock reaches Stripe. Its recording then meets the charge's cap, and
`recordStripeRefundsAgainstTransaction` alerts the officers after its own commit
(`alertCardRefundCapOverflow`, once per charge and set of counted refunds),
never inside the transaction.

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
handler that sits on a lock for 30s trades a lost row for a lost delivery. A
failure here writes a `critical` `booking.payment.auto_refund_record_failed`
audit row, and since #4149 the webhook then answers 500 (after its refund entry
and alert): a replay no longer refunds again (#3639), so Stripe's redelivery
writes the row (`late-capture-record-recovery.ts`). See `INV-ADDPAY-037`.

**TWO CALLERS SINCE #2773, AND THAT CHANGES THE COHORT'S FOOTPRINT RATHER THAN ITS
SHAPE.** `handleCancelledBookingPaymentSucceeded` — the late-capture handler for a
booking's OWN payment — now goes through the same writer as its booking-change
sibling, via the shared epilogue in
`src/lib/cancelled-booking-late-capture.ts::recordAutomaticLateCaptureRefund`. Same
key, same budget, same single-key acquisition, no new tier and no new ordering: the
only difference is that one more Stripe event type can now be the thing waiting on
`lock(1)`. Both callers make every provider call outside the transaction, and both
re-read `Booking.deletedAt` outside it.

**#4149 ADDS CALLERS OF THE SAME WRITER, NOT A NEW PARTICIPANT.** A webhook
redelivery that finds a late capture refunded with no closed record row (an
`OPEN` #2700 task the refund never closed counts as none), and the nightly
credit-reconciliation self-heal before it raises a card note, both call this
writer through `recoverLostLateCaptureRecord`: same key, same budget, no new tier
or ordering. Each asks Stripe which door sent the refund BEFORE the transaction,
never inside it. The writer's row is the claim that makes the recovery
exactly-once: two deliveries, a delivery racing the self-heal, or a retried lost
write serialise on `lock(1)`, the later finds the row (`alreadyRecorded`), and
only the recovery that closed or created it writes its
`booking.payment.auto_refund_record_recovered` entry and re-sends the alert
(and, when the refunding delivery died before its entry, writes that too). A
hand-`COMPLETED` #2700 row beside a door refund is escalated instead, through the
writer's own #2774 escalation: its `critical` entry for every detection, its email
claimed once ever per capture (`sendAdminAlertOnceEver`, no lock: the claim is the
guard, and a send that throws gives it back). Proved on real
PostgreSQL by `late-capture-record-recovery.realdb.test.ts`.

**AND ONE READ THAT IS DELIBERATELY OUTSIDE EVERY LOCK (#2774,
`INV-ADDPAY-039`).** Before refunding, both handlers call
`findCompletedHandBackForLateCapture` — a single unlocked `findFirst` for a
`COMPLETED` `ManualRefundTask` on this capture, which means an operator has already
paid the member back by hand and refunding again would pay them twice. It takes no
lock, and it CANNOT be made to close its own window: `resolveManualRefundTask` (the
hand-completion) holds no advisory key either (since #3582 only an
`EDIT_FINANCIAL_REVIEW` completion takes one, below), so serialising them would require the
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

**#3032 SETTLES MONEY ON THAT SAME LOCKLESS PATH, AND DELIBERATELY ADDS NO KEY TO
IT.** Completing an `EDIT_FINANCIAL_REVIEW` task now issues a Stripe refund, a
local allocation or account credit for the amount an admin confirms. The obvious
instinct is to serialise that against a concurrent edit or capture with `lock(1)`
— and it is the same instinct this section already refuses, for the same reason:
the Stripe refund is a provider round trip, and holding the global key across one
is exactly what the bounded-exception rule forbids. The guarantee is a **durable
claim, not a lock**. The existing status-guarded `updateMany` on `OPEN` is what
makes the settlement single-flight, so:

- every refusal is raised BEFORE the claim, so a refused completion leaves the
  task `OPEN` with nothing half-applied;
- the ledger writes sit AFTER it inside the same transaction, so a lost claim
  writes nothing — `applyLocalRefundAllocation` INCREMENTS `refundedAmountCents`
  and is not idempotent, so a caller placed beside the claim rather than
  downstream of it would silently double-consume the refundable headroom until
  the captured-cash cap tripped;
- the Stripe call happens after the COMMIT, and the refund DEBT is persisted
  BEFORE it, inside the claim transaction — the frozen per-transaction allocation
  plus the key prefix, exactly as `booking-cancel.ts` does it (#1349). Lock-free
  is not the same as recovery-free: without that row a crash between the commit
  and the provider call would leave a `COMPLETED` task, an untouched
  `refundedAmountCents` and no trace that money was owed, because this route
  writes no allocation of its own. The cron replays the frozen slices under the
  stored prefix, Stripe answers the repeat with the original refund, and the
  ledger dedupes on refund id.

**#3191 WRITES A SECOND KIND OF ROW ON THAT SAME LOCKLESS PATH, AND ALSO ADDS NO
KEY.** Settling a review may now also record what the booking's unpriced nights
sold for, which writes `BookingGuestNight.priceCents` for that guest strand and
re-bases `BookingGuest.priceCents` to the sum. The same reasoning applies twice
over: this rides inside the completion's transaction, whose single-flight
guarantee is the status claim above, and adding `lock(1)` here would put the
global key over the Stripe round trip that follows the commit.

What makes it safe against a CONCURRENT BOOKING EDIT - which rewrites those very
rows, in its own transaction, under its own locks - is a **compare-and-set on
every row it touches**, not a lock:

- each night is written with `updateMany` fenced on `priceCents: null`, so a
  night that has since acquired a price cannot be overwritten. `update` on the
  unique key would have found the row and written over whatever it then held;
- the strand's total is written with `updateMany` fenced on the value the plan
  was read against;
- a `count` of anything but 1 raises a 409 and rolls the whole completion back,
  so the task is still `OPEN` and its money question survives - the same answer
  `RefundAllocationRacedError` gives one row over.

The validation runs BEFORE the claim and the writes AFTER it, for the reasons
listed above; and the blanks are re-read on the caller's transaction rather than
trusted from the browser, so a screen minutes old cannot price a night the
booking no longer holds. `INV-MOD-036` carries the rest of the rule (legacy:
it settles tasks raised before #4317, which made every edit price itself).

**#3214 ADDS A SECOND CALLER OF THAT SAME WRITER, ON THE SAME BASIS, AND STILL NO
KEY.** An officer may now record what a guest strand's nights sold for from the
booking's own page, outside any review, when the strand's stored rows cannot be
read back. It writes the same two tables through the same function, and it takes
no advisory tier for a reason the section above cannot claim: **its total write
is provably a no-op**. The officer is asked for every night the strand holds and
the shared checker forces those to sum to `BookingGuest.priceCents` as stored, so
the writer re-bases that column to the number already in it. It moves no
settlement money, makes no provider call, composes no lifecycle transition and
joins no capacity claim.

Three things differ from the settle path and each matters:

- **it has no status claim, so the compare-and-set is the WHOLE of its
  single-flight guarantee.** The settle path has a task to claim; this has
  nothing. Two officers recording at once: the first commits, the second's fenced
  `updateMany` matches zero rows and raises the 409;
- **the night fence is the value the row was READ holding, not a literal
  `priceCents: null`.** It has to be, because this act may rewrite a night that
  already carries a figure — bounded to strands that do not reconcile, with the
  total fenced. The settle path still passes `null` and reaches the database with
  a byte-identical `where`;
- **it can CREATE a row**, for a night the strand holds through its stay envelope
  with no row behind it. The `(bookingGuestId, stayDate)` unique constraint is
  the fence on that arm, and its `P2002` becomes the same race refusal rather
  than a 500. The created dates are exactly `getGuestBedNightKeys`, so no
  capacity count moves (`INV-CAP-032`).

**"PROVABLY A NO-OP" IS A CLAIM ABOUT THE MEMBER'S TOTAL, AND NOT ABOUT
EVERYTHING.** That is the claim the "no key" decision above rests on, and it
holds: `BookingGuest.priceCents` is written back as the number already in it, no
settlement is created, no credit is written and no provider is called. Two
readers elsewhere read the night ROWS rather than that total, and both see a
different answer afterwards. Neither takes a lock, because neither is a writer —
they are readers that will now see truer rows — but both were analysed, and the
same care the capacity bullet above got is owed to them:

- **`countMemberStayNights`** (`src/lib/member-stay-nights.ts`) counts
  `BookingGuestNight` rows, and feeds the membership-nomination gate's
  `minimumNights`. A member strand with no rows contributes zero nights today and
  contributes the whole stay once the create arm has run, so a member can become
  able to nominate from this act. The higher figure is the truer one for the same
  reason the bullet above gives (`INV-CAP-032`), so this is a correction rather
  than a defect — but it is invisible from the officer's screen, which is why it
  is written down here rather than left to be discovered;
- **`loadBookingHutFees`** (`src/lib/finance-revenue-reconciliation.ts`) sums
  night prices inside a DATE WINDOW. Filling or creating rows adds revenue into a
  window, which closes the positive Xero variance that report exists to raise. But
  re-apportioning a `STORED_TOTAL_MISMATCH` strand moves income ACROSS a month
  end while the booking's total is unchanged, so a period figure already reported
  can stop reproducing. It is recoverable — the audit entry carries
  `previousNightPrices` — and the officer is warned about the month end on
  screen. The one home for the full statement is
  `stored-night-price-strand-reconcile.ts`'s module docblock.

Against a concurrent booking edit — which holds `pg_advisory_xact_lock(1)` and
`acquireLodgeCapacityLock`, and deletes and recreates these very rows in
`applyGuestChanges` — the fences turn a race into a 409 and a rollback, never a
lost update. The reverse order is the intended outcome: the reconcile commits,
and the edit then reads exact evidence and prices normally. It also refuses
outright while an `EDIT_FINANCIAL_REVIEW` is open on the booking, so the two
callers cannot be writing the same strand against two different targets.

**#3219 ADDS THE BOOKING ITSELF TO THAT SAME LOCKLESS TRANSACTION, PLUS ONE ROW
LOCK, AND STILL NO ADVISORY TIER.** Once the strand write above has landed, the
booking's four money columns - `totalPriceCents`, `discountCents`,
`promoAdjustmentCents` and `finalPriceCents` - are re-priced from its strands, so
the booking can no longer disagree with its own nights. Same reasoning a third
time for the advisory tier: it rides inside the completion's transaction, whose
single-flight guarantee is the status claim, and a key here would sit over the
Stripe round trip that follows the commit. Safety against a concurrent booking
edit - which writes those very columns, in its own transaction, under its own
locks - is again a compare-and-set rather than a lock:

- the `updateMany` is fenced on ALL FOUR stored figures as they were read inside
  this transaction, so an edit that moved any of them underneath us matches
  nothing;
- a `count` of anything but 1 raises the same 409 and rolls the whole completion
  back, so the task is still `OPEN` and its money question survives;
- and the strand this settle just repaired must be one of the booking's own,
  carrying the value just written to it. Nothing cross-checks the guest id an
  `EDIT_FINANCIAL_REVIEW` context holds against its task's `bookingId`, so
  without that check a mismatched context would re-price one booking from another
  booking's strands - and an empty guest list would zero it.

**THE ONE NEW LOCK PARTICIPANT IS THE PROMO ROW, AND IT IS A TIER THIS
TRANSACTION DID NOT HOLD BEFORE.** The promotion follows the strands, so the
re-price re-enters `recalculateBookingPromo` - the tree's one recompute - which
`lockAndRefreshPromoCodeUsage` row-locks the promo code and re-reads its usage
counter, because a re-price can RELEASE a total-redemptions slot. Three things
make that safe to add here:

- **it is the only ADVISORY tier this transaction takes**, so it can close no
  cycle against a lodge, member or global key. The guide's order for the promo
  row is lodge -> promo row, and the settle path holds no lodge key; a
  concurrent booking edit that holds both acquires them in that order and this
  one waits behind it or is refused by the fences above. The transaction does
  hold ORDINARY ROW LOCKS besides - on the strand's guest and night rows, taken
  by the repair write BEFORE the promo row, where `waitlist.ts`'s confirm takes
  the promo row first. Two transactions on the same booking could therefore
  deadlock on that pair; Postgres aborts one, which rolls the whole completion
  back and leaves the task `OPEN` - the same outcome as the compare-and-set
  fences above, and the shape needs a waitlist confirm and a review settle on
  one booking at the same instant to arise at all;
- **it is the SAME key the recompute's two other callers take** (the guest
  removal and the waitlist confirm), rather than a new key registered for one
  writer;
- **it is a row lock, not `pg_advisory_xact_lock(1)`**, and it is released at
  commit, which happens before the Stripe round trip - so the bounded-exception
  rule about provider calls inside long transactions is not engaged.

The new figures are RECOMPUTED from the strands rather than derived by applying
the settled amount, which matters here as well as in `INV-MOD-055`: the writer is
handed no settlement amount at all, so a reader does not have to check whether it
is the right one. Where the re-price DECLINES - no promo recompute, no booking
write, no row lock taken at all - the transaction is exactly as narrow as it was
before #3219. Until #4317 it declined for any surviving strand whose nights did
not read back as exact; since #4317 (review H1) it values those strands
(`INV-MOD-028`) and re-bases, taking the same row lock under the same key, and
declines only for a negative stored guest total, which the database forbids.

One more write joins the same transaction: a `BookingModification` row of type
`PRICE_REBASE`, the booking's own history record of the re-price. It is an insert
against the booking, takes no lock, and is only reached after the fenced
`updateMany` has claimed the change - so it cannot exist for a re-price that did
not commit. Since #3257 it is also skipped where the recomputed figures matched
the stored ones, which removes a write rather than adding one.

**#3582 ADDS `lock(1)` TO AN EDIT REVIEW'S COMPLETION — INSIDE THE TRANSACTION,
AS ITS FIRST LOCK, AND NEVER ACROSS THE PROVIDER CALL.** The closure now posts
booking-ledger lines (the re-price's reversal and re-post, anchored on the
`PRICE_REBASE` row, and a share only where the ledger design's §5.3 says it
stands in), and a poster may post only for a booking already confirmed on the ledger
(`bookingHasConfirmationLines`). The settle asks that question under `lock(1)`;
a closure asking it without the key could see "not yet" while a first settle
does too, and both would post. So `resolveManualRefundTask` takes
`pg_advisory_xact_lock(1)` for an `EDIT_FINANCIAL_REVIEW` task only, and:

- **first, and before the task is read**: only the task's `kind` is read
  unlocked (it is immutable for this kind; the one `kind` write,
  `late-capture-refund-hold.ts`, sets NULL to a late-capture kind). The task,
  booking and payment read that chooses the settlement route comes after the
  key (#3740), so the route is never picked from a snapshot a settle has since
  moved. Then the route choice, the claim, the payment-row allocation, the repair's guest and night row locks and
  the re-price's promo-row lock. That is the order every edit door takes the same
  resources in (global, then anything narrower — `INV-LOCK-002`), so it closes no
  cycle against them; the old guest/night-row-versus-promo-row shape against a
  waitlist confirm that holds `lock(1)` is now serialised by the key instead;
- **inside the transaction only**: the Stripe refund and the Xero leg run after
  the commit (`executeEditReviewSettlement`), so the bounded-exception rule about
  provider round trips is not engaged; the key is released at commit;
- **not a replacement for the claim**: two completions of one task queue on the
  key, and the second reads the task closed and is refused (409) before its
  claim (`edit-financial-review-races.realdb.test.ts`). The status-guarded
  `updateMany` still fences on `OPEN` for every kind, pinned with the lock
  mocked in `manual-refund-task.test.ts`. Legacy hand-back kinds take no key,
  exactly as before — **except an edit refund hand-back** (#3827,
  `INV-PAY-117`), an approved refund appeal's (`INV-PAY-118`) and a group
  organiser's (#4042, `INV-PAY-124`, which later joiners' claims grow under
  it), which take the same key first, decided from its immutable
  `kind` and `occurrenceKey`. Its completion moves the payment's
  `refundedAmountCents` and closes the task in one commit, and every edit,
  acceptance, paid cancel and by-hand edit-review refund (refused before its
  claim) reads those two separately to size a refund net of
  the cash already promised back (`refundableCashNetOfOpenHandBacks`); under
  `lock(1)` the completion cannot commit between the two reads. A reopen of
  one already holds `lock(1)` and is refused past that same net cash, and a
  refund appeal's approval reads ITS net cash (`INV-PAY-118`: every open
  hand-back, the late-cash credit and, #4124, the card refunds still owed,
  `refundAppealHandedBackParts`) under `lock(1)` and then the Payment row
  (#4124 review F2; see the #4104 section), so a cancellation hand-back's
  completion, which holds only that row, cannot land between its reads; it claims
  the request in that transaction, planning the card refund and raising the
  bank-transfer task for the rest there too, before its Stripe refund and Xero
  note (`PUT /api/admin/refund-requests/[id]#1`, `INV-LOCK-001`). A released
  approval (Stripe and its recovery enqueue both failed) returns the request
  to PENDING and deletes that OPEN task in one transaction under the same key
  (`PUT /api/admin/refund-requests/[id]#2`, `INV-LOCK-001`).

**#3949 adds no key.** An edit's or an appeal's hand-back on a joiner the
organiser paid for by Internet Banking (`INV-PAY-137`) completes under the
`lock(1)` above and then the child's `Payment` row (`lockPaymentForRefundedTotal`),
taken in the route choice before it counts the payment's transactions and reads
the cap, and held to the mirror write (a refund-direction edit review takes the
same order):
global, then the row (`INV-LOCK-002`), the order every refunded-total writer
takes it in. The organiser cancel's per-child claim holds `lock(1)` and writes
the same row, so the two serialise on the global key. Its recovery replay
(`executeGroupSettlementRefundPlan`) holds no `lock(1)`, so it now takes that
`Payment` row before it reads whether the plan's share is written
(`readGroupChildMirrorForPlanReplay`): a completion holds the row before its
claim, so the replay reads the refunded total and the paid-back task together.
The organiser cancel freezes its plan outside the lock and claims each child
under `lock(1)` after it; a completion, and an edit's or appeal's raise of a
new hand-back to the organiser, each under its own `lock(1)`, is refused while
the group is CANCELLED and the child not yet claimed (`groupCancelInProgress`,
the child's status read under that lock), so the plan it froze cannot also be
paid by hand. Any price change of such a child - a price difference or a change fee,
each tested on its own - is refused the same way
(`refuseOrganiserBankChildPriceChangeInGroupCancel`), in
`applyPaymentAdjustments` and in the guest-add door, which settles itself, each
under the door's `lock(1)` with the booking re-read after it, so an
account-credit choice cannot pay the joiner either. The edit quote asks the
same function unlocked, as advice.
The replay plans nothing for a child the cancel did not claim.

**#3791 adds the per-member credit-ledger lock to that completion, after
`lock(1)`, the claim and the closure's re-price**, on the account-credit route
only where nothing was captured: the share goes back through
`giveBackAppliedCredit`, the clamp's own give-back, which takes
`lockMemberCreditLedger` itself. Global, then member-credit is the order every
edit door already takes them in, so it closes no cycle. Everything the amount
depends on is read after that key: the applied credit and the `Payment` mirror,
the deallocation fence (a PENDING deallocation refuses with the task OPEN, the
claim rolled back), the booking's status, the earlier reviews' re-prices and
settled shares (written under the same `lock(1)`), and on a cancelled booking
its restore row and frozen applied figure. The restore row is written under
`lock(1)` by every cancel and under the member key alone by the orphan-restore
backfill, so holding both keys excludes every writer of it. Its Xero
deallocation and credit notes are outbox rows committed with the ledger write
or queued after the commit; the worker calls Xero later, so no provider call
runs under either key (`edit-financial-review-races.realdb.test.ts` forces the
ledger-key interleaving).

**#3835 adds no key.** On a captured payment's card, bank-transfer hand-back
and minted-credit routes, a cancelled booking's share is netted from rows
written under `lock(1)` - the cancel's CANCELLED event, the sibling reviews'
claims, their refund debts, `BANK_REFUND` lines and minted credit - read under
the completion's own `lock(1)`: before the claim on the card and hand-back
routes, which plan, cap and record the netted figure there, and after the
re-price on the minted-credit route. The applied-credit part of that figure
goes back through `giveBackAppliedCredit` on every one of those routes, FIRST:
the full order is `lock(1)`, the claim, the per-member credit-ledger key, then
the `Payment` row (`applyLocalRefundAllocation`'s row lock on the hand-back,
the minted credit's allocation, the give-back's own mirror update). That is the
order the Xero inbound applied-credit repair takes the member key and the
`Payment` row in, so the two cannot deadlock; a review with no credit part
takes no member key at all. The card cap also counts the cancellation's and
earlier reviews' card refunds not yet made, leaving out one that FAILED for
good (a person settles it, and a hand refund already lowers the headroom). The Stripe call stays after the commit
(`edit-financial-review-captured-cancel.realdb.test.ts`).

Registered in `advisory-lock-guard.test.ts` as `resolveManualRefundTask#1`
(`INV-LOCK-002`). The four edit doors and the batch path post their own lines
under the `lock(1)` they already take first; no other writer changes.

**#3257 WIDENS WHEN THAT PROMO ROW LOCK IS TAKEN, AND CHANGES NOTHING ELSE ABOUT
IT.** The re-price used to be invoked only from the night-price repair, so only a
closure that repaired a strand reached `recalculateBookingPromo`. The trigger is
now the review CLOSING, so EVERY closure of an `EDIT_FINANCIAL_REVIEW` task on a
booking carrying a promotion takes that row lock - including a DISMISSAL, which
took none of it before. Same key, same single advisory tier, same lodge -> promo
row order, same deadlock shape against a waitlist confirm; more closures reach
it. The decline above is what keeps the widening bounded: a closure whose strands
cannot be reconciled still takes no promo row lock at all, because the recompute
is never called.

**#3194 ADDS A READ TO THAT SAME LOCKLESS TRANSACTION AND STILL NO KEY.** Where
the task carries no `paymentId` of its own — a review parked before the member
paid — the route decision re-reads the BOOKING's payment on the caller's
transaction and routes on that, so a card payment made while the review was open
is refunded to the card rather than turned into account credit. It composes no
tier: it writes nothing, backfills nothing and takes no key, so it can neither
deadlock against another writer nor produce a second refund. A capture committing
between that read and the claim is the same benign race the section above
describes — the completion simply sees the pre-capture snapshot and routes to
account credit, which is the answer it gave before this change; the anchor-taken
refusal still prevents a second credit on the same `BookingModification`. The
opposite ordering cannot arise: routing to the card at all requires the capture to
have been visible already.

**#3498 ADDS THE ONE TRANSITION ON THIS TABLE THAT DOES TAKE
`pg_advisory_xact_lock(1)`, AND THE REASON IS THE DIRECTION IT MOVES THE FENCE.**
An officer may now put a DISMISSED `EDIT_FINANCIAL_REVIEW` task back on the queue
(`reopenManualRefundTask`, owner decision D2). Every paragraph above argues that a
closure needs no advisory key; the reopen is not its mirror image and inherits
none of that argument.

A closure moves `OPEN -> terminal`, which only RELAXES
`assertNoPendingEditFinancialReview`: an edit that read the fence and proceeded
was entitled to proceed. The reopen moves `DISMISSED -> OPEN`, which TIGHTENS the
same fence **retroactively**, against money-affecting edits already in flight.
Without a key that interleaves, and the interleaving pays a member twice:

1. a member's date change takes `lock(1)`, reads the fence — the task is
   `DISMISSED`, so it proceeds — and runs a long edit that issues account credit
   against its own `BookingModification` M2;
2. mid-window an officer reopens the task, holding nothing;
3. both commit. The task is now `OPEN` on a booking whose edit has already
   settled, its `reviewContext` still points at the earlier modification M1, and
   the `MemberCredit.sourceBookingModificationId` anchor for M1 is free — so
   completing it credits the member a second time, and the `@unique` anchor that
   would have refused a replay never sees one.

So the reopen takes `pg_advisory_xact_lock(1)` as its first statement, before it
reads the row. **The bounded-exception rule that keeps the closure path key-free
has nothing to apply to here**: the reopen calls no provider, sends no email,
writes no allocation and re-prices nothing — the transaction is one read, one
status-fenced `updateMany` and one audit row, all local. Single-lock holder,
composing with no narrower tier, so `INV-LOCK-002`'s global -> lodge -> member
order is satisfied trivially and no cycle is reachable. Registered as
`reopenManualRefundTask#1` in `advisory-lock-guard.test.ts`.

The status-fenced `updateMany` stays and still carries the two-officers case: the
key serialises them, and the fence is what tells the loser the row moved instead
of writing over the winner. The window the key closes is the one no fence on this
row could see, because the racing writer is not touching this row at all.

**The Stripe key and the recovery key are scoped to the TASK, not to the
`BookingModification`.** Owner decision D-3032-1 settles a review against the
ORIGINAL edit's modification row, and one edit could raise TWO review tasks — two
unpriceable strands, one modification row (no edit raises one since #4317). A modification-scoped Stripe prefix
would give two same-amount refunds identical per-slice keys, so Stripe would
answer the second with the FIRST refund and the caller would take the replayed id
as success; a modification-scoped recovery key would let the two tasks upsert one
another's row, and that upsert overwrites `amountCents` and `stripeKeyPrefix`.

**#3170's CHARGE keys are scoped the OTHER way — to the `BookingModification` —
and that is not a contradiction, it is the same question answered about a
different object.** A refund is money already SENT, so two refunds of one edit are
two movements that must never converge; a charge is a REQUEST the member still has
to act on, and the owner's 30 Aug 2026 decision on #3170 is that one edit raises
exactly one of those, for the total of its shares. Two requests lose money without
any race at all: minting an additional PaymentIntent queues every other
outstanding `ADDITIONAL` transaction on that payment for cancellation, and
`reconcilePaymentAggregates` carries a single `additionalAmountCents` rather than
a sum. So a later share RAISES the existing intent's amount instead of minting,
and both the Stripe key and the recovery key name the edit.

**Two officers settling two shares at once is made safe by DERIVATION plus a
single-flight CLAIM on the raise, not by a lock** — which matters here because this
path still holds none, for the reason above. The combined total is summed from the
settled task rows (`sumEditReviewChargeSharesCents`) at execution time, after the
caller's transaction has committed, so:

- **no double count** — each task contributes exactly once, from the row its own
  status-fenced claim wrote, and never as an increment of a running figure;
- **no lost share** — whichever completion commits LAST necessarily reads after
  both commits, so at least one run always derives the true total, and the raise
  claim below is what makes that total the one ASKED FOR;
- **a stale replay cannot lower a live ask** — a settled share is terminal, so the
  derived total only ever grows and a smaller figure is always the older answer,
  and the write REFUSES TO LOWER the recorded request. Since #3371 a balance
  carried in from another edit is stored apart from that sum
  ([`INV-PAY-098`](invariants/payment-and-settlement.md)) precisely so the sum
  stays monotone; folding it in would make the figure fall when the member paid,
  and repairing that would need the lock this path may not hold.

**The refusal to lower orders nothing between two CONCURRENT runs, so since #3402
the raise is single-flight per edit**
([`INV-PAY-112`](invariants/payment-and-settlement.md)). Before it,
`syncEditFinancialReviewChargeRequest` read the `ADDITIONAL` row, compared in
application code, called Stripe and upserted: two runs each deriving a figure ABOVE
the stored one both proceeded, and the provider amount and the row settled on
whichever LANDED last — shares of $60 and $100 against a stored $50 could end at
$60, the second officer's $40 never asked for and nothing recording it. A
`where amountCents < raised` predicate is no repair: both runs pass it, and the
money has moved at Stripe before the row is written, so the row and the intent
would disagree instead.

So the claim is taken BEFORE the provider call, on `EditReviewChargeRaiseClaim`
(one row per `BookingModification`, `edit-financial-review-charge-raise-claim.ts`):

1. **claim** — a guarded `updateMany` writes a fresh opaque token only where no
   live token is held. Under READ COMMITTED a concurrent second claim re-checks
   that predicate against the winner's committed row and matches nothing, so
   exactly one run proceeds;
2. **record the intent** — the amount about to be asked for is written under the
   EXACT token, renewing the lease; no row means the lease was taken over, and the
   run makes no provider call;
3. **call Stripe** — update, currency re-issue, or the first mint (which is under
   the claim too: two first shares would otherwise mint two intents under two
   amount keys, each superseding the other);
4. **write the row** — on the raise (`paymentIntents.update`) from Stripe's
   answer (`amount` on the returned intent), not from the figure asked for; a
   currency re-issue and a first mint write the amount they REQUESTED, which their
   amount-carrying keys make the amount a replayed key returns. The raise writes
   AMOUNTS ONLY, through `writeRaisedAdditionalRequestAmount`, and only onto a
   live (not withdrawn) ADDITIONAL row that is not captured: a
   `payment_intent.succeeded` webhook landing between Stripe accepting the new
   amount and this write is not reverted to PENDING, and the run reports
   `already-paid` (the member paid the new amount). A declined card's FAILED row
   KEEPS FAILED when raised (the old upsert reset it to PENDING): FAILED is the
   ledger's still-owed shape, which chasing and the outstanding-ask readers treat
   like PENDING, and the intent behind it stays payable. A row an officer
   withdrew in that window (#3528) is not written and the run defers;
5. **release** by exact token, then **re-derive**: a run that lost the claim
   committed its share before trying to claim, which was before this release, so
   this read sees it and the holder raises again (up to three passes). After
   `already-paid` it looks again ONLY when the edit's recovery row is dead
   (terminal FAILED): otherwise the deferring share armed that row, and its
   replay writes the share's `ask-closed` audit — looking here too wrote it
   twice. A paid request that already covers every settled share is reported
   `already-paid` with no audit at all, since nothing is uncollected. A
   release that finds the lease already taken over AFTER a provider call is logged
   at error level and reported `deferred`, never `raised`: this run's absolute
   amount may have landed after its successor's.

A run that loses the claim calls no provider, arms the edit's ONE recovery row
(the backstop if the holder dies) and returns `deferred`, which the recovery replay
cannot close (`EDIT_REVIEW_CHARGE_OUTCOME_CLOSES_REPLAY` in
`edit-financial-review-charge-recovery.ts`, one entry per outcome, so
a new outcome is a type error). A raise Stripe REFUSES throws with nothing
written, so the row still equals the unchanged intent; the claim is released and
`executeEditReviewCharge` or the replay makes the debt durable.

**Arming the recovery row is one helper, and it re-arms.** The deferral, the
unminted arm and `executeEditReviewCharge`'s refusal catch all call
`enqueueEditFinancialReviewChargeRecovery`. The shared enqueue's update branch
leaves `status` alone, so before this an edit whose one row an earlier replay had
closed SUCCEEDED - routine once the claim exists, because every resolved race
creates the row and its replay finds the holder already raised - wrote nothing
that would ever run, and a later deferred or refused share was lost. The helper
reopens a SUCCEEDED row (PENDING, due now, attempts reset) and never a PROCESSING
one, which a second worker could then claim; on a PROCESSING row it moves only
`nextRetryAt` — BEFORE reopening, an order under which no interleaving with a
replay's close leaves the row unarmed — and the replay's close is fenced on the
`nextRetryAt` it claimed with, so a share deferred onto a running replay - after
its last re-derivation - hands the row back to PENDING instead of being closed
with it. The close and the hand-back are also fenced on the attempt's
`processingStartedAt` (the stale-worker reaper's own fence), so a worker reaped
and re-claimed while stalled can neither close nor reset its successor's live
claim. A terminal FAILED
row is not reopened: its death handed the edit to the booking-vs-Xero repair pass
and withdrew the live ask (`INV-PAY-057`), and a fresh card request on top would be
the two-instrument state that rule removes. A share that arrives after that is the
repair pass's to find, as before #3402.

**It is a lease, not a lock.** Every claim statement autocommits; no advisory key
is taken and nothing is held across the provider call, so it cannot join a
wait-for cycle and `INV-LOCK-001`/`002`/`003` are untouched. A dead holder's token
ages out after `EDIT_REVIEW_CHARGE_RAISE_LEASE_MS` and the next run takes it over —
safe because the derived total only grows and a raise is an absolute amount.
**Stated limits:**

- a holder still ALIVE past the lease could land an older, smaller amount after
  its successor. The Stripe client's defaults bound a live holder at a few minutes
  per call, but its timeout is a socket-inactivity timeout and a paused process is
  bounded by nothing. The holder now NOTICES (its release fails, and it defers to
  the recovery row instead of reporting `raised`), but nothing prevents the late
  write itself;
- a crash after Stripe accepted but before the row was written leaves the row
  behind the intent until the next run for that edit, as before #3402;
- the lease is measured on each instance's own clock: `claimedAt` is written by
  the holder's `new Date()` and judged by the claimant's, so clock skew between
  instances lengthens or shortens it. The lease dwarfs ordinary NTP skew; a much
  shorter lease would want the database's `now()` instead;
- the replay's close fence compares a millisecond timestamp, so a share armed in
  the same millisecond as the claimed row's retry time would not be noticed —
  unreachable in practice, since a claim and a Stripe round trip sit between them;
- while the previous colour drains after deploy, its syncs take no claim and arm
  the recovery row the old way, so the pre-existing race persists for the drain
  only, never wider. Proven against
real PostgreSQL by `edit-financial-review-charge-raise-claim.realdb.test.ts`, which forces
the $60/$100 interleaving through the real sync.

The contrast is instructive and it is one paragraph down: the refund leg's
`applyLocalRefundAllocation` on this same lockless path IS a real compare-and-set,
because there the write is the whole movement and no provider round trip sits in
front of it. The charge leg cannot be one, because Stripe moves first — which is
why its claim is taken before the call rather than on the write.

The recovery replay is the same function, so a crash between the commit and the
Stripe call costs a delay rather than a share: the row's stored `amountCents` is
advisory and the replay re-derives. A review-charge recovery operation is
therefore routed AWAY from the ordinary additional-intent worker, whose "a newer
additional supersedes this one" check would otherwise see the request this very
edit already minted and complete having minted nothing.

**The lockless path also needed one WRITE made safe.**
`applyLocalRefundAllocation` computes an ABSOLUTE `refundedAmountCents` from a
value it read a moment earlier, so two writers on one `PaymentTransaction`
silently lose an update and OVERSTATE the refundable headroom. Until #3032 every
caller either held `lock(1)` or ran only on a CANCELLED booking, so no two could
race; a review completion is neither — it allocates against a LIVE booking with
no lock, and while the fence keeps most concurrent edits off that booking, a
consent-authority guest removal is exempt (owner decision D-14) and does move
money. The write is now a compare-and-set on the exact value the slice was
computed from, the same status-guarded-claim idiom used everywhere else here: it
CANNOT lose the update. The completion maps the refusal to a 409 with its
transaction rolled back and its task still `OPEN`.

**#3640 corrected two things this paragraph used to claim.** A caller under
`lock(1)` CAN see the guard fire: the Stripe card-refund writers (the
`charge.refunded` sync, the superseded-payment recovery) take no advisory lock,
so a dashboard refund can move a row under booking-cancel's credit disposition.
And a single-shot refusal there rolled a member's cancel back with a 500. So the
allocation now goes through the one compare-and-set every write of the column
uses (`compareAndSetRefundedAmount` in `payment-transactions.ts`): it re-reads
and re-checks headroom on each attempt, absorbs a concurrent move that leaves
room, and throws `RefundAllocationRacedError` only when the headroom is gone.

The card-refund writer itself (`INV-PAY-103`) runs one interactive transaction
per call through `withStoreTransaction`: the `Payment` row locked first
(`lockPaymentForRefundedTotal`, `SELECT 1 ... FOR NO KEY UPDATE`), then
`PaymentRefund` rows inserted with `ON CONFLICT DO NOTHING` in refund-id order,
then the transaction row's compare-and-set, then the `Payment` aggregate and its
booking-ledger lines. No provider call runs inside it. A failed refund's floor
(#4280, `INV-PAY-141`) reads the payment's "Paid another way" close records on
that same client, under the `Payment` row: the close takes `lock(1)`, then that
row, before it writes its record, so the writer sees a close whole or waits for
it. No key is added. Proved in both orders by
`card-refund-reversal-bank-cash-floor.realdb.test.ts`.

**One order for the refunded total: `Payment` row, then refund rows, then
transaction rows** — and, in a transaction that also takes the per-member
credit-ledger key, that key before the `Payment` row (#3792, below). Every writer that holds more than one of them takes the
`Payment` row first through `lockPaymentForRefundedTotal`: the card-refund
writer, `applyLocalRefundAllocation` (joining the caller's transaction), and the
paid-path cancel claim, right after its lodge capacity lock and before #3643's
part-payment recognition, its eligibility re-check and the #1491 fold. The claim
then re-reads the `Payment` row under that lock (#3793): the card-refund writers
take no advisory lock, so the payment read with the booking under `lock(1)` can
already miss a dashboard refund, so that read takes only the payment's id;
every figure the refund is tiered off, and the refund method an internet
banking payment forces, comes from the re-read. Proved by
`paid-cancel-refunded-total-race.realdb.test.ts`. The first version of this
writer took the transaction row and then the
`Payment` row (its aggregate), while a cancel with an unpaid top-up takes the
`Payment` row (failing the top-up) and then the transaction row (its credit
allocation): a deadlock, proved and closed by
`card-refund-mirror-races.realdb.test.ts`. `NO KEY` strength, so a refund
insert's foreign-key check (`FOR KEY SHARE`) on the same payment is not blocked.

**#4217: every ledger-row writer that holds a row while it waits for the
`Payment` row now takes the `Payment` row first, and so does the rebuild.**
Until #4217 this paragraph said the capture webhooks wrote one row per
autocommit statement and so could not join a cycle. That stopped being enough.
`reconcilePaymentAggregates` read a payment's rows and reached the `Payment` row
only at its update. So it could read, queue on that row behind a refund writer,
and then write totals from rows that writer had since changed: the refunded
total stopped matching the detail (a #4162 unwind, an allocation or a card
refund lost from it). And the five writers that end in it wrote their row
first, the reverse of the order above. A settle re-recording a captured charge
under `lock(1)` and a card refund on that charge deadlocked (40P01, measured on
the pre-#4217 code). Now:

- `reconcilePaymentAggregates` locks the `Payment` row before it reads. Inside
  a writer that already holds it, the re-lock is granted at once.
- `upsertPaymentIntentTransaction`, `writeRaisedAdditionalRequestAmount`,
  `recordInternetBankingPaymentTransaction`,
  `markPaymentIntentTransactionSucceeded` and
  `markPaymentIntentTransactionFailed` lock it before their first row write,
  each in the caller's transaction or a short one of its own
  (`withStoreTransaction`). The two `mark…` writers first learn the payment by
  a pure read (the intent's row, or the `Payment` pointer), then lock it and
  re-read, so a pre-ledger payment's backfill runs only under the lock.
  Mark-failed's "not captured" check is a status-guarded `updateMany`.
- An intent's row never moves payment. The upsert's row write
  (`writePaymentIntentTransaction`) matches only the locked payment's row and
  refuses one the intent has on another payment; the saved-card settle and the
  `mark…` writers' re-read refuse it the same way
  (`IntentLedgerRowOnAnotherPaymentError`), before any write. A move would
  change one payment's rows under the other payment's lock. The recovery
  runner ends an additional-intent recovery refused this way at once, as it
  does an attribution conflict: every retry would meet the same row.
- Three writers that write a row before they reach the rebuild take it first
  too: the price reduction's retire (#3954 above), the saved-card attempt's
  settle (`settleSavedCardChargeAttempt`, inside its release transaction), and
  the Stripe settle (`settleBookingPaymentInTransaction`, straight after its
  `Payment` upsert, before the ledger lookup that may backfill). On the root
  client the saved-card settle runs in a short transaction of its own, so a
  unique violation there rolls it back whole and it runs once more.
- The Internet Banking settle (#4094) takes it after `lock(1)`, the lodge key
  and the member key, and re-reads the payment's figures under it; its rows are
  read under it. Its figure logic (#3979, `INV-PAY-126`) is unchanged, except
  that a keep also counts an applied correction already synced there, from
  link rows it reads plainly (#4095). After it commits, outside every lock, a
  keep or a replay with an applied correction triggers the lock-free inbound
  recount (`repairRefundedPaymentBusinessState`, no note of its own), whose
  claim on the row as read loses to any writer in between; it adds no key.
  Both run only when exactly one payment matches the invoice
  (`matchedPayments === 1`): otherwise no payment's share of a correction is
  known, and neither counts one.
- A cancellation hand-back's completion decides whether its Xero note stands
  on its own task (#4287, `INV-ADDPAY-043`,
  `cancellationHandBackNotedOnItsOwnRecord`) only after its allocation has
  taken the `Payment` row, on the same transaction, and relies on that lock:
  a second completion on the payment reads the first's committed note row, so
  two hand-backs never both take the canonical route. It adds no key.
- A card refund's own Xero note on a bank transfer (#4312, `INV-ADDPAY-047`)
  takes no lock and needs none: its writers queue it after the refund's ledger
  write has committed under the `Payment` row (`recordStripeRefundsAgainstTransaction`,
  whose order is unchanged; it only reports which refunds it newly counted), and
  never write the `Payment` row. Two writers asking for one refund at once
  build one key (`cardRefundNoteKey`) and collide on the outbox's partial
  unique index on an active correlation key, so one row stands. It adds no key.
  The mark that pairs a re-send with its failures (`madeRefundId`, round 8) is
  one compare-and-set on the recovery row's `allocationPlan`, no lock: the
  runner's (`markResentSlices`) on the plan its attempt sent from,
  `charge.refunded`'s on a dead row (`pairResendRecordedFirst`) on the plan,
  status and attempts it read, and the resend preflight's slice-evidence mark
  (`checkCardRefundResend`, #4510, `INV-PAY-147`) on the stored plan it read
  (a later charge's on the plan it just wrote), `PROCESSING` and the claim's
  `processingStartedAt`, after its provider read and ledger write; a lost
  preflight write sends nothing. Any plan written in between (a re-plan, a
  refusal's move, another mark) fails it; a refusal's move stays fenced on
  the holder's attempt. Unlike the failed-later re-plan (#4104), a mark never
  takes the `Payment` row, so that lock does not order it against "Paid
  another way"'s owed read. The close's claim carries the plan it read that
  figure from (`onPlanWhere`): a mark landing between the read and the claim
  fails the claim with its "changed while you were closing it" 409. A
  `charge.refunded` mark that loses to the claim reads the row again and marks
  the closed row's slice on its plan alone, as the runner's does
  (`markClosedRowAfterLostWrite`); any other lost write is logged.
- The waiting ask's recovery row comes after the `Payment` row too (#4217
  review). A reduction that gives credit back has written the `Payment` row
  before its retire closes the recovery; the runner's claim hold
  (`holdAdditionalIntentRecoveryClaim`) and the re-issue door
  (`writeReissuedAskUnderRecovery`) used to take the recovery row and then the
  `Payment` row, a deadlock. Both now lock the `Payment` row first, the retire
  locks it before its recovery close, and an increase's fold-close
  (`foldWaitingReissuedAsks`) before the recoveries it folds. That is also the
  #4104 order (`Payment` row, then the `PaymentRecoveryOperation`).
- The manual-payment reversal (`reverseManualBookingPayment`) takes it straight
  after `lock(1)` and the lodge key, before its guards read the payment and
  before it deletes the stale asks' cancellation and refund recovery rows. It
  used to delete those rows first and reach the `Payment` row only at its own
  write, while the claim hold takes the `Payment` row and then upserts the same
  cancellation rows: a deadlock.
- The superseded-intent hand-off (`handoffSucceededSupersededIntentToRefund`,
  #4320) re-claims its cancel row, marks the capture SUCCEEDED
  (`markSupersededTransactionSucceeded`) and rebuilds in one transaction, the
  `Payment` row first, then the recovery row, then the transaction row. The
  reversal holds that `Payment` row from its "no settled Stripe transaction"
  check to its commit, so the two serialise: a hand-off that commits first
  makes the reversal refuse, and one that waits finds its row withdrawn and
  claims nothing. As separate statements the flip could land after that check,
  and the member was charged and refunded on a booking left unpaid. No provider
  call runs inside; its callers all run outside any transaction.
- The reversal re-arms a cancellation it leaves standing that the runner will
  not finish (`rearmDeadIntentCancellations`, #4320), including one a worker
  holds PROCESSING on its last attempt, mid-Stripe-call and holding no lock.
  That worker cannot undo the re-arm: its failure write is fenced on the
  attempt it claimed (`attempts`, with `processingStartedAt` set), which the
  re-arm reset; its success write closes the row, which is true; its hand-off
  re-claims the PENDING row through the same status-fenced claim the webhook's
  uses (only the webhook's adds an attempt), and queues the refund by key.
- A writer that reaches only the rebuild, such as the superseded refund's own
  late flip in `processRefundSupersededPaymentOperation` (an autocommit row
  write, then the root-client rebuild), is covered by the rebuild's own lock.
- Some writers need no lock because each of their statements autocommits, so
  they never hold a row while they wait for another:
  `markSupersededTransactionFailed` in `payment-recovery.ts` (before its
  rebuild), and `markSupersededTransactionSucceeded` outside the hand-off
  above, the attempt's
  FAILED and PROCESSING flips in `saved-card-charge-request.ts`, the retired
  card's ledger clear in `saved-card-charge-failure.ts`, and the invoice stamp
  in `xero-booking-invoices.ts`. `beginSavedCardChargeAttempt` writes attempt
  rows inside its claim transaction but never reaches the `Payment` row after
  them, so it holds rows without waiting on that one.
- Callers of `findPaymentTransactionByIntentId` outside a ledger writer (the
  webhook handlers and the confirm routes, among others) can still backfill
  rows outside the lock, but only for a payment from before the ledger
  existed. A backfill inserts new rows in autocommit statements and holds
  nothing while it waits. Routing them through the pure lookup would drop the
  row they read for such a payment. The Stripe settle's own lookup runs under
  the lock.

The order is `lock(1)` where held, then the lodge key, then the member
credit-ledger key, then the `Payment` row, then refund rows, recovery rows and
transaction rows (`INV-LOCK-001`, `INV-LOCK-002`). Every writer that holds two
of those last rows and then waits holds the `Payment` row first, so their order
beneath it cannot form a cycle: two of them on one payment queue on the
`Payment` row (`beginSavedCardChargeAttempt` holds attempt rows but never waits
after them). No
advisory key and no row-lock statement was added: every site calls
`lockPaymentForRefundedTotal`. Every holder of the `Payment` row was checked
for a row it takes after it that a writer above already held. The retire, the
saved-card settle, the claim hold, the re-issue door, the fold-close and the
manual-payment reversal were those writers, and they now lock first; the
superseded hand-off joined them in #4320.

`payment-lock-before-rebuild.realdb.test.ts` proves it with seven forced
interleavings. Races 1 to 5 each fail on the pre-#4217 code; the third stands
in for the settle (an upsert under `lock(1)`, the settle's write, not the whole
`markBookingPaymentSucceeded`). Race 6 is the cost below, and race 7 is the
manual-payment reversal against the claim hold's shape. The two reduction
races in `additional-ask-reduction.realdb.test.ts` cover the capture webhook,
and the credit give-back against the real runner's claim hold.
`payment-lock-before-rebuild.test.ts` pins the lock as each writer's first
statement. The hand-off against the real reversal is proved in
`manual-reversal-retrying-cancel.realdb.test.ts` (a capture landing while the
reversal holds the `Payment` row settles the booking, never refunded), and its
lock order in `payment-recovery.test.ts`.

**The cost: P2028 and Stripe's retry.** These writers were autocommit before
#3640 and #4217, so they now carry Prisma's interactive-transaction limits (2 s
to start, 5 s to finish). A webhook queued behind a long holder of the
`Payment` row, such as a paid cancel's claim or an edit's settlement, can time
out (P2028). It is loud and rolled back whole: the suite's sixth race proves
the capture writes nothing and its retry records it. It is answered 500 and
retried by Stripe; a door's own write that times out is an error its user
retries. The trade is deliberate, as on #3640: a loud retry rather than a
refunded total that silently disagrees with its detail.

`src/lib/__tests__/edit-financial-review-races.realdb.test.ts` proves both halves
against a real server, forcing the interleaving with a third connection rather
than hoping for it: two concurrent applies of one occurrence queue on `lock(1)`
and raise exactly one task, and two concurrent completions queue on the task ROW
and issue exactly one credit.

**And one new READ inside the booking-edit lock envelope.**
`assertNoPendingEditFinancialReview` is called by `modifyBookingBatch`,
`modifyBookingDates` and `removeBookingGuestInTransaction` after both locks and
after the post-lock re-read, on the caller's `tx`. It takes no key of its own and
adds no tier: it is a `findFirst` on the caller's transaction client, placed under
the locks precisely so it cannot be answered by a task a concurrent completion
was about to close. `adminShiftBookingDates` is the one edit path deliberately
NOT fenced — it is price-preserving (`priceDiffCents: 0`, no refund, no credit),
so it needs no money baseline. The predicate the three fenced services pass is
each one's OWN repricing test, not a second expression beside it: the batch
service passes `!pricePreservingModification`, the same value that chooses between
the identity echo and the pricing engine twenty lines later. An earlier revision
asked a similar-looking pair that differed by the other-lodge term, and a request
carrying a name edit AND an other-lodge election — one the route's schema
accepts — skipped the fence and then repriced.

The preview takes the same fence, on the same predicate expressed in its own
names (`src/app/api/bookings/[id]/modify-quote/route.ts`). It reads on the module
client because a preview opens no transaction and writes nothing: a race with a
completing review costs a stale quote, which the save then refuses under its
locks. Without it the member would be shown a refund priced from a baseline the
club has already said it cannot read, and the save would 409 on submit.

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

`lock(1)` also serialises the duplicate-capture adjudication (#1992,
`duplicate-capture-guard.ts`). The PAID claim that wins under `lock(1)` writes
`Payment.settledByTransactionId` in its own transaction (#4211), so exactly one
settlement is ever recorded, and the reversal that clears it holds the same
lock. When a Stripe success arrives for an already-PAID (or, #4285, COMPLETED) booking,
`markBookingPaymentSucceeded` keeps the recorded settler, and refunds any other
arriving capture with no refund history (#1765) only while the recorded settler
still holds net cash, is a card capture that neither the superseded-intent
machinery (b′: a live operation, or #4227 a failed-later refund open rows owe
back in full) nor a duplicate-capture refund operation
(`duplicate_capture_<bookingId>_<pi>`, at any status) owns, or is a non-card
settlement (#2262); with no usable record it refunds nothing new and alerts.
An arriving capture the superseded machinery holds is never refunded on top
(#4283).
That check-then-enqueue is race-free only because every caller runs it under
`lock(1)`: interleaved webhook replays of BOTH captures would otherwise refund
both sides and settle the booking at zero net cash. The
refund itself follows the #1349 enqueue-then-execute shape — the durable
operation (with the slice pinned to the duplicate's own transaction) commits
with the detection, and the Stripe refund executes after commit under the
shared `duplicate_capture_refund_<bookingId>_<pi>` key prefix the recovery cron
replays. Relatedly, the auto-charge cron's pre-charge sweep that cancels
superseded /pay link intents (#1992 Option 1) is a plain Stripe call strictly
OUTSIDE any transaction, after the claim commit: the claim's link revocation
under the lodge lock freezes the set of link intents, and the sweep excludes
every saved-card charge ATTEMPT row — recognised by the `pending_charge_` prefix
on `reference`, the constant the attempt module mints with (#3267,
`INV-PAY-055`) — because a still-unresolved attempt row on this card IS this
run's attempt and is about to be asked about. It also excludes, BY ID, the one
row this run's claim chose to replay: a pre-#3267 shared-key row or a /pay link
intent on the very card about to be charged carries no attempt key, but the
claim treats it as this run's attempt and is about to retrieve it, so sweeping
it would cancel the intent the run is waiting on. (The exclusion used to be two
`reason` literals, because Stripe's shared `pending_charge_<bookingId>` key
re-returned a prior run's intent; there is no shared key any more.)

**#3267 added one writer to every saved-card charge CLAIM, at the same tiers
in the same order.** The claim transactions of `resolveHoldWindowUnderLock`
(the cron), the admin confirm-pending-guests charge branch and — new to the
cohort — `charge-saved-method`, which until #3267 charged with no claim at all,
each call `beginSavedCardChargeAttempt` after the status-guarded PENDING ->
CONFIRMED claim: under `lock(1)` then the lodge lock it reads the payment's
PRIMARY Stripe rows, status-guards a superseded attempt to FAILED, and creates
the attempt row whose own id is the Stripe key. Holding both locks across that
read-then-write is what makes the ledger the double-charge guard the shared key
used to be: two paths can never both hold an open attempt for one payment. The
Stripe-side cancel of a superseded attempt's intent, and the charge itself, run
AFTER commit in `chargeSavedCardAttempt` — plain provider calls outside any
transaction (`INV-INT-003`). A payment already holding captured cash THROWS
inside the claim, which rolls the whole claim back rather than compensating it.
The non-captured release (CONFIRMED -> PENDING) records Stripe's answer on the
attempt row inside the locked release transaction — all three paths, including
the admin route, which until the #3267 review round settled on the base client
BEFORE taking the locks (`settleSavedCardChargeAttempt`, `store: tx`). Two
properties make that release safe against a webhook that captured while the
path was talking to Stripe. The record is FORWARD ONLY (a capture over anything
but refund history, a non-capture only over an unresolved row), so a stale
`processing` read cannot put PROCESSING over the webhook's SUCCEEDED and leave
a PAID booking whose ledger shows no captured money. And the booking's status is
re-read UNDER THE SAME LOCKS after the record: a booking no longer CONFIRMED is
not released at all — the status-guarded `updateMany` would have matched zero
rows and thrown nothing, so the path says so in the log instead of releasing
into the dark. What it says depends on WHICH status it finds. PAID is the
expected loser of that race and is a warning; any other status means a
different actor took the claim mid-charge, which is what the pre-#3267 throw
surfaced, so it is logged at error level and the cron counts the booking
failed. A definite refusal's FAILED mark is a single-row status-guarded
`updateMany` on the base client, holding no lock, because it races nothing (the
intent, if any, is already terminal).

The claim/release/refusal shape is written out three times — the cron, the admin
route and `charge-saved-method` — deliberately. Each has its own surrounding
transaction, its own audit and alert obligations and its own response, and the
only common part is the two lock acquisitions, which are already one helper
apiece; extracting a shared claim helper is a refactor of its own, not part of
#3267 (`INV-PAY-055`).

The same cron's terminal branch for a permanently unusable saved card (#3268,
`INV-PAY-054`) runs AFTER `releaseChargeClaim` has committed and holds no lock
at all: the Stripe detach is a plain provider call outside any transaction that
gates what follows (a detach failure other than `invalid_request_error` rethrows
before either write), and the two `updateMany` clears
(`Payment.stripePaymentMethodId`, `PaymentTransaction.paymentMethodId`, both
matched by the exact pm id) are unlocked single-field writes: the setup-intent
route already writes `Payment.stripePaymentMethodId` unlocked, and nothing
writes `PaymentTransaction.paymentMethodId` after the row is created. The race
that matters is harmless: a charge that read the pm a moment before the clear is
refused by Stripe for the same reason and lands in the same branch, where the
second clear matches zero rows and the second detach is an
`invalid_request_error`, which is swallowed.

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

**#2936 adds one that holds the key for a REQUEST rather than a booking.**
`correctBookingRequest` (`src/lib/booking-request-corrections.ts`) is the officer's
one write for correcting an unconverted school or public `BookingRequest` — its
dates, its party, its catering preference, its school name and contact. It takes
`lock(1)` and **nothing else**.

**What the key buys is the school-record fence.** While it holds the key the
claim re-asks which `Organisation` the corrected school name claims (#3367),
read-only, and checks the officer's on-screen acknowledgement against THAT
answer rather than against the one the form rendered. `resolveOrCreateSchoolOrganisation`
is the only writer of those records, and its unique-name claim is the approval
transaction's hold of this very key — so excluding approval is precisely what
lets the re-read promise that no record appeared in between. That is what turns
"this is that school" / "add it as a new school" into a fence rather than a
courtesy tick, and it is why the correction cannot simply drop the key.

**What the key is NOT for: the conversion's own write.** An earlier version of
this section said the claim could not close the correction-versus-conversion
race because the conversion's final write is not version-guarded. That was
wrong, and it is worth correcting rather than quietly deleting, because a
registry entry is what the next writer reasons from. Both
`approveBookingRequest` and `approveSchoolBookingRequest` claim on
`version: request.version` (#1923). The correction's version bump therefore
settles that race in both directions on its own.

**The counterparts that a version fence did NOT close** are the four quote
writers in `src/lib/booking-request-quotes.ts`, and they are the ones this
writer actually had to be reconciled against. A **decline** sets a TERMINAL
status, so a guard reading "not declined, not cancelled" was a complete fence
against it. A **correction sets a LIVE one** — `VERIFIED`, still quoteable,
still correctable — so that same guard sees nothing. All four are reconciled at
the writer, per the checklist in `AGENTS.md`; #3415 replaced the deliberately
unfenced MODIFY/QUERY message writer with a global-lock response claim:

| Writer | What a correction did to it | How it is fenced now |
| --- | --- | --- |
| `createBookingRequestQuote` | a plain update restored the retired price, option totals and stale positional member links over the corrected row | claims on `version: request.version`, and throws before any quote row is touched |
| `sendBookingRequestQuote` | an unguarded quote flip turned a `SUPERSEDED` quote back into a live `SENT` one with a fresh response token — priced on the pre-correction party, against the post-correction dates, with no beds held, because the correction's release runs afterwards | claims the quote row while it is still `DRAFT`/`SENT`; count 0 rolls the whole transaction back, and the email is outside it |
| `respondToBookingRequestQuote` (accept) | a split request/quote write could expose accepted request data while its token still named a live quote, and a correction could otherwise restore a retired price and snapshot | takes `lock(1)`, re-reads the quote and request-owned hold, then claims `QUOTE_SENT -> ACCEPTED` on the request and `SENT -> ACCEPTED` on the quote in request-then-quote order in one transaction; either lost claim rolls both back. A matching retry is read-only. |
| `respondToBookingRequestQuote` (the MODIFY/QUERY branch) | a stale message could re-status a corrected or accepted request and re-stamp a quote already `SUPERSEDED` | takes `lock(1)`, re-reads the request and quote, requires the loaded-version `QUOTE_SENT` request with no accepted pointer and the `SENT` quote, then claims the request before superseding only that `SENT` quote; stale responses return `409` before either write (#3415) |

It joins no capacity tier because it creates no booking and claims no bed. The
`AWAITING_REVIEW` hold a corrected request may still be carrying is released
AFTER this transaction commits, through the shared `cancelBooking` path, which
takes `lock(1)` and then the booking's lodge key itself — so the correction never
nests a self-locking call inside its own transaction. That claim-first ordering
is `declineBookingRequest`'s, deliberately: its worst case is a request still
pointing at a hold covering more than it needs, visible on the officer's screen
with its own Release button, rather than a request that has silently lost beds.

The stale-hold cron independently refuses any request with an accepted quote
pointer (#3415). Acceptance retains its `AWAITING_REVIEW` hold for officer
approval or decline; generic cancellation refuses an `ACCEPTED` linked request
under the global lock. Officer decline claims `DECLINED` before releasing it.

### Writer doing both → `lock(1)` first, then per-lodge

The Stripe capture (`markBookingPaymentSucceeded`), the confirm-pending-guests
zero-dollar and charge branches, the `charge-saved-method` claim and release
(#3267), the waitlist-confirm $0 PAID claim, the admin
return-to-waitlist repair (#2649), the
switch-to-internet-banking hold, the officer's held-request conversion
(`approveBookingRequest`), and every booking modification service
(batch/date/guest-removal) take **`lock(1)` first, then the per-lodge lock**.
`xero-inbound/invoice-paid-effects.ts` is the in-tree precedent for this
composition.

Officer approval of a held generic request pre-reads only the held booking's immutable concrete
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

The #4019 whole-lodge credit/$0 approval and new whole-lodge zero-cash edit
settlements use `booking-ledger-confirmation-sync.ts` under their existing global
then lodge locks (`INV-LOCK-001`/`INV-LOCK-002`). The cash settle uses the same
extracted poster. It keeps the existing per-booking confirmation fence and fee
posting keys (`INV-PAY-047`); edit callers invoke it after their guest/night
writes and modification posting, so first settlement posts the final price
and an already-confirmed ledger keeps its ordinary modification lines.

`switch-to-internet-banking` also recomputes both the locked booking price and
the authoritative `BOOKING_APPLIED` credit aggregate after acquiring global,
lodge, then `lockMemberCreditLedger(memberId)` locks in that order;
the IB payment mirror must never mix a pre-lock price with post-lock credit (or
vice versa). Before any switch write, the post-lock payment source is also
re-read: an already-Internet-Banking payment returns its persisted reference
and hold fields (no hold once `internetBankingHoldReleasedAt` is set), without
another PRIMARY row, credit consumption or hold reset. Both replays, this one
and the early unlocked one, re-run the post-commit invoice and credit-allocation
enqueue on a live booking (`internet-banking-switch-replay.ts`), after the
transaction and holding nothing, re-reading the booking's live state first so
a cancel that committed since the unlocked read queues nothing: both enqueues
are idempotent, and the retry is what heals a first switch whose enqueue failed
after its commit. For a request that reaches the locked switch path, a
concurrent cancellation or deletion wins before the already-IB replay.
Status alone cannot claim a switch: whole-lodge and ordinary no-hold switches
leave the booking's status unchanged (#4019).
The switch and both card mint doors (the pay route and the
`/pay/<token>` link) also exclude each other on lock(1) (#3638,
`INV-PAY-102`): the switch refuses unless Stripe confirms the card intent is
dead before its transaction, and under the lock it refuses when the payment
points at a different intent from the one it retired; each mint door attaches
its freshly minted intent through `attachMintedCardIntent`, a global-only
transaction that re-reads the payment's source and the booking's status and
refuses an Internet Banking or no-longer-payable one.
Waitlist offer confirmation resolves only the immutable lodge key
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

A settlement waiting on its combined invoice is bound to it (`INV-PAY-105`,
#3642). Every writer that could change it re-reads the settlement under the
same `lock(1)`: the child-commit transaction (a card attempt is refused before
any claim; an Internet Banking change is refused after its claims, so they roll
back, unless the settlement still points at the invoice checked in Xero before
the lock), the Internet Banking settle transaction (which retires the old
invoice and queues the next attempt in the same commit), and the card attach
transaction. The reaper's release transaction retires the invoice in its
commit, except for a cancelled group. The create worker's post-create fence
(`bindCreatedGroupSettlementInvoice`) writes the pointer and the ACTIVE object
link together under `lock(1)`, or abandons the invoice when the settlement is
released, superseded by a later attempt, pointing elsewhere, or at another
total; `releaseUninvoiceableGroupSettlement` FAILS a bound settlement under the
same key when its joiners' stored prices cannot make the invoice. The
paid-invoice and card applies compare what arrived with the total,
invoice and intent read under `lock(1)`. Every Xero read (the replacement
check, the reaper's pre-release check, the VOID worker's pre-read) runs outside
any transaction. No lock key, order or site is added; the realdb proof is
`group-settlement-invoice-binding-races.realdb.test.ts`.

A joiner's payer is decided under the same `lock(1)` (`INV-PAY-109`, #3672):
the booking create re-reads the group's settlement before writing an
organiser-settled child, and the paid apply switches every organiser-settled
joiner the paid bill missed to member-pays, with a payer-switch booking event
each, in the transaction that marks it SUCCEEDED. Whichever commits first, the
other sees it. The switch is one guarded `updateManyAndReturn`, so exactly the
rows it changed are recorded and emailed. The reaper's self-heal
(`releaseJoinersLeftBehindPaidSettlements`) takes `lock(1)` alone per group,
re-reads the group, settlement and organiser booking, and applies the same
switch; a switched joiner no longer matches its scan. Emails and the
treasurer's once-per-group alert are sent after commit; the alert pass reads
the events of stays not yet ended and takes no lock. Its `AlertCooldown` claim
is kept once a copy is sent or queued for the email retry cron, so the two never
both send it; the release and the one-day hold match the claimant's own stamp.

An organiser's close or reopen (`setGroupBookingJoinStatus`, #3672 review)
takes `lock(1)` too, re-reads the status under it and writes with a
not-CANCELLED guard. Before, it wrote from a stale read with no lock, so a
reopen racing the organiser-pays cancel fence could write OPEN over the
CANCELLED that the paid apply, the reaper and the switch rely on. The two
sites add registered `lock(1)` entries and no new key or order. The realdb
race proof for the join-versus-paid orders is a stated limit: they are pinned
by mock call order only.

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

### Pending school-adult beds (#3413)

An unnamed adult on a SCHOOL request is a count, never a guest identity.
`holdBookingRequestSlots` takes `lock(1)` before the immutable lodge key when
the pending count is positive, re-reads and version-claims the request, then
creates the `AWAITING_REVIEW` hold and its per-night anonymous reservation in
one transaction. The canonical occupancy reader adds those counts to named
guest nights. Generic hold cancellation and requester quote cancellation delete
the reservation in the same transaction as the status flip. Reusing an existing
unnamed-adult hold takes the same global-then-lodge locks and rechecks the live
request, held booking and exact reservation nights before returning it. The
quote-expiry worker's two direct hold-release paths also delete it under their existing
global lifecycle lock. `resolveAcceptedSchoolPendingAdults` takes global then
lodge in the same order,
checks the accepted snapshot, hold and reservation after locking, and proves a
unique mapping from original named/pending ordinals to the current party,
including previously named adults. After claiming the request version, it
reconciles provisional held guest/night and booking cents to the accepted
snapshot before replacing anonymous slots (#3794). Existing guest/night ids,
member links, consent, dietary and bed identities stay intact. A lost claim
writes nothing; any failure rolls back prices, names and reservations together.
Night updates group exact proven ids by cents and provenance and require every
row to be affected; statement count depends on distinct prices, not stay length.
The shared naming/approval proof refuses any held night with a NULL price
(`INV-MOD-028`, `INV-MOD-036`); the naming update also excludes NULL rows and
rolls back if its affected count falls short. Accepted terms never fill a blank.
Accepted terms and settlement remain unchanged; this writer adds no lock tier
or provider call. Active matching identities use canonical seasonal membership
policy, so login-disabled member-rate adults still require terms review.
Terminal decline and requester-cancel claims clear the pending adult count;
quote snapshots remain unchanged. A generic hold release retains the request's
count so that an open request can be held again. School and general approval
both refuse a nonzero pending count or residual
reservation under their own global-then-lodge locks. School approval reuses the
accepted-party proof before claiming conversion, retaining per-person cents
and pairing rewrites with proven held guest ids after naming shifts request
positions. Missing or inconsistent accepted snapshots refuse conversion before
effects. Provider calls are outside
these transactions.

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

### Finished-stay change-request execution (#3750)

Approving a `LOCKED_PERIOD` change request on a finished stay
(`approveAndExecuteLockedPeriodChangeRequest`,
`src/lib/booking-change-request-execution.ts`) composes only existing keys and
adds one registered global site, `approveAndExecuteLockedPeriodChangeRequest#1`
(`INV-LOCK-002`, `INV-LOCK-003`). Order, in one transaction:

1. Pre-read only the booking's immutable `lodgeId`; take global `lock(1)`
   inline, then `acquireLodgeCapacityLock`. The canonical `modifyBookingBatch`
   re-enters both (no-ops) and takes the member-night / member-credit keys after
   them, so the order stays global → lodge → member.
2. Reauthorise the officer from fresh roles (`reauthorizeBookingOfficerFromDb`).
3. Re-read the request under the locks: `REQUESTED`, `LOCKED_PERIOD`, the
   expected `version`. Check drift (the booking's dates and guest set against the
   request's `original`) and the active-lifecycle status gate.
4. Claim with `updateMany where {id, status: REQUESTED, kind, version}` →
   `APPROVED`, `version + 1`. A lost claim runs no side effect.
5. Run `modifyBookingBatch` on the same `tx` with `finishedStayCorrection` and a
   `preTransaction` resolved before the transaction opened (`INV-LOCK-004`).
   Any refusal throws and rolls the claim back.
6. Write `linkedModificationId`, commit, then run the service's
   `deferredPostCommit` (Stripe, Xero, email, audit) outside every lock.

**Counterparts.** A cancel, capture or refund of the same booking holds
`lock(1)`, so an approval that arrives during one queues behind it and then sees
the committed state — a cancelled booking fails the status gate and nothing is
claimed. Two approvals serialise on `lock(1)`; the second re-reads the request as
`APPROVED` and loses the claim. The acknowledgement path (a stay that has not
finished) claims on `status: REQUESTED` and now bumps `version`, so it and an
execution cannot both win. Proved against PostgreSQL in
`booking-change-request-execution.realdb.test.ts`.

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

## A credit note spent outside the app: global, then the member's credit ledger (#4219)

`convergeCreditNoteSpentOutsideApp` releases a booking's applied credit and writes
the funding lot down. Releasing applied credit changes what the booking owes, so
it is a settlement-money writer: it takes the global key (`INV-LOCK-002`: global,
then the member's credit-ledger key) and excludes the cancel, capture and refund
writers that take the global key as well as the credit writers that take the
member's. It re-reads the slice, the lot and the write-downs, and checks the
cancel-settled and deallocation-fence preconditions, under both keys. The Xero
read that confirmed the signal, and the allocations and payments it listed, happened
before the transaction, so no provider call is held inside it. That evidence can
go stale in the milliseconds between: if the treasurer reverses the outside spend
then, the routine writes down credit Xero has given back. The amount is capped by
the booking's slice, and the inbound mirror (#4270, below) is what
restores a reversed spend. There is no separate claim row: a repeat finds the
write-down already counted and writes nothing, and a concurrent run that lost the
race finds the booking converged or its slice already shrunk below what was refused. Registered in `advisory-lock-guard.test.ts`
(`convergeCreditNoteSpentOutsideApp#1`); proved against real PostgreSQL by
`credit-note-spent-outside-app.realdb.test.ts`.

## A credit note spent or un-spent in Xero: the member's credit ledger only (#4270)

`mirrorCreditNoteOutsideSpend` (`xero-credit-note-mirror.ts`) writes down the free
part of a funding lot Xero shows spent outside the app, and restores it when Xero
shows the spend undone. It adds one `ADMIN_ADJUSTMENT` row and one audit row; it
releases no booking's applied credit and moves no settlement money, so it takes the
**member's credit-ledger key and nothing else**, never the global key. That cannot
invert the converge's order (global, then member): a mirror and a converge on one
member serialise on the member key, and the converge's extra global key excludes only
the cancel, capture and refund writers the mirror does not conflict with.

| Step | Where |
| --- | --- |
| Xero read of the note | before the transaction (the webhook's own read, or the sweep's), no lock held |
| Member and lot chosen | before the transaction, from the note's single funding lot; more than one lot or member fails closed |
| `lockMemberCreditLedger(memberId)` | first statement of the transaction |
| Re-read under the lock | the lot, its slices, the net write-down, the balance, the outside spend, in-flight `APPLIED_CREDIT_ALLOCATION` or `APPLIED_CREDIT_DEALLOCATION` operations and the deallocation fence of every payment that holds a slice on the lot |
| Write | the row and its audit row, in the same transaction; none when nothing changes |

There is no claim row. The target is recomputed from Xero's list under the lock and
the rows are additive, so a second mirror (or a converge) that runs after the first
finds `delta = 0`; two that race queue on the member key and the second finds the
first's rows. `real-PostgreSQL` proof: `credit-note-outside-spend-mirror.realdb.test.ts`
(two mirrors, a mirror and a converge in both orders and at once, a credit writer
holding the member key, and a writer holding the global key that the mirror does not
wait for). It is imported into `concurrency-lock-races.realdb.test.ts`. The writers
that change a lot's free balance (the allocation engine's plan, a cancel's restore,
an admin adjustment) take the member key, so the mirror's free-credit and balance
reads under that key are exact.

## A request for released credit: the recovery claim, and one global-key close (#4253)

The card request for credit released by `convergeCreditNoteSpentOutsideApp` is
raised by the recovery runner (`credit-release-ask.ts`) under the same claim the
ordinary additional-ask replay holds (`holdAdditionalIntentRecoveryClaim`): the
Stripe intent is minted first, outside every lock, under a key that names the
release; the request's row, its audit row and the cancellation rows of the asks
it supersedes are written in one claimed transaction; the supersede cancels run
after it. It takes no advisory key of its own; since #4442 the claim hold it
shares takes the global key, then the `Payment` row, before the recovery row
(`lockAdditionalAskQueue`). A cancel that commits between the
runner's ended-booking read and its row write is caught by the second read
(`INV-ADDPAY-044`), which retires the request.

The Xero payment (`credit-release-xero-payment.ts`) is a sweep that writes no
local row except the `XeroObjectLink` the existing payment writer creates; it
holds no lock and reads Xero outside any transaction. A repeat is harmless
because the Xero idempotency key is stable, and the retry cap bounds the
operation rows a failing payment can create.

The backlog batch (`runCreditReleaseBacklog`) is the same enqueue with a ceiling, one more
read of two `XeroSyncCursor` rows and one audit write; it takes no lock and no claim, and a
release it has taken is never taken again because the enqueue keys on the release
(`INV-ADDPAY-050`). The row is inserted once (`createAdditionalPaymentIntentRecoveryOnce`,
`ON CONFLICT DO NOTHING`), and a pass counts and audits only the rows it inserted, so two
overlapping payment cycles (the cron leader and a manual run) can each take up to `perRun`
releases but never the same one, and never write two batch rows for one release. The reminder chase for these requests (`INV-ADDPAY-048`) changes only
the stamp boundary of the existing guarded claim in `cron-additional-payment-reminders.ts`
(the slot's start, or half an interval before now, whichever is earlier). The Xero invoice
read and the bank-transfer offer that decide whether a released-credit reminder goes
(`credit-release-reminder-gate.ts`, `INV-ADDPAY-051`) run before that claim and outside any
transaction, in the cron and in the manual re-send alike; a withheld reminder claims nothing,
and its one audit note is written outside any lock. A release waiting behind an unpaid edit
request goes back through the recovery runner's one failure write
(`markPaymentRecoveryOperationFailed`), fenced on the attempt its worker holds, with that
attempt handed back; it takes no lock and changes no money.

Closing a request Xero shows paid (`credit-release-ask-close.ts`) is a
settlement-money writer: it cancels the card payment at Stripe first, outside
any lock, and leaves a succeeded or processing intent alone. It then takes the
global key and the `Payment` row lock (`INV-LOCK-001`: the global key alone, then the row), fences the
request row (unpaid, unwithdrawn, and carrying exactly what it carried when it was read)
with a status-guarded `updateMany`, and writes the bank-cash row in the same transaction; a
lost fence writes nothing. A request that carried earlier ones is closed only when every row
it carried is a credit-release request (read before the provider call; carried rows never
change once carried, and the re-read requires the payment still to name this request as its
live ask, so nothing can have been folded in since). Registered in `advisory-lock-guard.test.ts`
(`closeCreditReleaseAsksPaidInXero#1`).

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

Each cancel path's restore runs under `lock(1)` (and its lodge lock, where it
takes one) and its status-guarded claim remains the *primary* single-flight (the
claim, not a description string, guarantees the surrounding side effects run
once); the unique key is the structural backstop underneath it. The orphan-heal
restore is the exception: it holds the member key only. Inside a transaction
`restoreCreditFromBooking` takes the **per-member credit ledger lock** itself,
before it reads the applied rows (#3792), so the order is global → lodge →
member at every caller, none takes `lock(1)` or a lodge lock after it, and a
caller already holding the member key re-enters it. That is what lets the
inbound repair below trust the restore row it reads: a restore in flight holds
the member key until it commits. **The member key comes before the `Payment`
row**, too: the inbound repair takes the member key and then updates
`creditAppliedCents`, so a caller that locked or wrote the `Payment` row first
and then waited for the key would deadlock against it (reproduced as `40P01`,
#3792). The four restore callers that touch the row (the paid cancel before
`lockPaymentForRefundedTotal`, the pending cancel before its `Payment` write,
the settle before its `Payment` upsert, and the inbound reconcile before its
receipt write) therefore take the member key explicitly, right after their
lodge key. The settle and the inbound reconcile read the owner that key names
**after** the lodge key, and their restore reuses that same id: member merge
re-points `Booking.memberId` holding the lodge key but not `lock(1)`, so an owner
read taken before the lodge key can name a member the booking no longer has,
and the restore would then take a second member key after the `Payment` row.
The caller set and both orders are pinned by
`bed-allocation-lock-topology-contract.test.ts`, and the interleaving is proved
against PostgreSQL in `ib-capacity-cancel-credit-restore.realdb.test.ts`. The Xero inbound applied-credit repair
(`xero-inbound/credit-note-repairs.ts`) takes the **per-member credit ledger
lock** (not `lock(1)`) so its `BOOKING_APPLIED` writes mutually exclude the
credit spend engine, which takes the same key. Under that lock it also reads the
booking's restore row: for a booking whose applied credit was already restored,
a provider allocation change in either direction (a de-allocation that would
credit the member, or a raise that would debit them) writes no `BOOKING_APPLIED`
row. After commit it is alerted (`notifyXeroSyncError`,
`applied-credit-restored-booking-allocation-change`) and recorded as a critical
`xero` audit row (`xero.allocation.restored-booking-change-refused`, one per
booking, note, direction and amount), because the email alert is throttled to
one an hour across every Xero error type. No cancel path's restore can be paid
twice or charged back (#3792, `INV-PAY-019`). The orphan-heal repair
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

## Closing a dead card refund as paid another way (#3372)

`closeCardRefundPaidAnotherWay` (`src/lib/card-refund-paid-another-way.ts`)
closes a card refund recovery row whose retries are spent, because the treasurer
paid the member back another way, and records the money with
`applyLocalRefundAllocation`. It is a settlement-money transition, so it takes
`lock(1)` first (`INV-LOCK-001`): it moves a payment's `refundedAmountCents`
and closes a refund debt in one commit, and every edit, acceptance, paid cancel
and refund appeal reads those two separately to size a refund net of what is
promised back. Under the key it re-reads the row, refuses a row that is not
dead (a status the worker would claim, with `attempts >= MAX`), and then takes
the **Payment row** (`lockPaymentForRefundedTotal`) BEFORE it reads the
payment (#3924 round 4, C1). Every refunded-total writer without `lock(1)` -
every Stripe refund recorder, and a cancellation hand-back's completion - takes
the Payment row first, so the owed figure the close checks the amount against
cannot change between that read and the allocation. A refund recorded while the
close waits for the row is read by the close, which then refuses an amount the
refund already covered. Under the row the close also compares what is owed with
the figure the treasurer chose against (`expectedOwedCents`, #3924 round 7,
C7) and refuses a moved one with a 409, so a full or part answer is never
applied to a figure nobody saw; the page refreshes and they choose again. The
order is `lock(1)`, then the Payment row, then the allocation, which takes the
row it already holds. The claim is a status-guarded
`updateMany` before any money moves; a lost claim writes nothing. The close's
hand-back task and ledger line are written in the same transaction. The worker
never claims a dead row, and the Xero note is an outbox row kicked after the
commit, so no provider call runs under the key. A late capture's refund also
takes the approval task's row (`lockKeptLateCaptureTask`, #3924 round 6) after
the Payment row and before it reads the capture's Xero receipt, because the
receipt's worker writes that receipt's link under the same row (the kept
late-capture task row, above). Order: `lock(1)`, the Payment row, the approval
task's row. Under that row the close also puts a receipt row that failed before
reaching Xero back from FAILED to PENDING, with a status-guarded `updateMany`
(#3924 round 7). An officer's retry or resolve takes no task row, so a claim
that matches nothing is re-read (round 8): a resolved or withdrawn row means the
plan no longer holds, and the close refuses with a 409 and commits nothing. A
FAILED row that may have reached Xero - its Stripe payment linked, or
`createInvoices` attempted (`keptReceiptMayHaveReachedXero`) - is never put
back to run, by the close or the repair tool; it waits for an officer. The
worker then queues a waiting close's note in a second
transaction under the same row (#3924 round 7, C9), so a note failure fails the
worker's row with the link standing and its retry runs only the note step,
which queues a close's note at most once. A change's supplementary invoice sent
for the capture runs the same note step after its row completes (round 8,
`queueWaitingPaidAnotherWayNote`), in a transaction of its own under the same
row, reading the receipt under it; a failure there is logged, never failing the
sent invoice, and the nightly credit check re-runs the step for any
payment whose closes' notes do not cover them (round 9), as the repair tool's
`QUEUE_PAID_ANOTHER_WAY_REFUND_NOTE` does (round 8): each queues a note never
queued, and neither retries a failed one. A row that may have reached Xero is
reported to the close as held for an officer, never as queued (round 9). None
of these transactions writes the Payment row: a paid-another-way note always
takes the refund-note enqueue's stepped path, which only reads it (C8), and is
sized by the close's record less its own notes (`readPaidAnotherWayCloseShare`,
round 8). A double click queues on the key and the second reads the row
closed; a refund recorded mid-close gives a 409
(`card-refund-paid-another-way.realdb.test.ts`). Registered as
`closeCardRefundPaidAnotherWay#1`.

A refund Stripe made before the close - the request whose answer was lost - can
still be recorded after it, by the `charge.refunded` sync. No lock can stop
that: the money already left Stripe. It is attributed by when Stripe made it, so
it stays the closed row's own, never an older open row's same-amount slice, and
the stuck-states page lists the close as paid twice (#3924 round 5,
`cardRefundSentAfterPaidAnotherWay`). Both ends of the close's window read
Stripe's clock, the raise floored to its second (round 7, M3).

**Marking a paid-twice row Resolved** (owner, 9 Oct 2026;
`resolveCardRefundPaidTwice`, `src/lib/card-refund-paid-twice.ts`) moves no
money and touches no Xero, so it joins no lock cohort. It is one
status-guarded `updateMany` on the close's record, guarded on the resolution
the record carried when read, with its audit row in the same transaction; a
second click or a second treasurer matches nothing and is refused with a 409
(`card-refund-paid-another-way.realdb.test.ts`). Nothing else writes that
column of a close's record. A Stripe refund recorded after the dialog opened is
not stopped by any lock either, so the request carries the card figure the
dialog showed (`expectedRefundedByCardCents`, round 8) and a different figure
is a 409: a refund the treasurer never saw is never marked resolved.

## A refused card refund's re-plan: fenced writes, no advisory key (#4083, #4096, #4103, #4144)

A card refund Stripe answers `failed` or `canceled` (`INV-PAY-128`) adds these
writes to a `PaymentRecoveryOperation`, all lock-free and each fenced in its
own `where`, because none moves booking status, capacity or a payment's
refunded total (`INV-LOCK-001`), and none runs inside a transaction with the
Stripe call:

- **The runner's re-plan** (`refundPlanOrRetryRefusals`) writes the plan
  (never the amount) only while the row is `PROCESSING` under the attempt's
  own `processingStartedAt` - the reaper's fence. A lost fence moves nothing; the
  next attempt reads the same refusal back and moves it then.
- **A pre-persisted door's re-plan** (`keepRefusedPrePersistedRefundOwed`:
  the cancellation, and since #4103 the edit financial review, the
  late-capture approval, the duplicate capture and the capacity race) writes
  only while its row is `PENDING` with `attempts` 0, so it never races a worker
  that has claimed the row; that worker reads the refusal and moves it itself.
  It reads the row's plan and writes compare-and-set on it, skipping a slice
  already moved, so two deliveries of one refusal move it, and alert, once.
- **The edit refund door** (`executeBookingModificationRefund`, #3984,
  `INV-PAY-146`) freezes its plan before Stripe, outside the edit transaction.
  After success or throw it queues the whole read plan if any slice is unmade:
  made slices marked, refusals moved, unanswered slices on their original key.
  The lockless `charge.refunded` recorder may update the ledger before recovery;
  the worker still sends the original slices and keys. Recording keeps the
  canonical Payment row lock; no advisory key, lock order, guarded transition
  or outbox participant changes (`INV-LOCK-001`, `INV-LOCK-002`, `INV-LOCK-003`).
- **The ledger refund enqueue** inserts if absent (`createMany`,
  `skipDuplicates`) and refreshes only a `PENDING` row, so a repeat enqueue
  never re-plans a row a worker has picked up. A fresh plan with no refusal in
  it never replaces one a refusal moved, and is written compare-and-set on the
  plan it read (#4103).
- **A pre-persisted door's happy-path close** (`closePrePersistedRefundRow`,
  `pre-persisted-refund-close.ts`, #4144) is a compare-and-set on the plan the
  door sent. The cancellation, the edit financial review, the duplicate
  capture and the capacity race close a row that is open and still on that
  plan (`sentPlanRowWhere`). A row the runner holds on the same plan is
  closed: its replay of the same keys is answered with the door's refunds, and
  only the close that moved the row writes a record - the duplicate capture's
  event, and the capacity race's and the member cancel's REFUNDED event
  (`closeRefundRowRecordingEvent`, close and event in one transaction, the
  runner's close the same way; #4125, #4145, `INV-PAY-134`) - so it is written
  once. A row another
  writer re-planned is not on that plan and is left open: one moved after a
  refusal, or after Stripe's later report that a refund failed, is still owed;
  one re-planned only by the runner marking a slice made is left to the
  runner, whose replay closes it without moving money. The window this shuts:
  the door's refund is made, the runner claims the row and its attempt fails,
  Stripe's later report that the refund failed re-plans it
  (`card-refund-failed-later.ts` writes only a tried row), and only then the
  door's close runs. The row's key is built once per door (`closeDoorRow`
  hands it to the close and to the read-back).
  The late-capture approval closes only a row still `PENDING` with `attempts`
  0 on the plan it sent (#4126, `untouchedPrePersistedRowWhere`, the
  compare-and-set it shares with the doors' refusal re-plan,
  `replanPrePersistedRow`), as its record is written by whichever close moves
  the row. Every door reads a lost close back (`reportLostPrePersistedClose`):
  closed, held or re-planned is logged and left to the runner; a row that is
  gone (nothing deletes one) is logged as an error; a row still `PENDING`
  with `attempts` 0 is an anomaly, logged and alerted to officers once for
  the row (`<door>-close-lost:<row id>`), naming the refund.
  A close that threw is logged and left to the runner's replay.
- **The worker's failure write** (`failPaymentRecoveryOperation`) is fenced on
  the attempt's `attempts` and a live claim, so an attempt the reaper gave up
  on cannot write `FAILED` over a reclaimed one. Not on the claim time: an
  attempt may re-stamp that itself (`holdAdditionalIntentRecoveryClaim`, the
  worker's own superseded hand-off). The reaper's write takes both fences, each
  its own clause. Every claim therefore counts an attempt: the worker's claim,
  and the superseded hand-off a succeeded-intent door makes
  (`queueSupersededPaymentIntentRefundRecovery`: the webhook, and since #4300
  `confirm-payment` and the pay step's and `/pay` link's reconcile arms,
  `INV-PAY-138`), which takes the row from outside any attempt and so spends
  one of its five. That check takes no advisory lock; the settle reads the
  same superseded-machinery reading again under `lock(1)` and refuses the
  capture there (`superseded_capture`), so an edit landing between the two is
  caught, and the saved-card doors meet the same refusal.

The legacy group settlement replay and the superseded group intent's webhook
refund carry no plan: each reads Stripe's refunds on the intent before it asks
(`keyAfterStripeRefusals`), outside any transaction, and moves its key past the
refusals there.

The "Paid another way" close above claims only `PENDING|FAILED` rows with
their attempts spent, so it never meets the runner's re-plan.

**Deploy window.** An older release still draining knows no refusal: its
worker closes a refused row as paid, and drops a slice's key generation, so it
replays the slice's first key and reads Stripe's cached refusal. Nothing is
refunded twice within Stripe's 24-hour key window; a row it closed is found by
a recorded `failed` or `canceled` refund with no later one, and checked against
the Stripe dashboard.

## Charge-backed refund recovery preflight (#4359)

`checkCardRefundResend` (`INV-PAY-145`) adds no advisory key or enclosing
transaction. Every provider read finishes before its refund recording begins.
Recording reuses `recordStripeRefundsAgainstTransaction`: Payment row, refund
rows, transaction rows, then any failed-later recovery writes. This is the
existing narrow Payment-row contention domain (`INV-LOCK-001`); no tier is
composed or reordered (`INV-LOCK-002`) and no Tier-2 site is added
(`INV-LOCK-003`). The subsequent Xero outbox enqueues run after that commit.

A dashboard hold uses the runner's existing terminal failure writer,
`markPaymentRecoveryOperationFailed`, fenced by live status, the claimed attempt
and a non-null processing start. A lost hold claim sends no refund, alert or
audit. The hold keeps the row's amount and writes no plan; the only plan write
is the preflight's own slice-evidence mark below, made before any hold. All
involved unsent charges are checked before any slice is sent. No new status or
refunded-total writer is introduced; specialised combined-group executors are
unchanged.

Once recorded evidence requires a hold, the check stops immediately. A read or
recording failure on a later charge cannot replace that hold with normal retry
backoff; the conclusive charge's refund ids remain in the hold audit.

The read cannot exclude a Stripe dashboard action made after it returns. Stripe
has no lock shared with the database, so holding a database transaction during
the call would not close that race. Mixed old/new workers retain the old
worker's behaviour; this protection applies only to attempts on the new code.

Slice evidence (#4510, `INV-PAY-147`) adds one writer and no key. Once a
charge's provider read and ledger write have finished, the preflight marks the
slices whose `refundSliceKey` it found in one compare-and-set of
`allocationPlan`, guarded on the stored plan as read (a later charge's on the
plan just written), `PROCESSING` and the runner's `processingStartedAt`. It
takes no lock; a lost write sends nothing and overwrites no mark. Across mixed
workers, a key an old worker sent without evidence is refused by Stripe for 24
hours when sent with it (`idempotency_error`). `refundPaymentTransactions` then
sends that key once more with the old body, which Stripe answers with the
original refund; a second refusal moves no money. Limit: past the key's 24-hour
expiry, a legacy refund that was never recorded carries no evidence to adopt,
and its slice can be refunded again.

Counterparts reconciled for this change: open #4472 and the ten latest merged
refund PRs #4495, #4490, #4437, #4424, #4419, #4327, #4341, #4307, #4228 and
#4235. Their Payment-row, global-before-Payment, refund-note and guarded-close
contracts remain intact. The preflight shares the existing webhook note router
rather than creating a competing note rule.

## A card refund that failed later: the Payment row lock, no advisory key (#4104)

A refund Stripe accepted (`pending`) and failed later (`INV-PAY-128`) is kept
owed inside the one writer of a charge's refund rows,
`recordStripeRefundsAgainstTransaction`, in the transaction that sees it fail.
That writer already takes the refunded-total order - the Payment row
(`lockPaymentForRefundedTotal`), then refund rows, then the transaction row -
and the debt's writes come last, on `PaymentRecoveryOperation`:

- **Exactly one writer sees the failure**: the guarded counted -> refused write
  (`recordStripeRefundLedgerEntry`), or a door told `pending` by a replayed key
  while the row already says refused. Two deliveries of one event queue on the
  Payment row; the second sees the row refused and writes nothing.
- **One row owes it.** The owner search reads every card refund row of the
  payment under that lock: a row of its own, or a slice that already records
  the failure (`failedRefundIds`), means another observer decided - nothing is
  written. Otherwise the open row that counted it (marked `madeRefundId`, or
  the unmarked slice the owed figure fills with it as the payment stood before
  the failure, when the refund carries exactly that row's runner metadata) is
  re-planned, and with none a row is inserted keyed on the Stripe refund
  (`card_refund_failed_later_<refund>`, `skipDuplicates`). A refund that names
  no booking writes an audit row on the same transaction instead.
- **A re-plan** is a compare-and-set on the plan, status, `attempts` and
  `nextRetryAt` it read (a claim or re-arm between moves one), never on a row
  someone may be writing: a worker mid-attempt (`PROCESSING`), or a row no
  worker has claimed yet (`PENDING`, no attempt - a door's inline attempt may
  still close or re-plan it). There, or when the plan moved since the read, a
  failure seen by its own counted -> refused write throws
  (`FailedLaterRefundHeldError`): the whole transaction - refund row and
  refunded total too - rolls back, and the webhook answers 500 or the cron
  reads it back again next run. A failure a door or worker meets replaying its
  own key is handed back to it as refused, and it moves its own row
  (`INV-PAY-128`'s refusal path).
- **A door that marks a slice made after the failure was handed to a row of
  its own** (the event between the door's record and its plan write) leaves a
  marked slice whose refund is refused: the owed figure reads it filled by the
  failed-later row, and the runner never sends a marked slice, so it is owed once.
- **A "Paid another way" close on a row that may have made the refund**
  (#4210, `INV-PAY-142`) is read on the writer's client after that lock,
  before the new row is inserted: a completed close record keyed on any such
  row (`cardRefundPaidAnotherWayClosesWhere`). The close takes `lock(1)`, then
  the same Payment row, and writes its record and its claim there, so the two
  serialise on the row: a close that committed first is seen and the new row
  is raised held (attempts spent, never claimed). Where the open row that
  counted the refund exists, a failure that committed first re-planned it, and
  the close against the figure it read is refused (409). Where the dead row
  that sent the refund does not count it, a failure first raises a live row
  and the close still goes through: the gap #4492 tracks. A read only - no new
  key, no new order.

**The cancel card refund shortfall's completion** (`cardShortfallSettlement`,
#4097) reads these rows under the same Payment row lock beside the cancel's
own: a failed-later row still unsettled refuses the completion (409), as the
cancel's own row would.

No advisory key: it moves no booking status or capacity, and every other writer
of that row takes the Payment row before it - "Paid another way" (`lock(1)`,
then the Payment row, then its claim) - or touches only the row (the runner's
claim and re-plan), so Payment row -> operation row is no cycle. A reader that
sizes a refund net of promised card refunds (the edit review's cap,
`unfinishedCardRefundDebts`) reads the payment's refundable total before the
debts, so straddling this commit errs towards refusing.

**Refund appeal caps read under the Payment row (#4124).** A refund appeal's
ceiling nets the payment's open card refund debts (`INV-PAY-118`,
`refundAppealHandedBackParts`) beside its open hand-backs and late-cash credit,
then reads the payment. Two readers hold the money decision and take the
Payment row (`lockPaymentForRefundedTotal`) after `lock(1)` and BEFORE those
reads: the approval (`PUT /api/admin/refund-requests/[id]#1`) and the reopen
of a dismissed appeal task (`reopenManualRefundTask#1`, for that task only).
`lock(1)`, then the Payment row, is the order every holder of both already
takes (`INV-LOCK-002`; the paid cancel, "Paid another way", the organiser
child refund recorder), and no holder of the Payment row takes `lock(1)` after
it, so it closes no cycle. Under both, nothing that writes those figures can
commit between the reads: this writer, every other refunded-total writer and a
cancellation hand-back's completion hold the row; every other hand-back writer
and the late-cash mint hold `lock(1)`. Re-taking the row later in the same
transaction (the approval's allocation) waits on nothing. The member's request,
the review screen and the booking page read the same figure unlocked, as advice. The provider calls - the
webhook's own Stripe payload, and the cron's read-back
(`reconcilePendingCardRefunds`) - run outside the transaction, and the officers'
alert after its commit.

**Stated limit: a failure seen before the refund was ever recorded** (delta
review B-2). `recordRefusedCardRefund` writes a refund it has never seen as
refused, and owes nothing for it: the door that asked for it, told `pending`,
then reads the row refused and keeps its own debt (`INV-PAY-128`'s refusal
path). A first-seen failure cannot tell that door, merely slower than the
webhook, from one that crashed between Stripe and its record; owing it there
would owe it twice whenever the door lives. So a door with no row persisted
before its call that crashes there, its refund then failing, leaves no debt -
as the same crash before the call would. Its booking's state, not this event,
is what an officer reconciles.

**The deploy window** (delta review B-1): the previous release's runner claims
any due card refund row, and knows neither the failed-later key's Stripe reason
(`bookingModificationRefundReasonForKeyPrefix`) nor a slice's `failedRefundIds`
(`parseRefundAllocationPlan`). A failed-later row it claims is re-sent under
the old reason - so if that re-send fails later too it is asked for once more,
not raised dead - and a re-planned row's plan it rewrites loses the failed
refunds it recorded,
so a later "Paid another way" close reads no card-note cover and Xero is
credited twice (listed as over-coverage). Subscribing to `refund.failed` only
once the new release alone serves keeps that event's rows out of the window;
it does not close it, because the new release raises a row from any refund
status it reads - `charge.refunded`, the cron's read-back, a door's replay
(`DEPLOYMENT.md`). In the same window an old release's "Resolved" on a
paid-twice task writes that close record's `reviewContext` whole, dropping the
card-note cover a new close kept there, and an old release's card-note
executor does not subtract the closes' uncovered cash. Either way Xero's total
can drift from the refunds by that close's amount; the Xero reconciliation
report lists the difference for the treasurer to correct.

**Stated limits: the close's card-note cover and the card note's sizing**
(delta review 2). The cover is what the failed refund's card note answered when
the close was planned, kept on the record. It is not re-read: if an officer
later voids or reduces that note in Xero, the close still counts it as covered,
and the reconciliation report shows the gap rather than any note filling it. A
card note the outbox is already *sending* while the close plans is not yet a
link, so the close notes its full share too and Xero is credited twice for that
refund; the report lists it as over-coverage. The card note sizes itself from
two unlocked reads (eligible cash and the closes' uncovered cash) and re-reads
the closes' figure either side of the cash until both agree, so a close that
commits between them is counted on both sides or neither.

## An edit against the primary invoice's link: the Payment row lock, no advisory key (#3980)

An edit decides whether to adjust a booking's primary Xero invoice from the
invoice link it read, but the invoice create (`createXeroInvoiceForBooking`)
reads the booking once, calls Xero, and saves the link seconds later, outside
every lock. The two are ordered on the **Payment row** alone (`INV-PAY-136`):

- **The claim.** Every writer that changes a booking's worth and read no
  invoice link makes one guarded write in its own transaction,
  `writeEditOnPayment` (`src/lib/booking-primary-invoice-claim.ts`):
  `payment.updateMany where {id, xeroInvoiceId: null}`, carrying the fee
  increment the edit records (else an increment of 0). `applyPaymentAdjustments`
  makes it for the date, batch, guest-removal and acceptance doors (and the
  finished-stay correction through the batch door); the guests route, the
  review price re-base (`booking-review-price-rebase.ts`) and the school
  pending-adult naming (`school-pending-adult-resolution.ts`) make it
  themselves; the re-base claims against the review closure's own read of the
  link (`paymentLinkRead`), so a link saved between the two reads refuses the
  closure. A count other than 1 refuses the whole change with a 409 and it
  rolls back. The credit election changes no price and makes none.
- **The link's save.** `persistPrimaryInvoiceLink` writes the link with an
  `updateMany` guarded on it being unset, then reads the fee and the booking's
  `finalPriceCents` in later statements of the same transaction, then writes
  its figures onto its own operation row. Finding the link already set, it
  reads the row: the same invoice is a second save (a stale-RUNNING reset
  retried, or two runs at once) and stores nothing, so the first save's figures
  stand and the create re-checks from them; a different invoice is overwritten
  and measured, as before.
- **Why it holds.** Whichever writes the Payment row second waits for the
  other's commit and then sees it. A claim made first has committed every
  booking write with it, so the save's later read of the booking holds it; a
  claim made second re-evaluates its `xeroInvoiceId: null` predicate after the
  wait (Read Committed), matches nothing, and is refused. Two saves of one
  invoice serialise the same way, and the second finds the link set. An edit
  that committed before the create's read is in the invoice's lines; the
  create's read is one REPEATABLE READ snapshot (`xero-primary-invoice-read.ts`),
  so an edit committing between its statements is in all of them or none.

**Order.** The edit doors already take global `lock(1)`, then
`acquireLodgeCapacityLock`, then any member keys, and write the Payment row
inside that (`INV-LOCK-002`); the claim is one more Payment-row write in that
position, as it is for the re-base and the school naming under their own keys.
The link's save takes no advisory key and no lock after the Payment row but its
own operation row, which no edit writes, so there is no cycle. No new advisory
key, no raw row lock and no migration: it is an ordinary status-guarded
`updateMany`, like the finished-stay fee write it generalises
(`recordFinishedStayFeeOwed`, #3955), which still runs and now always matches
behind the claim. A long edit holding the Payment row can make the link's save
wait past its transaction budget; the create then fails and its retry replays
Xero's idempotency key, gets the same invoice back and saves the link.

**The other link writers.** Five more writes set `Payment.xeroInvoiceId`, and
each takes the same row, so a claim queued behind one finds the link and is
refused: the inbound "invoice paid" match (guarded on an unset link) and its
settle (`xero-inbound/invoice-paid-effects.ts`, an unguarded update under
`lock(1)`), the inbound payment's canonical link (`xero-inbound/payment.ts`,
where none is set), the reconcile mirror of a primary transaction's invoice
(`payment-transactions.ts`) and an operator's field repair
(`xero-booking-repair-passes.ts`). None stores figures, so an edit that claimed
just before one of them is not measured, like any invoice linked without stored
figures. The census `primary-invoice-claim-call-sites.test.ts` lists every
write that sets the link and every writer that claims.

**Not covered.** A change on a booking with no Payment row has nothing to
claim. The create needs a Payment row to run, and such an edit is still marked,
so one that commits before the link is in the worth read back.

Proved against PostgreSQL in `primary-invoice-edit-race.realdb.test.ts`: the
create held between its read and its link save while a price increase and a
reduction commit (gap invoice, treasurer task); an edit paused right after its
claim, with the create's real link save seen queued behind it (by
`pg_blocking_pids`) and, once the edit commits, reading its worth back; and an
edit queued behind a held link save, refused.

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

## Refund-note link heal (#4161)

The nightly `link-cleanup` (`cleanupStaleCanonicalXeroObjectLinks`,
`xero-hardening-canonical-links.ts`) heals two shapes of refund-note mirror
whose recorded Xero status is VOIDED or DELETED: an active one (#4161), and an
inactive one its own payment's `xeroRefundCreditNoteId` still names (#4192).
It writes only `XeroObjectLink.active` and that pointer: no money column, no
booking status, no provider call. Under `INV-LOCK-001` it joins no advisory
cohort and takes no advisory key, so `INV-LOCK-003`'s Tier-2 registry has no
entry for it; its row lock is in the advisory-lock guard's row-lock inventory.

Each heal is its own short transaction. It locks the link row
(`SELECT 1 … FOR UPDATE NOWAIT`), then the Payment row
(`SELECT 1 … FOR NO KEY UPDATE NOWAIT`, the strength the pointer's own UPDATE
takes), and re-reads both under the locks. It writes nothing unless the link
is still the mirror the scan saw and, for the inactive shape, the pointer still
names it. It then calls `upsertXeroObjectLink` with that client, which writes
the link and then the payment it already holds: link, then Payment, the order
of the #2901 repair apply and of the funnel's own pointer release (#4046).

**The accepted inversion, and why it cannot deadlock.** Two writers take the
same two rows Payment first, inside their own transactions:

- the refund-note create's record (`createXeroCreditNote`): the pointer, then
  the link write, whose single-canonical rule updates the payment's other
  active links;
- the outbox enqueue's existing-note branch
  (`enqueueXeroRefundCreditNoteOperation`, "already linked"): the pointer,
  then the link write, inside the caller's transaction (a group cancel or an
  edit review's refund leg).

The heal never waits on Payment while it holds the link: `NOWAIT` turns a held
Payment row into SQLSTATE 55P03 at once (`isPostgresLockNotAvailable`), the
transaction rolls back having written nothing, and the heal is reported as
deferred for the next nightly run. The link row is taken `NOWAIT` as well, so
a writer holding it (an enqueue inside a long group cancel) defers the heal
rather than expiring its transaction. The heal waits on no lock at all, so it
can never be one side of a deadlock cycle and never rolls back the other
writer. A real-PostgreSQL proof
(`xero-refund-note-void-pointer.realdb.test.ts`) holds the Payment row on
another connection and shows the heal deferring at once and healing on the
next run. Separately, the heal also defers while the payment has a
credit-note operation that could still mint (the #2901 repair's refusal,
`findBlockingRefundCreditNoteOperationId`), so a create's later record never
finds the mirror half-healed. The writers' order is kept rather than
reordered: the create's one-transaction record is `INV-PAY-111`'s, and the
enqueue joins its caller's transaction. An inbound void racing a create's
record on one payment can take the same two rows in the opposite order; that
predates #4161 and is not changed here.

## Retiring a deleted Xero payment's link (#4531)

The inbound invoice and credit-note reconcile retires a `PAYMENT` link once Xero
confirms its payment DELETED (`retireDeletedXeroPaymentLink`,
`xero-inbound/deleted-payment-links.ts`, `INV-INT-031`). The scheduled re-check
`recheckPendingDeletedPaymentLinks` (run by the inbound cron cycle) and the
operator backfill `applyDeletedPaymentLinkBackfill` use the same write. So do
the marker writes on a candidate Xero could not judge (mark, count a failed
answer, clear on live). They write only `XeroObjectLink.active` and that link's
metadata: no money column, no booking status, no pointer. Under `INV-LOCK-001` it joins no advisory cohort and
takes no advisory key (`INV-LOCK-002`, `INV-LOCK-003` unchanged), and it takes
no explicit row lock.

- **Provider call outside any transaction.** The reconcile is not wrapped in a
  transaction (its callers: the stored-event worker under the event's
  status claim, the incremental cursor, "Sync now", the bank-refund void
  answer, and "Resolve by hand" on a Xero operation, which reconciles the
  credit note it names). The confirming `GET /Payments/{id}` runs between its
  short link writes, never inside one (`INV-INT-003`). It is one attempt: it
  never sleeps on a rate limit and never arms the process-wide outage breaker
  (`DEFERRABLE_XERO_READ`).
- **The claim.** One statement per link:
  `updateMany where { id, xeroObjectType: "PAYMENT", active: true, metadata = <as read> }`.
  A concurrent writer that changed the metadata, or retired it first, makes
  the count 0. The retire then re-reads and tries once more over the fresh
  metadata, or stops if the link is already inactive. It never overwrites a
  field it did not read. DELETED is terminal in Xero, so retiring over a
  newer reading is always right.
- **No counterpart deadlock.** It holds one row lock for one statement and
  waits on nothing else. The link funnel's canonical rules
  (`deactivateOtherCanonicalLinksWithClient`, the `REFUND_PAYMENT`
  single-active rule) run only for a write that leaves its link active, so the
  retire never retires a sibling.
- **Stated limit.** A reconcile holding a payload read before the deletion can
  upsert the link live after the retire, because the funnel takes no row lock
  first. The link is then a candidate again on the next read of the document,
  and the backfill finds it.
- **Counterpart readers, and the hold-back that protects them.** Writers that
  skip re-sending a payment while an active link records it: the booking
  change's card receipt (`recordAdditionalCaptureReceipt`), the primary
  invoice's PARTIAL payment repair (`recordedRepairPayment`) and the kept late
  capture's invoice, each on the link's own record. Two more read across
  records on one booking: a receipt refuses while a supplementary invoice's
  payment link is active (`bookingHasPaidUnnamedSupplementary`), and a
  supplementary invoice reads the receipts' links (`anchorCaptureHasReceipt`).
  Their payment is made by a separate operation that writes the link before
  the parent completes, so a parent whose completion failed retries with the
  link in place. The retire therefore never runs while an operation matching
  `rerunnableOperationWhere` (live, or FAILED/PARTIAL and still `replayable`,
  with `manuallyResolvedAt: null`) sits on the link's own record, or, for a
  supplementary payment link or a receipt's link, among the booking's open
  receipts or supplementary invoices (`findRerunnableOperation`). It is asked
  immediately before each guarded `updateMany`, not under a lock or in one
  transaction with it, and no writer can invalidate the answer in between. An
  operation leaves the set only by finishing, which merely holds back more
  than needed. It never re-enters (a recorded outcome is final, `INV-INT-029`;
  a retry claim moves FAILED or PARTIAL to RUNNING, inside the set), and a new
  operation never holds this payment's link. A held link stays active and
  marked, and the scheduled re-check retires it once the operation is done.
  The readers are unchanged.
- **The re-check's slot.** `recheckPendingDeletedPaymentLinks` claims its run
  before any call: it creates the `DELETED_PAYMENT_RECHECK` cursor row once (a
  lost unique race reads as "claimed elsewhere"), or moves
  `lastSuccessfulSyncAt` forward in one `updateMany` guarded on it being six
  hours old. So the cron and every webhook's kick, which run the cycle without
  single-flight, spend the cap once per interval.

Reconciled against the last ten merges touching `src/lib/xero-inbound`
(#4543, #4555, #4539, #4437, #4443, #4339, #4341, #4228, #4289, #4231). None
writes a `PAYMENT` link's `active` flag or reads one this retire changes.

## Voided bank-transfer refund note follow-up (#4162)

`followUpVoidedBankRefundNote` (`src/lib/bank-refund-void-follow-up.ts`, owner
decision 17 Oct 2026, `INV-ADDPAY-042`) undoes a bank refund whose Xero credit
note was voided: it takes the amount out of the payment's transactions
(`unwindLocalRefundAllocation`), reverses the hand-back's `BANK_REFUND` line,
recomputes the refunded total (`reconcilePaymentAggregates`) and raises one open
follow-up hand-back, in one commit. That is settlement money and an open
hand-back that every edit, acceptance, paid cancel and refund appeal reads
separately to size a refund, so it is a global-cohort writer (`INV-LOCK-001`).
Each voided note is its own short transaction, in this order (`INV-LOCK-002`):

1. `lock(1)`, the transaction's first lock;
2. the `Payment` row (`lockPaymentForRefundedTotal`) BEFORE anything about the
   payment is read - the #4217 order: every refunded-total writer without
   `lock(1)` (every Stripe refund recorder, a cancellation hand-back's
   completion, the rebuild) takes that row first;
3. the note re-classified under both (`classifyVoidedBankRefundNote`);
4. the claim: the follow-up's unique occurrence key
   (`bank-refund-void:<paymentId>:<creditNoteId>`, `createMany` with
   `skipDuplicates`), inserted before any money moves. A lost claim moves
   nothing;
5. the unwind's `PaymentTransaction` rows (re-taking the `Payment` row it
   holds), the reversal line, the rebuild (re-taking it again), the audit row.

A spare note writes only a marker on its link. The link row is taken last,
after the `Payment` row, with `FOR UPDATE NOWAIT`: the inbound sync's link
write and #4161's heal take the link before the `Payment` row, so the follow-up
never waits on a link while holding the `Payment` row - a busy link raises
55P03, the transaction rolls back having written nothing, and the note is
tried again the next night. No new cycle against the #4217 order (`lock(1)`,
lodge, member, `Payment`, rows): the follow-up takes no lodge or member key,
and every row it touches comes after the `Payment` row.

Counterparts:

- **#4161's heal** runs first in the same 02:25 slot. It takes the link and the
  `Payment` row `NOWAIT`, so while a follow-up holds the `Payment` row it
  defers; a mirror still active is left for the next night ("awaiting heal").
- **The inbound recount** (`repairRefundedPaymentBusinessState`) takes no lock:
  its compare-and-set on the row as read loses to the follow-up's write and
  recounts, and its floor (`INV-ADDPAY-021`) never takes a bank-transfer total
  below the detail the follow-up left.
- **A refund-note create in flight** (`findBlockingRefundCreditNoteOperationId`)
  defers the note: that create's coverage is not known yet.
- **A second run** queues on `lock(1)` and re-classifies the note as handled;
  without the lock, the unique key would still refuse its insert.
- **The follow-up's completion** (`resolveManualRefundTask`) takes `lock(1)`,
  because the follow-up is a non-cancellation hand-back, then the `Payment`
  row through its allocation. The "already in Xero" answer reads Xero before
  that transaction opens, so no provider call runs under either lock. After
  the commit, and outside any lock, the hand-made note is read again
  (`reconcileHandMadeNoteAfterCompletion`, through the inbound
  `reconcileXeroCreditNote`), so a later void is caught. A void that commits
  before the completion's link write is kept under the link's row lock and the
  answer is refused with a 409, rolling the completion back (#4288). Under the
  same locks the answer also reads, plainly, the credit-note creates naming the
  note, and refuses it when any is resolved by hand or not yet SUCCEEDED
  (#4321). A resolve of a row that already names its note takes none of these
  locks, so the condition is one it cannot flip: the route moves only
  FAILED/PARTIAL rows to resolved, and a SUCCEEDED row is never resolved. A
  resolve committing after the read therefore finds the answer already refused,
  never one note recording two refunds. Proven against real PostgreSQL with
  that resolve committing while the completion holds its locks
  (`own-live-refund-note-coverage.realdb.test.ts`). A resolve that RECORDS the
  officer's hand-made note on a row naming none (#4421) is a writer of the same
  fact, through the same link writer, so it takes `lock(1)` and then the
  `Payment` row: see "Resolve by hand records the refund note" below. No new
  advisory key.

**A person's pick** (`pickRefundForUnmatchedVoid`, owner decision 18 Oct 2026)
runs the very same undo (`undoUnderLocks`) for an unmatched note: the same
`lock(1)` and `Payment` row (`lockAndClassify`, the one place every writer here
takes them), the same rows. Its claim is the note-and-line key
(`bank-refund-void:<paymentId>:<creditNoteId>:<lineId>`), so a note that
recorded several refunds takes one pick per refund. Under the locks it
re-checks that the note is still unmatched and that the picked line is a live
`BANK_REFUND` hand-back line of THIS payment, that no live note of its own
task records even in part, no larger than what is left of the note's amount, and whose
refund the detail still holds (`resolvePickedUndo`). The pick that leaves
nothing to pick then writes the `picked` marker on the link row, last and
`NOWAIT`, as a spare's marker is written. `markUnmatchedBankRefundVoidAnswered` (a card
refund's record, nothing to pick) moves no money but joins the same cohort and
order, then writes its marker on the link row `NOWAIT`. Both are refused while
the follow-up is report-only. The nightly run classifies each note unlocked
first and takes the locks only for a spare or an undo, so handled and
unmatched notes never take `lock(1)`. One registered site,
`lockAndClassify#1`; the link row lock is in the row-lock inventory.

Proved by `bank-refund-void-follow-up.realdb.test.ts`: two runs; a concurrent
reconcile; the inbound recount forced to read, wait for the undo's commit and
resume - its claim lost, it recounts, and the total ends equal to the detail
(the `INV-ADDPAY-021` floor is what keeps it there); the heal deferring; a
create in flight; the link row held by another transaction (a spare defers
with no marker, an answer is refused as busy); a pick, two picks on one note
that recorded two refunds (both undone, then a third refused), and picks of
another payment's line, a reversed one, one larger than what is left or one
its own live note records in full or in part refused. The order is pinned by
`bank-refund-void-follow-up.test.ts`.

## Resolve by hand records the refund note: `lock(1)`, then the Payment row (#4421)

`claimResolveRecordingRefundNote` (`src/lib/xero-resolve-refund-note.ts`, owner
decision 26 Oct 2026, `INV-INT-028`) is the one writer behind "Resolve by hand"
on a FAILED payment refund-note create that names no note of its own: it writes
the officer's mark, the id and number of the Xero credit note the officer made,
and the payment's tracked per-refund `REFUND_CREDIT_NOTE` link for it. Which
note records which refund is the fact the #4162 hand-made answer
(`recordHandMadeRefundNoteLink`, inside `resolveManualRefundTask`) also writes,
for any payment, through the same link writer (`writeHandMadeRefundNoteLink`),
so the two must exclude each other: both read "does any create row or link here
record this note?" and then record it, and two such writers interleaved would
each read "no" and one $200 note would record $400 of refunds. No per-payment
row covers the race (the two refunds can sit on different payments) and a
per-note key would be a new advisory key, so the writer joins the global cohort
(`INV-LOCK-001`): the completion already holds `lock(1)` for its whole
transaction for a follow-up, a non-cancellation hand-back.

The order is the #4162 follow-up's, all in one short transaction:

1. the Xero check (`verifyHandMadeRefundNote`) runs BEFORE the transaction
   opens, so no provider call is held under a lock;
2. `lock(1)`, the transaction's first lock;
3. the `Payment` row (`lockPaymentForRefundedTotal`) BEFORE anything about the
   payment is read - the #4217 order every refunded-total writer keeps;
4. the row re-read: still a refund-note create naming no note, unresolved,
   FAILED, its amount still the note's;
5. no run already raised the row's note, at any time
   (`findSupersedingRefundNoteRun`: its retry, or a create on the payment with
   the same correlation key, SUCCEEDED or PARTIAL) - asked first, as the most
   specific answer;
6. no retry of the row ran since the route read it (`findRetryRunningOrSince`:
   RUNNING, or started or completed at or after the read). A FAILED refund
   note's retry runs on its own REQUEUE row and never claims the original, so
   one that started and finished while the route checked Xero and waited for
   the lock would otherwise raise its own note beside the officer's, and the
   post-commit `findRetryOverlappingMark` cannot see it (not RUNNING, started
   after the read). Clock skew between the route's and the drain's instances
   is the one window left. The mark's instant is taken here, after the lock;
7. no live copy of it is queued (`findQueuedLiveCopy`, re-asked here because a self-heal can queue
   one between the route's check and the claim; a fresh note under a
   different key is not a copy and is the claim's stated limit);
8. the note's records read, one read after the other on the transaction
   (#1357): any other credit-note create row
   (`creditNoteCreateRowsRecordingWhere`, the spelling the answer's guard uses)
   or any `XeroObjectLink`, except the link this row wrote and a withdrawal
   retired - either refuses with a 409, and the transaction rolls back having
   written nothing;
9. the status-guarded claim (`updateMany`: FAILED, `manuallyResolvedAt` null,
   `xeroObjectId` null) writing the mark and the note together. A lost claim
   writes nothing and the route answers as for any lost resolve;
10. the link row last, through the link funnel (`writeHandMadeRefundNoteLink`),
   which keeps a void or newer reading that committed first under the link's
   row lock (#4288) and then refuses, rolling the claim back. The inbound link
   write and #4161's heal take only the link row (the heal's Payment row
   `NOWAIT`), so taking it after the Payment row adds no cycle.

Of a resolve and an answer offering the same note, whichever takes `lock(1)`
second reads the first's commit and refuses; a second resolve offering it
queues the same way. After the commit the route's existing running-retry check
runs (`findRetryOverlappingMark`); a mark it withdraws
(`withdrawResolveRecordingRefundNote`) takes the note and the link with it, in
the claim's own order - `lock(1)`, the `Payment` row, the row's `updateMany`
guarded on that mark and that note, the link retired last - audited. A
withdrawal that throws (its 30 s transaction waits on `lock(1)` and the Payment
row) leaves the mark and the live link while the retry may raise its own note,
so the route raises a `refund-ledger-divergence` alert naming the operation and
the note, audits it and tells the officer. Then the note is read
from Xero once more, outside any lock (`reconcileHandMadeNoteAfterRecording`).
Every other resolve - a row naming its note, a refund request's note, any other
entity - takes no lock, as before. Two registered sites,
`claimResolveRecordingRefundNote#1` and `withdrawResolveRecordingRefundNote#1`;
no new row-lock site (the Payment row and link row are taken by their existing
helpers). Proven against real PostgreSQL by
`resolve-records-refund-note.realdb.test.ts`: both orders in sequence, each
writer held inside its transaction past its check while the other is shown
queued on the advisory lock, ending with one record of the note; and the void
path - the inbound void of the recorded note retires its link, coverage drops to
$0 and the nightly follow-up undoes the refund and asks once.

## Refund-note link writes racing a void (#4195, #4223)

A refund note's mirror goes inactive when the inbound sync records it VOIDED
or DELETED (`INV-ADDPAY-041`): the payment's own notes (`REFUND_CREDIT_NOTE`,
its one canonical note among them) and a refund request's own note
(`REFUND_REQUEST_CREDIT_NOTE`, `INV-PAY-118`). A retry, completion or repair
that read the note as live before that void committed would otherwise write
the link back active. On the canonical role the retry's write fell back to the
note itself once the void had released the pointer, so it re-armed the mirror
(#4223, reproduced on a real database).

So every refund-note link write, either role, starts in
`keepStoredRefundNoteVoid` (`xero-refund-note-status.ts`, called from the link
normaliser in `upsertXeroObjectLink`): it first ensures an inactive row with
only the five natural-key fields (`createMany`, `skipDuplicates: true`), then
locks that row (`SELECT 1 … FOR UPDATE`, the #4161 heal's statement). The
unique key serialises concurrent first insertions: if the mirror was missing,
a competing inbound insert must commit or roll back before the status read.
An existing row is untouched by the reservation. The reservation, lock, read
and final link write share the caller's transaction; failure rolls them all
back, so no identity-only placeholder commits alone. Every write then re-reads
the row through Prisma under that lock and applies `judgeRefundNoteWrite`. A
write that names no Xero status keeps a stored VOIDED/DELETED: the link stays
inactive, the status and incoming metadata merge over the stored figures and
provenance, and no sibling is retired for it. A pointer naming it is released
if its Payment row is available without waiting; otherwise the inactive mirror
commits and the #4161 heal can release the pointer later. A write that names a
live status it read from Xero before the void committed (#4288: the inbound
reconcile, the Stripe status recorder, a hand-made note answer) keeps the
stored status, stamp and figures the same way; the canonical rule (active flag,
sibling retirement) still applies. Between two live readings, the one whose Xero
`UpdatedDateUTC` is older than the stored one's keeps the stored snapshot. A
write that names VOIDED/DELETED is applied. The ordering reads only the row
this lock already holds, so it adds no lock.

It writes no money column, no booking status and calls no provider; under
`INV-LOCK-001` it joins no advisory cohort and takes no advisory key, so
`INV-LOCK-003`'s Tier-2 registry has no entry for it, and its row lock is in
the advisory-lock guard's row-lock inventory. Where a caller holds an advisory
key (an enqueue inside a group cancel), the row lock comes after it, as the
protocol requires.

**Lock order.** Inside the link write, always: the link's own row, then any
active sibling note the single-canonical rule retires. A write keeping a stored
void (status-less, or an older live reading, #4288) then tries its Payment row with
`FOR NO KEY UPDATE SKIP LOCKED` before conditionally releasing the pointer;
it never waits on Payment. A Payment row the caller already holds is returned
and its pointer can be released in that transaction. Explicit-status inbound
voids retain their existing link-then-Payment order (#4200). Before #4223
the canonical branch retired siblings before it wrote its own row; the own-row lock now comes first on
every write, status or not, so two writers of one note always take the pair in
the same order. (A mixed order, the retry's own row first and an inbound live
write's siblings first, could deadlock two writers of one note that both
retire an active sibling.) The lock protects the same natural-key row the
final write updates. Two writers of two different notes on one
payment that each retire the other can still take that pair in opposite
orders; that needs two notes both acting as the payment's one note at once,
predates #4223, and is not changed here.

Counterparts:

- **The inbound void** holds its link row, then the Payment row when the
  pointer names that note. A waiting write re-reads after it commits.
- **The nightly heal (#4161)** takes the link row and the Payment row
  `NOWAIT`, then calls the same write, whose own-row lock it already holds. It
  never waits, so it is never one side of a cycle.
- **The Payment-first writers** (the create's record and the enqueue's
  existing-note branch, see "Refund-note link heal (#4161)" above) take the
  Payment row, then the link write. A kept void must never wait back on their
  Payment row. Three writers can otherwise cycle on one note: an inbound void
  holds the link with a null pointer, a real covered retry commits the pointer
  back and queues on the link, then a Payment-first enqueue reads the old live
  note and queues behind the retry. Once the inbound void commits, a blocking
  retry would hold the link and wait for the enqueue's Payment while that
  enqueue waits for its link (40P01). The retry's `SKIP LOCKED` removes that
  wait, preserving the inactive mirror even when pointer cleanup is deferred.
  The explicit inbound void's pre-existing inversion is tracked separately
  in #4200.

Two real-PostgreSQL proofs hold the void open on another connection and show
the waiting write queued behind it, then find the link inactive with its
status after both commit: `xero-refund-request-note-void.realdb.test.ts` for a
request's note, and `xero-canonical-refund-note-void-race.realdb.test.ts`
for the canonical note through the real `createXeroCreditNote` retry, with the
pointer released. The canonical suite also forces an inbound first insertion
of a missing mirror, for VOIDED and DELETED, and proves the caller's rollback
leaves neither the mirror nor its reservation. Its three-writer proof uses
the real retry, the shared Payment-row lock, and the actual
`enqueueXeroRefundCreditNoteOperation` existing-note branch: both statusless
writes finish, the note remains inactive and VOIDED, and the final pointer is
null. This schedule does not force which waiter acquires the link first after
the inbound commit. A separate busy-Payment case forces the nonblocking branch
and proves fresh metadata commits while the pointer stays put; the existing
nightly heal then selects that inactive shape and releases it.
`xero-refund-note-stale-live-status.realdb.test.ts` (#4288) holds a live
reading at a gate while the void commits, then releases it: for the
bank-transfer canonical note through the real inbound reconcile, a Stripe
per-delta note through the real status recorder, a per-refund note and a
refund request's note. Each ends inactive and VOIDED, the pointer null, and the
replacement sibling alone covering. It also queues a live reconcile on the
void's row lock, orders two live readings by `UpdatedDateUTC`, and has a stale
live write K finish while a Payment-first enqueue F holds the Payment: K never
waits on the Payment row F holds. The inbound recount reads the note's row after
the payment rows instead of remembering its link write's verdict. The suite
pins the schedule A's link write, then B's void and B's recount, then A's
recount: A counts the void and leaves the total B lowered.

A's claim alone cannot see a void that commits between A's reads and its
claim: the void's link write changes no Payment column the claim compares
unless the payment's pointer names the note. For a payment holding the note's
own refund-note row, A decides in one short transaction, inline in the recount:
the Payment row (`lockPaymentForRefundedTotal`, `FOR NO KEY UPDATE`), then a
plain re-read of that link row, then the as-read claim, or nothing when the row
no longer counts (one retry at most; a second fails the inbound event, which
is retried after its backoff, #4095). An
unchanged verdict also checks the payment as read under the lock. No provider
call runs in it, and it takes no other lock. Its budget is `{ maxWait: 10_000,
timeout: 30_000 }`, copied from `additional-payment-withdraw.ts`, because the
nightly bank-void follow-up holds the Payment row for up to 30s.

Lock order. The recount ran outside any transaction before #4288 and takes only
this row. The link writer holds the link row and tries the Payment pointer with
`SKIP LOCKED`, or waits for it on an explicit void (#4200). So when the pointer
names the note, the void's own link write waits on A's Payment lock while
holding the link row. The hand-made answer takes its Payment row, then the link.
This transaction takes the Payment row and only reads the link, never waiting
on a link row lock, so neither case is a cycle (`INV-LOCK-001`, `INV-LOCK-002`).
It takes no advisory key, so `INV-LOCK-003`'s registry gains no entry.

Every outcome is some serial order of A and the void. A void committing after
A's locked re-read is "A, then the void, then B". B's recount queues on A's
lock, or, with a pointer naming the note, the void's link write itself queues
there; either way B sees A's write. On a bank transfer B lowers the total back. On a card the
ledger is raise-only (`INV-ADDPAY-021`, #1353): A's raise stands, and B raises the
refund-ledger-divergence alert. The inbound void runs its own recount; the
Stripe status recorder runs none. The suite pins the void before A's locked
re-read (A writes nothing, bank and card), a row deactivated there, and the void
after it: per-refund (B's recount waits) and pointer-named canonical and card
(the void's link write waits). Each run asserts which statement is the waiter. A stale reading's
allocations and refund payments are skipped only where the row, in either
refund-note role, is VOIDED/DELETED when they are written.

**Mixed releases.** The own-row-first order is consistent within this release;
the old canonical writer takes siblings before its own row. Running both on
the same note with an active historical sibling can deadlock (40P01). The
[deploy and rollback boundary](xero/ARCHITECTURE.md#flow-2--inbound-reconciliation-webhooks--incremental-cursors)
therefore excludes old refund-note writers, including web/direct retries,
before new ones start. Nightly healing of old mirror state does not make the
two lock orders compatible.

## One Xero contact, one local home: the contact-home key (#3367)

**Audience: developer.** The rule this key enforces is `INV-INT-018`
([`invariants/integrations.md`](invariants/integrations.md)); this section is
the lock topology only.

### The invariant and why a key was needed

Since [#3366](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3366)
two columns can hold one Xero contact id: `Member.xeroContactId` and
`Organisation.xeroContactId`. Each is `@unique` within its own table, and **no
database constraint spans two tables that way**, so exclusivity has to be
enforced by the writers.

The enforcement is a read — "does the other table already claim this id?" — and
a read cannot see an uncommitted concurrent link. Neither record's own key helps:
the member writer holds a member key, the organisation writer holds an
organisation key, and they never collide. The invariant is a property of the
CONTACT, so the serialisation point has to be keyed on the contact. Same
reasoning that gave `lockBookingMemberNights` its own family.

### The keys

| Key | Minted in | Taken by |
| --- | --- | --- |
| `pg_advisory_xact_lock(hashtext('xero-contact-home:<contactId>'))` | `src/lib/xero-contact-home.ts` (`lockXeroContactHome`) | every contact-linking writer, measured by `xero-contact-linker-census.test.ts` |
| `pg_advisory_xact_lock(hashtext('xero-organisation-contact:<organisationId>'))` | `src/lib/organisation-xero-contacts.ts` | the organisation resolve only |

Both are domain-keyed `hashtext` locks in their own namespaces. Neither joins the
global lock(1) cohort and neither is a capacity key, so `INV-LOCK-001`'s tier
question is answered "neither tier": they serialise an identity claim, not a
status transition and not a bed.

### Acquisition order (`INV-LOCK-002`)

**Entity ADVISORY key first, then the contact-home key, and only then any
`Member` ROW lock.** Six SITES, seven writers — the bulk import contributes two,
one per member-create branch, and they take the key identically:

| Writer | Order |
| --- | --- |
| `findOrCreateXeroContact` phase 2 (`xero-contacts.ts`) | `hashtext(<memberId>)` → `xero-contact-home:<contactId>` → member row `FOR UPDATE` |
| `commitManualXeroContactLink` (`xero-manual-contact-link.ts`) | `xero-contact-home:<contactId>` → member `FOR UPDATE` fence |
| `findOrCreateXeroContactForOrganisation` phase 2 | `xero-organisation-contact:<organisationId>` → `xero-contact-home:<contactId>` → member row `UPDATE` (only when the transfer fires) |
| `POST /api/admin/xero/import-member-contact` | `xero-contact-home:<contactId>` → `Member` INSERT |
| `applyInboundMemberContactPatch` (`xero-contact-create-recovery.ts`, #2939) | `xero-contact-home:<contactId>` → member `FOR UPDATE` fence. The refusal runs only where the patch CLAIMS the link; a blank-field backfill onto the record that already holds the contact claims nothing |
| the bulk member import's two member creates (`xero-member-import.ts`, #2939) | `xero-contact-home:<contactId>` → `Member` INSERT → refusal inside the same transaction, so a contact an `Organisation` holds takes the new row down with it |

Because every participant reaches a `Member` row only with the contact-home key
already held, the wait graph has no cycle. The last two rows arrived with
[#2939](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2939), which
closed the two paths `INV-INT-019` had exempted; the bulk person-contact seeding
that issue built needs no row of its own, because it holds no transaction across
contacts — it calls `findOrCreateXeroContact` once per member, so the first row
above is taken and released once per member exactly as for a single invoice.
Only ONE contact key is ever taken per transaction, so the sorted-key discipline
the member families need does not apply here.

**That the table is COMPLETE is measured rather than remembered.**
`src/lib/__tests__/xero-contact-linker-census.test.ts` reads the tree from disk,
finds every site that writes a non-null `xeroContactId` onto a `Member` or an
`Organisation`, and fails when the set is not the declared one — so a seventh
site cannot be added without somebody being asked which of these orders it
takes. `createXeroContactForMember` needs no key at all, for the reason
`INV-INT-018` gives: a contact Xero minted a moment ago can have no other home.
Writers that only CLEAR the column — `takeXeroContactFromSchoolsOwnMember`'s
first half, member merge's Xero teardown, the deletion fence, the admin unlink —
are not linkers: an unlink cannot give a contact a second home.

#### The order this replaced, and the deadlock it described

Until [#3367](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3367)'s
review round, this section said "entity key first, contact-home key **last**,
always" and added that nothing else was acquired while the contact key was held.
Both halves were false, and together they described a cycle rather than
preventing one.

`takeXeroContactFromSchoolsOwnMember` clears the holder's `Member.xeroContactId`,
which is a `Member` ROW lock, and it does that **while holding the contact-home
key**. The member-side linkers took the row lock first and then waited for the
contact key. So:

- the organisation resolve holds `xero-contact-home:<c>` and waits for member
  row `m`;
- the member linker holds row `m` and waits for `xero-contact-home:<c>`.

Reachable on the pair the transfer's own docblock calls reachable on purpose: a
credit note on the school's earlier booking, against the new booking's invoice.
Postgres breaks it by aborting one transaction with `40P01`.

The fix is the order above — the contact-home key moved AHEAD of the member row
lock in both linkers — and restating the rule as one about row locks rather than
about "last", because "last" is what made a row lock look like it did not count.

### The one transfer runs under these same locks

A returning school's contact is held by the invented school member of an earlier
booking, and the organisation TAKES it rather than being refused (owner decision,
13 September 2026). That hand-over is three writes — clear `Member.xeroContactId`,
deactivate the member's `CONTACT` object link, write the audit row — plus an
`Organisation.xeroContactId` update, and **all four are statements in the same
phase-2 transaction, under both keys already held**. So they commit or roll back
together: a failure later leaves the member holding the contact, which is the
state it was already in, and the contact-home key held across the whole of it
means no concurrent linker can claim the id in the gap between the clear and the
set.

The four legs that establish the member is *this school's own* are read inside
that transaction too, never taken from the caller — `INV-INT-018` lists them.
The refusal then runs immediately after the transfer and is unchanged, so a
transfer that declines to fire can only ever produce a refusal.

### What is inside the transaction, and what is not

**No provider call, on any of the four paths.** The organisation resolve copies
`findOrCreateXeroContact`'s three-phase shape for exactly that reason (F7,
[#1355](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/1355)): every
Xero call — authentication, the search, the create and its retry sleeps — happens
in phase 1 outside any transaction, and phase 2 is a short locked transaction
doing local reads and one local write. Holding a lock across the provider call is
the failure that restructure removed and must not be reintroduced here.

Concurrent duplicate CREATES are prevented by the organisation-scoped Xero
idempotency key, not by the lock — the lock is only about which local record ends
up holding the resulting id.

### Counterpart writers, and the one that does not take it

Every writer of `Member.xeroContactId` and `Organisation.xeroContactId` was
enumerated for this change. Three take the key and the refusal. One does not:

- **`xero-member-import.ts`** links members onto pre-existing Xero contacts in
  bulk, walking mapped contact GROUPS. It is deliberately outside this protocol.
  A school's organisation contact reaches it only if an operator puts that contact
  into a membership group, bulk contact seeding is
  [#2939](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2939)'s
  subject, and the import's shape — many writes across one long pass — is not the
  short-transaction shape this key assumes. Stated rather than left to be found,
  and pinned by the reader census in
  `src/lib/__tests__/organisation-reader-contract.test.ts`.

### This is bounded

[#3369](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3369) removes
the invented school member, which is the other home. The overlap opens when
[#3367](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3367) first
links an organisation and closes there. When it does, both keys can go with it —
but not before, and not by assumption.

## The migration lock timeout (#3377)

Everything above is about locks the *application* takes. This is about the one a
**schema migration** takes, which is the most dangerous lock request this system
ever makes and for months had no bound on it at all.

### What the problem was

`ALTER TABLE` needs `ACCESS EXCLUSIVE`. If any transaction from the draining
colour still holds a conflicting lock on that table — a long report, an open
admin session, a stuck worker — the migration joins the lock queue. PostgreSQL's
lock queues are **ordered**, so from that moment every later reader of the table
queues behind the migration too, including reads that would otherwise have
succeeded instantly. The tables involved are the ones a member touches:
`Booking`, `Member`, `Payment`.

With no `lock_timeout` the setting resolves to `0`, which PostgreSQL reads as
*wait forever*. Nothing ended that state except an operator noticing.

Eighty rows of [`BLUE_GREEN_MIGRATION_SAFETY.tsv`](BLUE_GREEN_MIGRATION_SAFETY.tsv)
had been telling operators otherwise — "let the deploy guard stop on lock
timeout" — for months. A mitigation named in the artifact somebody reads before
a deploy is worse than no mitigation, because it stops them planning for the
case.

### What is set, and where

The `migrate` service in `docker-compose.yml` — the service whose `command` is
`prisma migrate deploy` — carries the bound as a libpq startup parameter on its
`DATABASE_URL`:

```
…/tacbookings?connection_limit=2&pool_timeout=10&options=-c%20lock_timeout%3D${MIGRATION_LOCK_TIMEOUT_MS:-5000}
```

`options` is applied at connect time, so the bound is in force for everything
that connects on **this** URL: the migration statements themselves, and the
`prisma migrate status` the deploy script runs after them. **It is set on the
service and not in the deploy script** because that is what reaches the
connection migrations are applied on, rather than only the one command the
script happens to call.

It does **not** cover the shadow replay inside `prisma migrate diff`, and an
earlier version of this passage said it did. That replay connects on
`SHADOW_DATABASE_URL`, which `validate_prisma_schema_matches_migrations` in
`scripts/run-production-blue-green-deploy.sh` builds without an `options`
parameter, and which `prisma.config.ts` wires straight through. Bounding it
would buy nothing: the shadow database is created empty for that one check and
dropped after it, so no other session is holding a lock on anything in it.

No application connection is touched: the web slots, the cron leader and every
`PrismaClient` in `src/` still connect with no `lock_timeout`, which is why the
member-merge helper above can still say `DEFAULT` resolves to `0`.

`scripts/run-production-blue-green-deploy.sh` refuses the deploy at step 3 —
before it pulls an image — if the option is not on the URL the migrate service
will actually receive, or if the value in force is `0` or at/over the ceiling
below.

It establishes that by running `docker compose config` and reading the
`migrate` service's resolved `DATABASE_URL` out of it, rather than by parsing
`docker-compose.yml`. That distinction is the whole of the guarantee. Compose
does not read only the tracked file: `COMPOSE_FILE` in the deployment host's
`.env` names an overlay as well, and a `docker-compose.override.yml` is merged
with no configuration at all — so an overlay can take the bound off without the
tracked file changing, and a check that reads the tracked file would report a
bound the container never receives. Asking Compose is what makes "the value
checked is the value the migrate container gets" true rather than aspirational.

`0` is the trap worth naming:
it is the natural way to write "turn this off", and PostgreSQL reads it as *wait
forever* rather than as *unset*, so the most obvious disabling gesture silently
restores the exact exposure the guard exists to remove.

### Why 5000 ms — both bounds

The value is measured rather than chosen, and both bounds are recorded so the
next person can re-measure instead of inheriting a number.

**Floor, measured.** The repository's complete migration history was applied to
an empty PostgreSQL 16 with `log_lock_waits = on` and `deadlock_timeout = 1ms`,
so the server logged every lock wait over a millisecond. It logged **none** —
371 migrations, about 27 seconds of wall time, zero waits. (The instrumentation
was proven live by the contended run below, which logged its wait at 1.102 ms.)
An uncontended deploy therefore pays nothing for this bound at any value above
about a millisecond; the floor is set by contention a healthy deploy should
survive, not by the migrations themselves.

That the measurement ran against an *empty* database does not weaken it, and the
reason is worth stating because it is the obvious objection. `lock_timeout`
bounds only the time a statement spends **waiting** for a lock, never the time it
spends holding one. A table rewrite on a club's real data takes longer to run,
and that is unaffected by this setting; what it does not do is take longer to
*acquire*, because acquisition time is a function of who else holds the lock and
of nothing else.

**Ceiling, 10 000 ms.** It comes from the web slots' own connection string:
`connection_limit=10&pool_timeout=10`. A reader blocked behind the migration
holds its pool connection for the whole wait — the same mechanism the pool note
in `docker-compose.yml` already records for advisory-lock waiters — so ten
blocked requests exhaust a slot's pool and every further request is refused with
Prisma `P2024` after `pool_timeout`. At 10 s or more this guard cannot fire
before the serving colour is returning errors to members, so it would be
decoration.

That ceiling has **one home, and it is `pool_timeout` itself**. Both things
that enforce it derive it rather than restating it:
`MIGRATION_LOCK_TIMEOUT_CEILING_MS` in
`src/lib/__tests__/helpers/migration-lock-timeout-config.ts` reads it out of
`docker-compose.yml`, and the deploy script reads it out of the same resolved
Compose model it reads the bound from, taking the lower of the two web colours
because a deploy does not get to choose which one is serving. So the highest
value the script will accept is one millisecond under it — today `9999` — and
raising `pool_timeout` moves both at once. It was briefly a hard-coded `9000`
in the script while the helper derived `10000`, which is two homes disagreeing
about the rule as well as the number.

**5000 ms** sits at half the ceiling and about 5000x the measured floor. It is
deliberately *tighter* than `MEMBER_MERGE_PARTICIPANT_LOCK_TIMEOUT_MS` (10 s),
this repository's only other `lock_timeout`: merge bounds a wait inside one admin
transaction, whereas a migration's `ACCESS EXCLUSIVE` wait queues every later
reader of the table, so the migration bound must be the tighter of the two.

### What a blocked migration actually does — measured

Against PostgreSQL 16 with Prisma 7.10, with a transaction holding `ACCESS SHARE`
on `Booking` and a pending `ALTER TABLE "Booking"`:

| | Without the option | With `lock_timeout=5000` |
| --- | --- | --- |
| `prisma db execute` running the same DDL | waited out the blocker (10.5 s) and succeeded | cancelled at exactly 5 000 ms |
| `prisma migrate deploy` | — | exit 1, Prisma `P3018`, SQLSTATE **`55P03`** |
| `_prisma_migrations` row | — | present, `finished_at` NULL, `applied_steps_count = 0` |

Nothing is half-applied. The next `migrate deploy` then refuses with **`P3009`**
until the operator runs `prisma migrate resolve --rolled-back <name>`, after
which a retry in a quieter window applies cleanly — measured end to end. The
operator's copy of that is
[`PRODUCTION_UPGRADE_RUNBOOK.md` 2.1a](PRODUCTION_UPGRADE_RUNBOOK.md#21a-step-1320-stopped-on-a-lock-timeout).

### What proves it stays true

- `src/lib/__tests__/migration-lock-timeout.realdb.test.ts` — real PostgreSQL:
  the bound is reported on a connection opened with the shipped option, a
  blocked `ALTER TABLE` is cancelled at it with `55P03`, the same statement
  **without** the option waits for the blocker and succeeds, and Prisma's schema
  engine threads the option rather than dropping it.
- `src/lib/__tests__/blue-green-ledger-named-controls.test.ts` — no ledger row
  may name a control the repository does not implement. It fails if the option
  is removed, if the default reaches `0` or the ceiling, or if the real-DB proof
  is unplugged from CI.

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

## Xero inbound cycle run claim (#4432)

Scheduled and whole-club manual inbound syncs share one database-held claim
through `runXeroCronTaskList` and
`withCronRunClaim("xero-inbound-reconcile", ...)`. The HTTP cron and standalone
mirror participate too. A competing caller reports “A sync is already running”
and performs no provider or domain work.

The claim is the session advisory key
`hashtext('cron-run-claim'), hashtext(jobName)`, acquired fail-fast on a dedicated
`pg.Client` connection, never borrowed from Prisma's pool. There is no open
transaction during provider work. Closing the dedicated connection in `finally`
releases the claim on success and failure; PostgreSQL also releases it when a
holder dies or the connection closes. TCP keepalive detects a lost peer. There
is no lease expiry that could admit a second live cycle. A connection error
fails the holder closed at the next task boundary and at completion.

This outer coordination key takes no domain tier (`INV-LOCK-001`), is acquired
before any existing writer runs, and is never taken from inside a domain
transaction (`INV-LOCK-002`). The existing writers' global → lodge → member
order is unchanged. The explicit session-key inventory in
`advisory-lock-guard.test.ts` registers this exception (`INV-LOCK-003`); domain
locks remain transaction-scoped. Real PostgreSQL tests exercise both scheduler
and manual entry points and a dead connection's recovery.

Drain the previous release's scheduler at rollout: old code cannot participate
in a claim added by this release. The additive migration leaves its reads and
writes compatible. Counterparts reconciled: #4539 (alert retry before inbound),
#4536 and #4443 (outcome ownership), #4505 (provider fakes), #4384 and #4406
(receipt routing), #4471 and #4372 (monotone outcomes), #4424 (note cover),
and #4501 (lane coordination only). No open Xero PR appeared in the pre-edit
public GitHub query. Scoped sync invokes the inbound handlers directly, without
advancing the club cursors or taking a whole-cycle claim.
