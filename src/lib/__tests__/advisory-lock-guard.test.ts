import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  blankLiterals,
  blankLiteralsWithSpans,
  type BlankedSpan,
} from "./support/strip-comments";

// #182 guard (process follow-up to upstream PR #1911 review finding H1): a
// capacity ADMISSION path must use the per-lodge lock, while global-cohort
// booking lifecycle and settlement/money transitions use the canonical global
// pg_advisory_xact_lock(1). A writer that does both takes global first, then
// per-lodge (#1881). This scan makes a disjoint-key regression a CI failure
// instead of an upstream review comment.
//
// The rule itself is written ONCE, as INV-LOCK-001 (which tier a writer takes),
// INV-LOCK-002 (acquisition order, and the single mint of the per-lodge key) and
// INV-LOCK-003 (every Tier-2 site is registered here) in
// docs/invariants/operations.md. This file does not restate it; it enforces it,
// and each registry entry below carries only what is specific to ONE site.
//
// 1. The canonical global lock(1) is kept in a reviewed PER-SITE registry
//    (#2722). A new call site must classify the writer using
//    docs/CONCURRENCY_AND_LOCKING.md: use lock(1) for booking-status/settlement
//    money, the per-lodge helper for capacity, and both in that order when the
//    writer composes them. Add the site with its own reason and PR lock-impact
//    evidence; a bare count told a builder nothing ("expected 3, got 4") and
//    coupled approval to which file happened to hold the call.
//
// 2. The per-lodge key is minted ONLY by acquireLodgeCapacityLock:
//    hashtextextended must not appear outside src/lib/lodge-capacity-lock.ts,
//    so an
//    ad-hoc reconstruction can never drift from the canonical key.
//
// Domain-keyed advisory locks (hashtext of a namespaced string) are
// unrestricted — they are deliberately distinct keyspaces.

const SRC_DIR = path.join(process.cwd(), "src");

/**
 * Which tier a raw advisory-lock statement takes, decided from the call itself.
 *
 * `GLOBAL` is the literal key `1` — the one Tier-2 key — in either the blocking
 * or the fail-fast form. `SCOPED` is a `hashtext`/`hashtextextended` key:
 * per-lodge, per-member, per-date, and the policy/singleton keyspaces.
 * `UNCLASSIFIED` is anything this scan cannot read, and it FAILS the census
 * rather than being counted as scoped — see `classifyLockArgument`.
 *
 * Deciding the tier from the CALL rather than from the registry is what makes
 * "a registered site quietly changed tier" a failure rather than a silent
 * re-approval.
 */
type LockTier = "GLOBAL" | "SCOPED" | "UNCLASSIFIED";

interface AdvisoryLockSite {
  /** Repository-relative path. Reported in failures; NOT part of the identity. */
  readonly rel: string;
  /** 1-based line. Reported in failures; NOT part of the identity. */
  readonly line: number;
  /** Nearest enclosing top-level declaration. */
  readonly symbol: string;
  /** 1-based index of this site among the advisory sites of that symbol. */
  readonly ordinal: number;
  readonly tier: LockTier;
  /** Preferred identity — see SITE IDENTITY below. */
  readonly key: string;
  /** Always-unique fallback identity, used where `key` is ambiguous. */
  readonly qualifiedKey: string;
}

/**
 * SITE IDENTITY, and why it survives a file split (the property #2688 needs).
 *
 * A site is identified by the SYMBOL that contains it plus an ordinal, never by
 * its file or its line:
 *
 *     performBookingCancellation#3
 *
 * A structural split moves a function to another module with its name and its
 * body intact, so that identity — and the reason attached to it — moves with the
 * code and needs no edit. A line number would not survive an inserted comment;
 * a per-file count does not survive the split at all, which is the whole reason
 * #2722 exists and why it lands before the bed-allocation split.
 *
 * Two shapes need more than the bare symbol, and both are handled by deriving a
 * key the scanner computes rather than by anything the registry asserts:
 *
 * - **App Router handlers** are named by the framework, so `POST` is not an
 *   identity at all — ten route files export one. Their key is the METHOD plus
 *   the route path, `POST /api/admin/bookings/[id]/exclusive-hold#1`. That is not
 *   a file-layout accident: the path IS the URL, so a handler cannot move file
 *   without changing behaviour, and re-registering it is then correct.
 * - **A colliding library symbol.** Two modules each keep a private
 *   `acquireGlobalBookingLock`, so `acquireGlobalBookingLock#1` names two sites.
 *   Those entries use the file-qualified form
 *   `src/lib/booking-exception-execution.ts::acquireGlobalBookingLock#1`, and the
 *   guard REFUSES an ambiguous entry rather than silently binding a reason to
 *   whichever site it found first. The cost is honest and visible: exactly those
 *   entries are the ones a split has to update.
 *
 * The ordinal counts every advisory site in the symbol, not only the Tier-2 ones,
 * so a registered site that changes tier keeps its key and is reported as a tier
 * change instead of dissolving into an unrelated stale/unregistered pair.
 */
interface RegisteredGlobalLockSite {
  /** `symbol#n`, `METHOD /route#n`, or `path::symbol#n` where those collide. */
  readonly site: string;
  /** Declared tier. Compared against the tier the scanner reads at the site. */
  readonly tier: "GLOBAL";
  /** Why THIS site needs the global key: the counterpart or race it excludes. */
  readonly reason: string;
  /** The rule this registration is made under. */
  readonly invariant: (typeof TWO_TIER_LOCK_INVARIANTS)[number];
}

/** The ids that state the two-tier protocol. See docs/invariants/operations.md. */
const TWO_TIER_LOCK_INVARIANTS = ["INV-LOCK-001", "INV-LOCK-002", "INV-LOCK-003"] as const;

/**
 * Every deliberate Tier-2 (`pg_advisory_xact_lock(1)`) site in non-test `src/`,
 * with the reason that site — not that file — holds the stronger key.
 *
 * `INV-LOCK-001` is cited by a site that takes the global key ALONE;
 * `INV-LOCK-002` by one that composes it with a narrower tier, because for those
 * the order is half of what makes the site correct.
 */
const GLOBAL_LOCK_SITE_REGISTRY: readonly RegisteredGlobalLockSite[] = [
  // ── App Router handlers ───────────────────────────────────────────────────
  {
    site: "POST /api/admin/bookings/[id]/confirm-pending-guests#1",
    tier: "GLOBAL",
    reason:
      "Zero-dollar admin confirm flips PENDING to a capacity-holding status, so it joins the cancel/settlement cohort before claiming the lodge tier; without it the flip could resurrect a booking a concurrent cancel had just terminated.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/admin/bookings/[id]/confirm-pending-guests#2",
    tier: "GLOBAL",
    reason:
      "Claim-first PENDING -> CONFIRMED before the Stripe charge (#1418). The claim must exclude the cron's bump and the settlement paths, which serialise on this key, so a successful charge can no longer race a cancel into markBookingPaymentSucceeded's not-payable throw.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/admin/bookings/[id]/confirm-pending-guests#3",
    tier: "GLOBAL",
    reason:
      "Releasing a charge claim that never captured hands the beds back, so the release has to serialise with the same cancel/settlement cohort the claim did before re-taking the lodge key for the guarded release.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/admin/bookings/[id]/exclusive-hold#1",
    tier: "GLOBAL",
    reason:
      "An exclusive whole-lodge hold blocks every bed on its nights, so it excludes cancel and settlement before taking the lodge key; the hold must not be written across a lifecycle transition of the same booking.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/admin/bookings/[id]/force-confirm#1",
    tier: "GLOBAL",
    reason:
      "Admin force-confirm is a lifecycle transition into a capacity-holding status, so an overbooking override cannot resurrect a booking a concurrent cancel terminated.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/admin/bookings/[id]/return-to-waitlist#1",
    tier: "GLOBAL",
    reason:
      "#2649 admin repair of a stranded zero-dollar waitlist confirm: PAYMENT_PENDING -> WAITLISTED leaves a bed-allocatable status and prunes real BedAllocation rows, so it excludes cancel and settlement before taking the immutable booking-lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "loadPendingReviewUnderEligibilityLocks#1",
    tier: "GLOBAL",
    reason:
      "#2586: approving a flagged live booking can make it roster-eligible while rejecting one must stay ineligible until cancellation. Both decisions share this global -> immutable-lodge prefix before the authoritative re-read and guarded claim; provider work stays outside.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/bookings/[id]/confirm-draft#1",
    tier: "GLOBAL",
    reason:
      "Confirming a draft moves money and claims capacity in one transaction, so the global tier excludes cancel and settlement while the lodge tier serialises the bed claim.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/bookings/[id]/guests#1",
    tier: "GLOBAL",
    reason:
      "Adding guests reprices the booking and claims further beds, so it belongs in both cohorts; the subscription-lockout read is deliberately hoisted out so no provider call runs under the locks.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/bookings/[id]/waitlist-confirm#1",
    tier: "GLOBAL",
    reason:
      "The zero-dollar flip to a capacity-holding status ran wholly unserialised before — no lock, no re-check, a bare id-only update — so it now excludes cancel and settlement here and re-checks capacity under the lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/bookings/[id]/waitlist-confirm#2",
    tier: "GLOBAL",
    reason:
      "#2597 phase-two compensation releases an already-committed offer claim back to WAITLISTED; the release must exclude the same cohort the claim did, or a free booking is stranded with neither a payment path nor an offer.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "PUT /api/lodge/guests/[date]/depart#1",
    tier: "GLOBAL",
    reason:
      "#2586: departure cleanup shares the consent writer's global -> lodge -> roster -> BookingGuest order, so it cannot deadlock by locking the guest tuple before consent decline/expiry reaches the same roster partition.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/payments/create-payment-intent#1",
    tier: "GLOBAL",
    reason:
      "#2265: the pay transaction is a three-tier writer — booking status, capacity claim and account credit — composing global, then the per-lodge key, then the member credit ledger, matching markBookingPaymentSucceeded. Before this it held no global key at all, so its status writes did not exclude a concurrent cancel.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "POST /api/payments/switch-to-internet-banking#1",
    tier: "GLOBAL",
    reason:
      "Switching to Internet Banking with holdBedSlots flips the booking to CONFIRMED — a net-new capacity claim and a money side effect — and re-reads under the locks, because the pre-transaction snapshot was read with no lock at all.",
    invariant: "INV-LOCK-002",
  },

  // ── Bed allocation: inventory, placement and reconciliation ───────────────
  {
    site: "updateBedAllocationRoom#1",
    tier: "GLOBAL",
    reason:
      "#2366: a room edit can deactivate or rename rows that a cancellation's allocation prune is removing at the same moment, so inventory writers join the lifecycle cohort before the room's own lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "updateBedAllocationBed#1",
    tier: "GLOBAL",
    reason:
      "A bed edit changes what an allocation points at; joining the lifecycle cohort keeps a retype or deactivate from landing between a cancellation's read and its prune.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "deleteBedAllocationBed#1",
    tier: "GLOBAL",
    reason:
      "Deleting a bed destroys rows the lifecycle reconciler may be rebuilding, so global comes before the bed's immutable lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "deleteBedAllocationRoom#1",
    tier: "GLOBAL",
    reason:
      "Deleting a room destroys every bed under it and the allocations on them, the same rows cancellation prunes, so it takes the lifecycle cohort before the room's lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "runAutoBedAllocation#1",
    tier: "GLOBAL",
    reason:
      "#2593 explicit auto-allocation rebuilds its plan under the locks and writes only that plan, so the global tier keeps a cancellation prune out of the window between the authoritative read and createMany while the lodge tier keeps inventory and placement writers out.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "manuallyAllocateBed#1",
    tier: "GLOBAL",
    reason:
      "Manual placement writes a bed-night cancellation can prune, so it takes global before the bed's immutable lodge key and then delegates to the narrow lock-held implementation.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "moveBedAllocationsSameDate#1",
    tier: "GLOBAL",
    reason:
      "Only the destination bed's immutable lodge key is read before the transaction; every source row, date and bed state is re-read under both tiers, because cancellation owns the global key and prunes the same rows while custodian holds own the lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "manuallyAllocateBedForNights#1",
    tier: "GLOBAL",
    reason:
      "One transaction per night, each taking global then the lodge key, so a multi-night placement cannot interleave with a lifecycle prune on any single night.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "assignBedRange#1",
    tier: "GLOBAL",
    reason:
      "#2286: a range assignment writes all or nothing across its nights and takes global then the lodge key before the custodian scan, so a hold cannot race the scan and the write.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "deleteBedAllocation#1",
    tier: "GLOBAL",
    reason:
      "Removing one allocation row races the lifecycle prune for the same row, so global comes before the allocation's own lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "approveBedAllocations#1",
    tier: "GLOBAL",
    reason:
      "#2594 approval promotes the selected rows and takes the sorted lodge union after the global tier, because a cancellation of any covered booking prunes the very rows being approved.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "reconcileBedAllocationsForBooking#1",
    tier: "GLOBAL",
    reason:
      "#2593: the public reconciler owns the global -> immutable-booking-lodge prefix for callers holding neither tier; every composed caller uses a lock-held seam instead, so the key is minted once for this family.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "acquireFuturePartnerSharedAllocationLocks#1",
    tier: "GLOBAL",
    reason:
      "The partner-shared cleanup prefix takes the global cohort before its sorted lodge set, so a shared-double sweep can never invert the house order against a concurrent cancellation.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "applyBedAllocationMove#1",
    tier: "GLOBAL",
    reason:
      "#2595: a reviewed night/person move serialises with cancellation and every allocation counterpart before taking the sorted lodge union, the member lifecycle/link families and the deterministic allocation row locks.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "applyBedAllocationRemoval#1",
    tier: "GLOBAL",
    reason:
      "#2594: destructive removal applies a reviewed digest, so the global tier excludes cancellation's prune of the same rows before the sorted immutable lodge keys and the allocation row locks.",
    invariant: "INV-LOCK-002",
  },

  // ── Booking lifecycle and modification ────────────────────────────────────
  {
    site: "runLinkedDateMove#1",
    tier: "GLOBAL",
    reason:
      "#3232's linked move composes TWO batch modifications into one transaction, so it takes the same global key for the same reason a single one does — money and capacity — and takes it here, once, before either call. Both re-enter it as a no-op, which is what fixes the global -> lodge order however the calls are later reordered. One lodge key covers both bookings because the same-owner dependent envelope pins lodgeId to the changed booking's lodge, so no key is ADDED. The roster-date family is the one place where composing two writes does take keys outside a single sorted order — lockRosterDates sorts within a call, and this transaction makes two calls — and it is safe for the reason that helper's docblock states: every multi-key roster writer in the tree holds this global key first, so two such acquisitions can never interleave.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "modifyBookingBatch#1",
    tier: "GLOBAL",
    reason:
      "A batch modification moves money and re-claims capacity. With the per-lodge key alone a concurrent cancel could interleave and both paths compute a refund against the same captured payment, or the modify's status commit could clobber a just-cancelled booking.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "cancelLinkedProvisionalChildBookings#1",
    tier: "GLOBAL",
    reason:
      "#1881 residual: the linked provisional-child PENDING -> CANCELLED claim must exclude confirm-pending before deciding whether cancellation won, and it takes the child's own lodge key after that.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "performBookingCancellation#1",
    tier: "GLOBAL",
    reason:
      "Cancel of an accepted-quote booking shares this key with the accept path, so exactly one wins: the loser observes a non-cancellable status at the under-lock re-read or a zero-count claim and runs no side effect.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "performBookingCancellation#2",
    tier: "GLOBAL",
    reason:
      "#1547: the never-captured branch claims CANCELLED under the key capture and settlement also take, so a cancel can never interleave a capture of the same booking after the SetupIntent teardown.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "performBookingCancellation#3",
    tier: "GLOBAL",
    reason:
      "This branch restores applied credit inside the claim, and restoreCreditFromBooking has no internal replay guard — the global key plus the atomic status flip is what makes the restore exactly-once against a concurrent capture or inbound Xero reconcile.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "performBookingCancellation#4",
    tier: "GLOBAL",
    reason:
      "#1164/D7: the paid-tier cancellation claim sits in the same cohort as capture and the inbound Xero reconcile, and its status flip is this branch's exactly-once guarantee for the guardless credit restore.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "createDraftBooking#1",
    tier: "GLOBAL",
    reason:
      "#2593: creation reconciles allocation state in the same transaction as its status write, so it is a lifecycle writer rather than a capacity-only admission and joins the cohort before the resolved lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "createConfirmedBooking#1",
    tier: "GLOBAL",
    reason:
      "A self-contained confirmed create mints the global key itself; a caller that already holds both tiers passes its transaction in and this site is skipped, so the key is never taken twice or out of order.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "modifyBookingDates#1",
    tier: "GLOBAL",
    reason:
      "A date change refunds or charges and claims capacity for the new range, so it takes the global tier first for mutual exclusion with cancel, settlement and hold-release.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "adminShiftBookingDates#1",
    tier: "GLOBAL",
    reason:
      "The admin date move claims the new range and can reprice; even a frozen-cent shift takes the global key so its date and status commit cannot clobber a booking a concurrent cancel just terminated.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "hardDeleteDraftBooking#1",
    tier: "GLOBAL",
    reason:
      "Hard delete destroys a draft and its dependents outright, so it joins the lifecycle cohort rather than running against a booking another lifecycle writer is mid-transition on. It takes no capacity tier: a DRAFT owns no allocation rows.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "softDeleteCancelledBookingInTransaction#1",
    tier: "GLOBAL",
    reason:
      "#2593: soft delete reconciles allocations in the same transaction as its status write, so it takes the global cohort before the reconciler's lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "src/lib/booking-exception-execution.ts::acquireGlobalBookingLock#1",
    tier: "GLOBAL",
    reason:
      "#2525: one helper mints the key for BOTH the atomic approve-and-execute and the terminal release (reject/cancel/supersede) of a policy-exception request. Each mutates a provisional capacity reservation and, for a modification approval, composes the canonical money/status transition, so global comes before the frozen lodge key and the tx-aware service takes the member keys after that.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "src/lib/booking-exception-request-service.ts::acquireGlobalBookingLock#1",
    tier: "GLOBAL",
    reason:
      "#2525: a HELD modification request holds a provisional capacity reservation, so creating one and releasing it on member cancel or supersede are capacity changes. One helper mints the key for both, matching the approve/terminal paths so the reservation write and delete serialise with every occupancy read.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "removeBookingGuestInTransaction#1",
    tier: "GLOBAL",
    reason:
      "A single-guest removal computes a reduction refund and re-checks capacity, so it excludes cancel, settlement and hold-release before taking the booking's lodge key; the caller opens the transaction, so this is its first lock.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "respondToBookingRequestQuote#1",
    tier: "GLOBAL",
    reason:
      "A member's quote cancel must not overwrite an admin decline that already finalised the request and released its hold. The key orders it against the hold-release and cancel writers, the claim is status-guarded, and taking it before the quote row lock matches decline's order so the two cannot deadlock.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "approveBookingRequest#1",
    tier: "GLOBAL",
    reason:
      "Accepting a request converts a held booking. Hold-release and cancel serialise on this key alone, so with only the per-lodge key a release could cancel the held booking out from under a converting accept.",
    invariant: "INV-LOCK-002",
  },

  // ── Cron claims and releases ──────────────────────────────────────────────
  {
    site: "completeBookings#1",
    tier: "GLOBAL",
    reason:
      "#2593: the completion claim can prune allocation rows, so each candidate transaction joins the cohort, re-reads, status-guards the claim and only then calls the lock-held reconciler. Candidate reads stay outside.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "resolveHoldWindowUnderLock#1",
    tier: "GLOBAL",
    reason:
      "The hold-window resolution claims a PENDING booking for charge or releases it, so it must exclude cancel and settlement before taking the booking's lodge key; only the lock key is read before the lock.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "releaseChargeClaim#1",
    tier: "GLOBAL",
    reason:
      "Releasing a claim taken for a charge that did not capture hands the beds back, so it serialises with the same cohort the claim did before re-taking the lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "confirmPendingBookings#1",
    tier: "GLOBAL",
    reason:
      "The bump branch releases a PENDING booking that could not be charged; the global tier keeps that release out of a concurrent capture or cancel of the same booking.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "releaseSettlementChildren#1",
    tier: "GLOBAL",
    reason:
      "Reverting settlement children races the settle path for the same settlement; both take this key, so the reaper either loses cleanly to a payment that already captured or wins and reverts under the sorted child-lodge keys.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "cancelReapedChildren#1",
    tier: "GLOBAL",
    reason:
      "The second, terminal reap window cancels the reverted children once, on the same settlement key, so a late settle cannot promote a child the reaper is cancelling.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "releaseExpiredQuoteHolds#1",
    tier: "GLOBAL",
    reason:
      "Releasing an expired quote's held booking is a lifecycle transition that prunes allocation rows; the accept path takes the same key, so exactly one of release and accept wins and the loser bails at the under-lock re-read.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "releaseStaleModificationHolds#1",
    tier: "GLOBAL",
    reason:
      "The same fence for a stale modification hold: the release must exclude the accept and cancel writers on this key, and it re-reads under the lock so it only acts while the request still points at that exact hold.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "processWaitlistCronOnce#1",
    tier: "GLOBAL",
    reason:
      "Cancelling a past waitlist entry is a lifecycle transition that can prune allocation state, so each candidate transaction joins the cohort before the entry's own lodge key.",
    invariant: "INV-LOCK-002",
  },

  // ── Settlement, refunds and money side effects ────────────────────────────
  {
    site: "raiseDeletedBookingModificationRefundTask#1",
    tier: "GLOBAL",
    reason:
      "#2700: raising the OPEN ManualRefundTask is a find-then-create idempotent on the payment INTENT, not atomic on its own — two simultaneous confirms of one capture would raise two tasks and two operators would refund one payment twice. This is the cohort booking-cancel.ts is already in when IT creates a ManualRefundTask, so it reuses lock(1) rather than minting a keyspace, and takes nothing else.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "recordAutomaticCancelledBookingRefundTask#1",
    tier: "GLOBAL",
    reason:
      "#2760: the webhook's writer became close-or-create, so two Stripe deliveries of one capture — or a delivery racing the raise above — would each find no row and each write one, putting a single refund on the finance card twice. Same key and same cohort as the raise; every Stripe call belongs to the caller and has already returned.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "raiseEditFinancialReviewTask#1",
    tier: "GLOBAL",
    reason:
      "#3030 (epic #2797): raising the OPEN EDIT_FINANCIAL_REVIEW task is a find-then-create on the occurrence key, which is not atomic on its own — two replays of one unpriceable booking edit would each find no row and each write one, and two operators would then hand the same adjustment back twice. Same key and same cohort as the two raisers above, and nothing else: it joins no capacity or member-credit tier. Taken INSIDE the caller's transaction and re-entrant, so #3032's booking-edit path (which already holds lock(1) before the per-lodge key) pays nothing for it. INV-LOCK-002's global-before-per-lodge order is a PRECONDITION ON THE CALLER here rather than a property this site provides: re-taking the first tier is free only for a transaction already at or above it, so a caller holding ONLY a per-lodge capacity key deadlocks against any of the ~40 global-then-lodge writers (Postgres kills one with 40P01). The three services #3032 will wrap all take global first. The unique index on occurrenceKey is belt-and-braces behind this key rather than the primary fence, because a unique violation aborts the surrounding transaction and so cannot be recovered from in place.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "settleGroupBookingOnOrganiserCancel#1",
    tier: "GLOBAL",
    reason:
      "The durable cancellation fence: settle, reaper and cancel all serialise here, so once CANCELLED commits a later settlement apply must refuse to promote children. No provider call happens while the transaction is open.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "settleGroupBookingOnOrganiserCancel#2",
    tier: "GLOBAL",
    reason:
      "#1881: the FAILED claim on an open settlement used to be a bare update gated on a stale in-memory read, taking no lock at all. It now takes the key and status-guards the write, so a settle that captured the organiser's money is never clobbered back to FAILED.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "settleGroupBookingOnOrganiserCancel#3",
    tier: "GLOBAL",
    reason:
      "Each child's cancel and its refund credit-note enqueue commit inside one transaction on the settlement cohort's key, and reconcile that child's allocations through the lock-held seam.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "createGroupSettlementIntent#1",
    tier: "GLOBAL",
    reason:
      "Attaching a freshly minted PaymentIntent must not cross a reap, a failure mark or an organiser cancel of the same group; all of them serialise on this key and the attach re-reads the group status under it.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "createGroupSettlementInvoice#1",
    tier: "GLOBAL",
    reason:
      "Minting the settlement invoice is fenced against the same cohort, so an invoice is never queued for a group another writer has already cancelled.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "commitChildrenToConfirmed#1",
    tier: "GLOBAL",
    reason:
      "Promoting children to CONFIRMED is the settlement's capacity claim: the global tier orders it against reap, fail and refund, and the per-child lodge keys serialise the claim itself.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "settleConfirmedChildrenAndNotify#1",
    tier: "GLOBAL",
    reason:
      "Settlement takes the same key as the reaper, the failed/refunded marks and the organiser-cancel claim, so it can never interleave a reap of the same settlement — the pre-#1881 default-lodge key did not exclude the reaper. Bed reconciliation then takes the complete sorted child-lodge union.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "markGroupSettlementIntentRefunded#1",
    tier: "GLOBAL",
    reason:
      "The refunded mark is a terminal money transition on the settlement, taken on the cohort key so it cannot interleave with a settle or a reap; the intent id is kept so the next attempt mints a fresh key.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "markGroupSettlementIntentFailed#1",
    tier: "GLOBAL",
    reason:
      "The failure mark records a non-success outcome only. The key adds atomicity against a concurrent settle rather than a new veto, and the guarded updateMany fuses the still-non-terminal check with the write.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "releaseOneHold#1",
    tier: "GLOBAL",
    reason:
      "Releasing an expired Internet Banking hold returns beds and clears the invoice with a credit note in one transaction, so it joins the money/status cohort before the lodge and member-credit tiers.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "settleBookingPaymentInTransaction#1",
    tier: "GLOBAL",
    reason:
      "#2262: the ONE settlement body, shared byte-for-byte by the Stripe capture and the admin's manual cash settlement. Without the global key the capture stopped excluding cancel, hold-release and settlement, and the PAID write could resurrect a just-cancelled booking.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "reverseManualBookingPayment#1",
    tier: "GLOBAL",
    reason:
      "Reversing a manual mark-paid moves money and restores PAYMENT_PENDING, which RELEASES capacity, so it takes the same global-before-per-lodge pair as the settlement it undoes.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "syncInternetBankingPaymentsForPaidInvoice#1",
    tier: "GLOBAL",
    reason:
      "Inbound Xero PAID mints local payment state per matched payment, and cancellation and capture take the same key, so a paid-invoice effect cannot land on a booking another writer has just terminated. It is a two-lock composition: the same closure then takes acquireLodgeCapacityLock on the booking's immutable lodge, because flipping an unheld PAYMENT_PENDING booking to PAID is a net-new capacity claim and the global key no longer excludes per-lodge creators. Each payment is fenced in its own short transaction; the provider work has already returned.",
    invariant: "INV-LOCK-002",
  },

  // ── Capacity-adjacent writers with their own counterparts ─────────────────
  {
    site: "writeRequestedRoom#1",
    tier: "GLOBAL",
    reason:
      "#2594: requested-room editing shares the global cohort with allocation approval and reviewed removal, whose final-approved consequence it must not cross, and locks and re-reads the booking row before its guarded write.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "lockRosterEligibilityMutation#1",
    tier: "GLOBAL",
    reason:
      "#2586: eligibility-validating roster generation, save and confirmation join the booking-writer order before the roster-date key. That closes the initially-empty-partition race without making every booking writer enumerate all possible roster dates.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "respondToMemberGuestConsent#1",
    tier: "GLOBAL",
    reason:
      "#2307: a consent decline reprices the booking, can elect account credit to the owner, AND releases a bed, so it belongs in both cohorts and takes global first; the booking is then re-read under the locks because a deletion can commit between the two.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "expireMemberGuestConsent#1",
    tier: "GLOBAL",
    reason:
      "#2307: a lapse has the same three effects as a decline, and kiosk departure reaches the same guest rows under global -> lodge, so expiry follows the identical order rather than inventing one.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "approveSchoolBookingRequest#1",
    tier: "GLOBAL",
    reason:
      "#2593: both fresh creation and held reuse reconcile bed allocations in this transaction, so the global tier fences cancellation and pruning while the concrete lodge tier serialises the capacity claim.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "approveMemberWholeLodgeRequest#1",
    tier: "GLOBAL",
    reason:
      "Whole-lodge conversion composes a booking lifecycle transition with allocation pruning, so it joins the global cohort before the booking's lodge capacity key; the held reconcile reuses that prefix.",
    invariant: "INV-LOCK-002",
  },

  // ── Waitlist ──────────────────────────────────────────────────────────────
  {
    site: "confirmCrossLodgeWaitlistOffer#1",
    tier: "GLOBAL",
    reason:
      "The minimum-stay refusal returns the entry to WAITLISTED without consuming the offer, which is a lifecycle transition that must exclude cancel and expiry before taking the entry's lodge key.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "confirmCrossLodgeWaitlistOffer#2",
    tier: "GLOBAL",
    reason:
      "#2543: the paid-up-adult refusal fails closed down the same release path, so it takes the same cohort — the member keeps their place instead of the offer being burnt by a racing writer.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "confirmCrossLodgeWaitlistOffer#3",
    tier: "GLOBAL",
    reason:
      "Phase-one validation re-reads the offer under the locks before the cross-lodge claim, so an expiry or a cancel cannot move it between the read and the claim.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "confirmCrossLodgeWaitlistOffer#4",
    tier: "GLOBAL",
    reason:
      "Capacity-exceeded compensation reverts the claim across two lodges, so it takes the global tier once and then both lodge keys in sorted order — a cross-lodge path may never reverse the topology.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "confirmCrossLodgeWaitlistOffer#5",
    tier: "GLOBAL",
    reason:
      "A price mismatch against the quote cancels the fresh booking and refreshes the stored offer; that cancel is a lifecycle transition on the offered lodge and joins the cohort before it.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "confirmCrossLodgeWaitlistOffer#6",
    tier: "GLOBAL",
    reason:
      "Phase three cancels the waitlist entry and links the two bookings, a lifecycle write on the entry's own lodge that must not cross a concurrent expiry.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "processWaitlistForDates#1",
    tier: "GLOBAL",
    reason:
      "The offer sweep moves waitlisted bookings to WAITLIST_OFFERED across every candidate lodge, so it takes the global tier once and then each affected lodge key; the subscription-lockout read is resolved before the transaction so no provider call runs under them.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "revertSameLodgeOfferToWaitlisted#1",
    tier: "GLOBAL",
    reason:
      "Reverting an offer must not undo an expiry or cancel that already moved the booking on, so it joins the cohort and its restore is status-guarded on WAITLIST_OFFERED.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "confirmWaitlistOffer#1",
    tier: "GLOBAL",
    reason:
      "Confirming an offer claims beds and moves the booking into a payment path, so it excludes cancel and settlement before the lodge key it re-checks capacity under.",
    invariant: "INV-LOCK-002",
  },
  {
    site: "expireStaleOffers#1",
    tier: "GLOBAL",
    reason:
      "Expiry releases offered beds and re-offers them to the next candidates, so it takes the global tier before the affected lodge keys and a concurrent confirm cannot be expired mid-claim.",
    invariant: "INV-LOCK-002",
  },

  // ── Xero group-settlement invoicing ───────────────────────────────────────
  {
    site: "createXeroInvoiceForGroupSettlement#1",
    tier: "GLOBAL",
    reason:
      "The initial fence stops a queued operation from starting provider work after organiser cancellation has already committed; cancellation owns the same key. The provider call itself stays outside the transaction.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "createXeroInvoiceForGroupSettlement#2",
    tier: "GLOBAL",
    reason:
      "After the provider call returns, the create-versus-cancel race is decided under the same fence: a cancellation that acquired it first wins and the invoice is voided, otherwise issuance won the serialisation point.",
    invariant: "INV-LOCK-001",
  },
  {
    site: "createXeroInvoiceForGroupSettlement#3",
    tier: "GLOBAL",
    reason:
      "The email gate re-reads the settlement under the same fence, so an invoice for a group cancelled in the meantime is never emailed.",
    invariant: "INV-LOCK-001",
  },
];

const SCOPED_ADVISORY_LOCK_INVENTORY: Record<string, number> = {
  // #1936: the join-request review and group-create approve transactions take
  // member-lifecycle:{memberId} for the pre-existing member being linked, so
  // FamilyGroupMember writes serialize with the application-approval mapping
  // transaction's in-any-family-group collision guard (a FamilyGroupMember
  // insert does not bump Member.updatedAt, so the preview token alone cannot
  // catch the race). Single-lock holders; composition and counterpart analysis
  // in docs/CONCURRENCY_AND_LOCKING.md.
  // #3291 moves existing-member parent approval onto the shared lifecycle
  // helper and then the shared partner helper. The one remaining raw site is
  // the requester's separate lifecycle transition; the shared mints below are
  // each counted once at their authority module.
  "src/lib/admin-family-group-requests-service.ts": 1,
  // #2586: every roster-date writer calls the shared helper; the key is minted
  // once here and writer participation is pinned by roster-lock-contract.test.
  "src/lib/roster-lock.ts": 1,
  // #2364/#2596: lockAdultMemberHostingPolicySet takes the single blocking global
  // adult-member-hosting-policy-set key before any read by an admin CRUD write
  // or a configuration import, and the migration's BEFORE STATEMENT trigger
  // takes the same key ahead of any tuple lock so operator DML joins the same
  // order. TWO since #2722: the drain's fail-fast `pg_try_advisory_xact_lock`
  // helper lives in this file too, and used to be exempt because the census
  // matched only the blocking spelling. That exemption was a detection hole, not
  // a decision — the same blindness would have hidden a fail-fast acquisition of
  // the GLOBAL key — so both spellings are now scanned and both are counted.
  // Config import, member merge and drain compose the key only in the documented
  // forward order; no counterpart reverses it. Counterpart analysis in
  // docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/adult-member-hosting-policy-set.ts": 2,
  // #2596: after the hosting policy-set key, the drain takes sorted
  // member-lifecycle keys for claimed owner + actor before Member rows and the
  // exact payload refresh. Merge takes those keys before relation moves. No
  // lifecycle participant takes the policy key and the drain never locks the
  // queue row, so there is no reverse policy or queue -> Member edge.
  "src/lib/adult-member-hosting-coverage-drain.ts": 1,
  // Same-owner hosting coverage (#2576 §9). `lockHostingCoverageOwner` takes
  // `pg_advisory_xact_lock(hashtext('hosting-coverage-owner'), hashtext(<Booking.memberId>))`
  // — a NEW keyspace in its own namespace, keyed on the booking OWNER.
  //
  // WHY IT EXISTS. `SAME_BOOKING_OWNER` makes one booking's compliance a function of
  // ANOTHER booking's rows. When #2576 introduced this key, confirmed creation used
  // lodge while cancellation used global, leaving the named race open. #2593 later
  // made the allocation-participating confirmed-create and cancellation paths compose
  // global → lodge. The owner key remains required because participant/member/queue
  // producers do not all share those tiers and the invariant is cross-booking and
  // per-owner. Same reasoning that gave `lockBookingMemberNights` its own family: a
  // per-member invariant cannot be serialised by a per-lodge key alone.
  //
  // COMPOSITION AND ORDER. Taken LAST among the application locks a caller composes:
  // after `pg_advisory_xact_lock(1)`, `acquireLodgeCapacityLock`, roster-date locks,
  // `lockBookingMemberNights` and member-credit locks wherever those families apply.
  // The #2586-aware modification order is therefore global → lodge → roster-date →
  // applicable member keys → coverage-owner; paths that do not use roster or member
  // keys simply omit those tiers. Several owners are acquired in SORTED order, the
  // same discipline the member-night lock uses. Postgres advisory locks are re-entrant
  // per session, so the evaluator and the settle step taking the same owner key inside
  // one transaction costs nothing. Callers resolve the lodge policy first and skip the
  // lock entirely unless the lodge has the scope enabled, so no unrelated write is
  // serialised per member. ONE site: every acquisition in the tree goes through this
  // helper. TWO since #2722, for the reason given under the hosting policy set
  // above: the fail-fast `tryLockHostingCoverageOwners` sibling is the second
  // spelling of the same key and is now counted rather than invisible.
  // Counterpart analysis and compatibility evidence in
  // docs/CONCURRENCY_AND_LOCKING.md → "Same-owner coverage takes a per-owner key".
  //
  // STILL TWO AFTER #3039 MINTED A SECOND FAMILY HERE — the per-TRIP
  // `pg_advisory_xact_lock(hashtext('hosting-coverage-group'), hashtext(<GroupBooking.id>))`,
  // in both the blocking and the fail-fast spelling. The count did not go to four
  // because the two families differ in exactly two facts, the namespace constant and
  // the decode label, so both go through ONE blocking primitive
  // (`lockCoverageKeys`) and ONE fail-fast primitive (`tryLockCoverageKeys`)
  // parameterised on those (`INV-SSOT-001`). Two statements in the file, both counted,
  // both scanned — and a family that drifted to the session-scoped
  // `pg_advisory_lock(` spelling is now impossible to introduce for one family alone.
  //
  // WHY A SECOND FAMILY AT ALL. `SAME_GROUP_TRIP` (#3038) makes one booking's
  // compliance a function of a booking on ANOTHER ACCOUNT. The owner key is
  // `Booking.memberId` — the dependent's own account — so two writers changing two
  // bookings in one trip hold two DIFFERENT owner keys and are not serialised by
  // them at all; at READ COMMITTED each can then observe a state the other has
  // already invalidated. Not the lodge key either: one lodge holds many unrelated
  // trips and a lodge-wide key would serialise all of them. The trip is the
  // contention domain, so the trip is the key (`INV-LOCK-001`).
  //
  // ORDER. It sits IMMEDIATELY ABOVE the coverage-owner key and below everything
  // else: global → lodge → roster-date → applicable member keys → participant
  // `Member` rows → coverage-GROUP → coverage-owner. Group before owner because the
  // trip's membership is what decides WHICH owners the fan-out will name, so the
  // owner set is not even known until this key is held. That makes the owner key's
  // former "always last" the second of the last two, and every statement of the old
  // form has been rewritten rather than left standing.
  //
  // COUNTERPART, AND WHY NO NEW WAIT-GRAPH EDGE APPEARS. Every acquisition tries the
  // key with `pg_try_advisory_xact_lock` before the blocking form and rolls the whole
  // outer transaction back on a conflict — the same protocol #2597 applied to
  // repeated owner-key acquisition, and necessary here rather than merely prudent:
  // one transaction can reconcile a booking in one trip and then inspect a
  // same-owner dependent that sits in ANOTHER trip, so sorting inside one call
  // cannot order keys discovered in two. Callers resolve the lodge policy first and
  // take nothing unless `SAME_GROUP_TRIP` is on and the booking is in a trip.
  // Counterpart analysis in docs/CONCURRENCY_AND_LOCKING.md → "Group Trip coverage
  // takes a per-trip key, above the owner key".
  "src/lib/adult-member-hosting-coverage-lock.ts": 2,
  // AI Diagnostics budget reserve (AID-2, #2371). Both writers take the SAME
  // per-month key `pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'),
  // hashtext(<month>))`: `reserveDiagnosticsBudget` (the guarded spend claim) and
  // `settleDiagnosticsRoundtrip` (books the actual cost), so reserve and settle
  // are mutually exclusive per month and every reserve sees a consistent
  // settled+reserved sum. It is a NEW, isolated keyspace: keyed by calendar month
  // only, taken by no other writer, and each site takes only this one key (never
  // a second lock), so it forms no lock-ordering cycle and has no interaction with
  // the global booking/money lock(1), the per-lodge capacity key, or any other
  // scoped key above — the keyspaces are disjoint. Provider calls run OUTSIDE the
  // locked transaction. Counterpart analysis and compatibility evidence in
  // docs/CONCURRENCY_AND_LOCKING.md → "Composition: diagnostics budget reserve
  // (AID-2, #2371)".
  "src/lib/ai-diagnostics-usage.ts": 2,
  "src/lib/authoritative-fees.ts": 1,
  // #2095: claimBackupRun takes the singleton backup:run-lock key for the
  // milliseconds of the reap/check/insert claim transaction only (the dump
  // itself runs outside any transaction), so cron and run-now backups
  // serialise across containers. Single-lock holder, no composition with any
  // booking/money/lifecycle key; counterpart analysis in
  // docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/backup-run.ts": 1,
  "src/lib/booking-member-night-conflicts.ts": 1,
  // #calendar-recurring: lockCalendarSeries takes calendar-series:{seriesId} for
  // the milliseconds of a whole-series regenerate/propagate/collapse/delete so
  // two concurrent editors can't interleave a delete-and-regenerate and
  // duplicate/drop occurrences. Single-lock holder; its own keyspace, composed
  // with no booking/money/capacity/lifecycle key (calendar rows only).
  "src/lib/calendar-service.ts": 1,
  "src/lib/config-transfer-lock.ts": 1,
  "src/lib/lodge-capacity-lock.ts": 1,
  "src/lib/member-credit.ts": 1,
  "src/lib/member-lifecycle-actions.ts": 2,
  // #2593: one canonical helper mints member-lifecycle:{memberId}; it
  // de-duplicates and sorts ids before acquisition. Deletion, bulk update,
  // member-detail and seasonal-assignment writers all call this helper instead
  // of reconstructing the scoped key at their individual call sites.
  "src/lib/member-lifecycle-lock.ts": 1,
  // #2363: every minimum-stay policy writer takes the one global policy-set
  // key before reading/planning. The migration's BEFORE STATEMENT trigger
  // takes the exact same key for draining old-colour INSERT/UPDATE/DELETE before
  // PostgreSQL reaches tuple locks. Config import orders its existing singleton
  // first, then this key; live CRUD takes only this key.
  "src/lib/minimum-stay-policy-set.ts": 1,
  // #1937/#2596/#3291: executeMemberMerge first calls the shared hosting policy-set
  // helper, then — since #2595 — the merge-only partner-share prefix helper
  // (`acquireMemberMergePartnerSharedLodgeLocks`: every affected lodge capacity
  // key, sorted, and NO global cohort key), then takes the two
  // member-lifecycle keys through their shared helper, and finally the canonical
  // member-partner-link keys through `member-partner-lock.ts` — because merge
  // re-points partner links AND reads them to decide which future shared
  // doubles step 3b deletes. All three added tiers come from helpers that own
  // their own raw sites
  // (adult-member-hosting-policy-set.ts, bed-allocation-lifecycle.ts +
  // lodge-capacity-lock.ts, member-partner-lock.ts) — merge mints no new key of
  // its own. Merge therefore has no raw scoped site of its own. This order
  // serialises policy enumeration before relation moves,
  // keeps the fixed lodge -> member order for the #2595 shared-double
  // reconciliation, matches the reviewed move's member-lifecycle ->
  // member-partner-link order so no new wait-graph edge appears, and
  // excludes every delete/archive/merge touching either member. Merge is
  // deliberately absent from GLOBAL_LOCK_SITE_REGISTRY above:
  // `member-merge-execute.test.ts` pins that it takes no `lock(1)` at all.
  // #2595: the partner-link service and reviewed move service share this one
  // canonical sorted member-partner-link lock mint.
  "src/lib/member-partner-lock.ts": 1,
  // #2148: reconcileSubscriptionBillingExceptions takes the SAME
  // membership-subscription-billing:{seasonYear} key as
  // confirmSubscriptionBillingPreview (no new key), so refresh-reconciliation
  // and confirm serialise; counterpart analysis in
  // docs/CONCURRENCY_AND_LOCKING.md, compatibility evidence in PR #2158.
  "src/lib/membership-subscription-billing.ts": 2,
  // #1936/#3291: the two pre-existing membership-application locks
  // (application id + applicant email) remain local. Approval mapping now
  // takes its complete sorted lifecycle set through member-lifecycle-lock.ts,
  // followed by the complete partner set through member-partner-lock.ts.
  // Those shared mints are counted at their authority modules.
  "src/lib/nomination.ts": 2,
  "src/lib/xero-contacts.ts": 2,
  // #3170: `enqueueXeroSupplementaryInvoiceOperation` takes
  // `pg_advisory_xact_lock(hashtext('xero-supplementary-invoice'), hashtext(<anchor>))`
  // - a NEW keyspace in its own namespace, keyed on the `BookingModification`
  // the invoice corrects.
  //
  // STILL ONE SITE AFTER #3193, and the count is the interesting part. The
  // second ask - a review share's own small invoice, raised when the change's
  // invoice had already gone out without it - reaches the SAME statement through
  // `enqueueXeroSecondSupplementaryInvoiceOperation`, which is a named wrapper
  // over this enqueue rather than a second copy of its link-check ->
  // queued-check -> write. So there is still exactly one place that decides
  // whether an ask already has an invoice going out, which is the property
  // #3170 was fixing; a second locked decision elsewhere would be the same
  // defect wearing a different anchor. The KEYSPACE widens rather than the site
  // count: the anchor is now the `BookingModification` OR the `ManualRefundTask`
  // whose share the invoice bills. Two anchors never contend, and a second ask
  // is invisible to every read scoped to the change - which is what stops the
  // change's own restate raising a $30 follow-on to the $230 combined total on
  // top of an invoice already with the member.
  //
  // WHY IT EXISTS. The owner's 30 Aug 2026 decision makes two review settlements
  // of ONE booking edit contribute to one combined total, and the Xero leg has to
  // move with it. Deciding "does this edit already have a supplementary invoice
  // going out?" was a check-then-create, and the check deduped on a
  // `correlationKey` BUILT FROM THE AMOUNT - so two concurrent settlements at
  // $200 and $30 matched nothing of each other's, queued two operations and sent
  // the member two invoices for one edit. The active `SUPPLEMENTARY_INVOICE` link
  // fences nothing before the first invoice exists, so the lock is what makes
  // "one invoice per edit" true rather than asserted.
  //
  // COUNTERPARTS AND ORDER. Single-lock holder, composing with no other family,
  // and no counterpart writer takes it. TWO callers, and "every caller is
  // post-commit" was not one of them: the edit-settlement callers reach it
  // post-commit through a fire-and-forget `queueXeroBookingEditSettlement`, while
  // the booking-vs-Xero repair pass (`xero-booking-repair-passes.ts`,
  // `QUEUE_SUPPLEMENTARY_INVOICE`) calls it DIRECTLY. The no-cycle conclusion
  // stands for a stronger reason than the one first written down: that pass is an
  // operator-driven admin/CLI action which opens no transaction of its own and
  // holds no advisory lock, so it too arrives holding nothing. Held for the
  // milliseconds of the link-check -> queued-check -> raise-or-create transaction;
  // the Xero round trip happens later, in the outbox worker, entirely outside it.
  // Inventory row and stated residual in docs/CONCURRENCY_AND_LOCKING.md; the
  // serialisation itself is proven against real PostgreSQL by
  // `edit-financial-review-races.realdb.test.ts`.
  "src/lib/xero-operation-outbox.ts": 1,
};

// Every entry here is now a LOCK-ONLY statement (#2289): it selects a constant,
// runs through `$executeRaw`, and its result is never read. The data each one
// protects is read back through the Prisma model under that same lock, so no row
// lock in this repository doubles as an unchecked-cast read. The one raw
// statement whose result IS read (`rate-limit.ts`) takes no lock and goes
// through `decodeRawRows`. `raw-sql-shape-guard.test.ts` holds that line.
const ROW_LOCK_SITE_INVENTORY: Record<string, number> = {
  // The room bunk-group writer and #2594 allocation approval each use one
  // lock-only row statement. Reviewed removal locks its selected/causal rows,
  // and requested-room editing locks the booking before its authoritative
  // approval check and guarded update.
  //
  // These two were one entry of 2 against `admin-bed-allocation.ts` until #2688
  // split that file. Both moved WHOLE, inside their enclosing functions, to the
  // module that owns their concern — the count is unchanged and neither site
  // changed strength, order or counterpart. Note that this inventory is keyed by
  // FILE, unlike the Tier-2 registry above, so a structural move re-keys it even
  // when nothing about the lock moves; #2722 converted the advisory census to
  // per-site identity and deliberately left this one per-file.
  "src/lib/bed-allocation-approval.ts": 1,
  "src/lib/bed-allocation-bunk-pairing.ts": 1,
  // #2595 reviewed moves lock every selected/destination/old-bed counterpart
  // tuple after the advisory tiers and before their authoritative re-read.
  "src/lib/bed-allocation-move.ts": 1,
  "src/lib/bed-allocation-removal.ts": 1,
  "src/lib/requested-room-write.ts": 1,
  "src/lib/booking-create-promo.ts": 1,
  // Promo usage caps (#2299): `lockPromoCodeRowsForUpdate` takes a
  // `SELECT 1 … FOR UPDATE` on the promo row for the modification paths,
  // which can now RELEASE a cap slot as well as take one. One raw statement
  // serves all four of them — the batch-modification path calls it directly
  // (it may lock two codes for a swap), and adding guests / changing dates /
  // removing guests reach it through `lockAndRefreshPromoCodeUsage`, which also
  // re-reads `currentRedemptions` under the lock. That wrapper has four call
  // sites, not three: the batch path also calls it on its no-swap reprice
  // branch, where the lock is already held and the refreshed counter is the
  // point. Booking creation takes its own lock in booking-create-promo.ts
  // above, which since #2289 also selects a constant and reads the promo back
  // through `tx.promoCode.findUnique` — it used to `SELECT *` and read the raw
  // row, and that unchecked cast is what silently disabled a redemption cap and
  // a FREE_NIGHTS discount. Ids are sorted and locked one
  // statement at a time so a promo swap (outgoing + incoming code in one
  // transaction) can never build a lock cycle with another swap; callers hold
  // the per-lodge capacity lock first, so the order stays lodge -> promo row.
  // A CONSTANT is selected and the result discarded — a lock, never a read. See
  // docs/CONCURRENCY_AND_LOCKING.md -> "Narrow row- and table-lock protocols".
  "src/lib/promo.ts": 1,
  // Site-style save (#2322) locks the ClubTheme singleton
  // (`SELECT 1 … FOR UPDATE`) so concurrent saves serialise and never
  // both delete the same replaced LOGO blob. Order: ClubTheme row -> MediaImage.
  // Singleton-keyed; no advisory lock; disjoint from booking/money writers. See
  // docs/CONCURRENCY_AND_LOCKING.md -> "Club-theme logo writer".
  "src/lib/club-theme.ts": 1,
  // Member-photo upload (POST) and remove (DELETE) each lock the member row
  // (`SELECT 1 … FOR UPDATE`) so concurrent replace/remove
  // serialise and never orphan a MEMBER_PHOTO blob. Member-id keyed; no
  // advisory lock; disjoint from booking/money writers. See
  // docs/CONCURRENCY_AND_LOCKING.md → "Member photo writer".
  "src/app/api/members/[id]/photo/route.ts": 2,
  // Adult-member-hosting queue participants (#2597): the shared helper mints
  // one reviewed `FOR UPDATE` protocol for member merge over master, loser and
  // every planned ancillary owner, plus the shared standing-subject barrier
  // that excludes a late BookingGuest FK `KEY SHARE` for every member-standing
  // fan-out. Ordinary seams use the separate sorted `FOR KEY SHARE NOWAIT`
  // protocol in this helper. It issues the runtime exact-participant proofs
  // consumed by queue writes.
  // FOUR since #2623 T9(d) counted every strength, not two: the two `FOR UPDATE`
  // statements above plus the two `FOR KEY SHARE` ones that were inventoried
  // nowhere — the ordinary seams' sorted NOWAIT acquisition, and the
  // booking-request hold's blocking lock over its exact linked-member snapshot.
  // The merge `FOR UPDATE` now runs under a 10s `lock_timeout` and restores it,
  // so a wait-while-holding-the-policy-key is bounded and lands on the same
  // stable retry (#2623 T6).
  // See docs/CONCURRENCY_AND_LOCKING.md → "Adult-member-hosting queue
  // participant fencing" and "Member merge".
  "src/lib/adult-member-hosting-queue-participants.ts": 4,
  // The hosting coverage drain locks the claimed owner and FK-less actor
  // `FOR KEY SHARE` after their sorted member-lifecycle keys and before the exact
  // typed queue refresh, so merge cannot re-point an identity between the claim
  // snapshot and the work. One statement, executed once per claimed id.
  // See docs/CONCURRENCY_AND_LOCKING.md → "Adult-member-hosting queue
  // participant fencing".
  "src/lib/adult-member-hosting-coverage-drain.ts": 1,
  // Incident promotion locks the reconciliation's actor `FOR KEY SHARE` so a
  // present actor cannot be hard-deleted between the existence check and the
  // incident FK write; a zero-match degrades to anonymous officer attribution
  // rather than failing a poison item. Order: policy-set → this row.
  "src/lib/adult-member-hosting-review.ts": 1,
  // The Xero member-scoped CREATE and UPDATE reservations each take the target
  // `Member FOR KEY SHARE` in a short transaction, read the payload back through
  // Prisma under it, and commit the `RUNNING` operation before any provider call.
  // Merge and account deletion take the conflicting `FOR UPDATE` on the same row
  // and re-check the reservation, so one side always loses cleanly and Xero never
  // sits inside a long transaction.
  // See docs/CONCURRENCY_AND_LOCKING.md -> "Xero contact writers".
  "src/lib/xero-contacts.ts": 2,
  // Member-scoped Xero contact writes (#2597) share one `FOR UPDATE` protocol
  // for canonical CONTACT-link completion. Account deletion and member merge
  // take the same Member row before teardown, while CREATE/UPDATE reservations
  // use the separate `FOR KEY SHARE` protocol inventoried by their source tests.
  // See docs/CONCURRENCY_AND_LOCKING.md -> "Xero contact writers".
  "src/lib/xero-contact-create-recovery.ts": 1,
  // Releasing a started deletion approval (#2627) locks the exact
  // `DeletionRequest` row (`SELECT 1 … FOR UPDATE`) and reads the claim's
  // previous holder and note back through the Prisma model under it, because
  // the transition destroys that attribution and its audit entry — written in
  // the same transaction, awaited — is the only surviving record of it. Reading
  // the holder outside the lock would be an ABA guess. The guarded
  // `APPROVAL_IN_PROGRESS -> PENDING` `updateMany` is retained under the lock,
  // so the winner protocol every transition on this row shares is unchanged.
  // Request-id keyed on an immutable cuid; no advisory lock. Counterparts are
  // the other two transitions on the same row — an approval finalising inside
  // the anonymisation transaction (which also holds the target `Member FOR
  // UPDATE` via the Xero fence; the release takes only this row, so no cycle)
  // and an ordinary rejection. See docs/CONCURRENCY_AND_LOCKING.md ->
  // "Approve, reject and release of one `DeletionRequest`".
  "src/lib/deletion-request-decision.ts": 1,
};

const CAPACITY_LOCK_MINT = "src/lib/lodge-capacity-lock.ts";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Test files are skipped by NAME, which is a stated limit of every census here.
 * `.integration.` anywhere in a path drops the file, so a production module named
 * `probe-fence.integration.ts` would take locks this scan never sees. Nothing in
 * this repository is named that way today — the integration modules that exist
 * spell it `integration-credentials.ts` — and the rule is kept because it is the
 * one the sibling guards use. It sits alongside the other boundary worth knowing:
 * only non-test `src/` is walked, so a lock taken in a migration's trigger or in
 * `scripts/` is outside every census in this file.
 */
function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/**
 * Does this blanked run hold a RAW STATEMENT the census must be able to read,
 * rather than prose about one?
 *
 * A QUOTED LITERAL IS NOT CODE for this purpose, and #2623 T9(d) is where that
 * started to matter: `adult-member-hosting-queue-participants.ts` names its own
 * protocol inside an error message ("… must never be issued without its FOR KEY
 * SHARE NOWAIT lock"), which is prose about a statement, not a statement. A
 * counter that scored it would put a number in the inventory below that no reader
 * could reconcile against the file, and would fail the census when somebody
 * reworded a sentence. Every raw statement in this repository is written as a
 * BACKTICK template, so template text is always restored.
 *
 * QUOTED MEANS EITHER QUOTE, and that is deliberate rather than an oversight of
 * the double-quoted spelling this rule was written against.
 * `blankLiteralsWithSpans` reports `"` and `'` alike as `kind: "string"`, so the
 * test below is quote-agnostic and every clause here applies to both. Nothing
 * would be gained by narrowing it to one quote: a single-quoted sentence is as
 * much prose as a double-quoted one.
 *
 * BUT ONLY PROSE, NOT SQL (#2623 F7). Suppressing every quoted literal opened the
 * same hole T9(d) exists to close, one level down: `$executeRawUnsafe` takes a
 * plain string, so `const SQL = "SELECT … FOR UPDATE"; await
 * tx.$executeRawUnsafe(SQL)` would score ZERO and drop out of the census
 * silently. A literal containing `SELECT` is therefore restored and counted —
 * prose about the protocol does not contain it (the one live case, quoted above,
 * does not), and a raw statement always does. The narrower rule keeps the false
 * positive suppressed while refusing to suppress a real statement. **Both
 * spellings are counted**: `tx.$executeRawUnsafe('SELECT … FOR UPDATE')` scores
 * exactly as its double-quoted twin does, which the cases below pin so nobody
 * reads the paragraph above as a double-quote-only carve-out.
 *
 * A `comment` run is never restored, which is the whole point of masking, and a
 * `regex` run is never restored because a pattern is not a statement.
 */
function holdsRawStatement(source: string, span: BlankedSpan): boolean {
  if (span.kind === "template") return true;
  if (span.kind !== "string") return false;
  return /SELECT/i.test(source.slice(span.start, span.end));
}

/**
 * The one masking rule, shared by the per-site scan and the count inventories:
 * the file with every comment and every prose literal blanked to spaces, and the
 * raw SQL put back where {@link holdsRawStatement} recognises it.
 *
 * THE SCANNER IS THE SHARED ONE (#3196, `INV-SSOT-004`). Until then this census
 * carried the last private comment scanner in the tree, and it worked a LINE at a
 * time: a whole-line comment was dropped by its leading `//` or `*`, and
 * double-quoted literals were blanked with a regex. Both halves were wrong in
 * ways nothing here could see. A TRAILING comment was never dropped at all, nor
 * was a block-comment body line that did not begin with `*`, so prose in either
 * shape counted as code. And a line-local quote regex has no idea what a REGEX
 * LITERAL is: `.replace(/"/g, "")` reads as a string opener, which is the exact
 * defect #3155 removed from the shared scanner and #3180 then found LIVE in a
 * sibling census, where it hid a real database write five hundred lines further
 * down. The remedy is not a better local regex; it is not having a second
 * scanner. `blankLiteralsWithSpans` blanks with every offset preserved and hands
 * back the runs it blanked, so the SQL carve-out lives HERE — where a policy
 * about SQL belongs — and the lexing lives in the module that owns it.
 *
 * OFFSETS SURVIVE THE RESTORE, because every span is exactly as long as the
 * spaces standing in for it. That is what lets the scan below keep using the
 * masked text as a coordinate system for line numbers.
 */
function maskedSource(source: string): string {
  const { code, spans } = blankLiteralsWithSpans(source);
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (!holdsRawStatement(source, span)) continue;
    pieces.push(code.slice(cursor, span.start), source.slice(span.start, span.end));
    cursor = span.end;
  }
  pieces.push(code.slice(cursor));
  return pieces.join("");
}

/**
 * Count occurrences of `needle` in `source`, ignoring comments and the contents
 * of every literal but a raw statement (see {@link maskedSource}).
 */
function countCodeOccurrences(source: string, needle: string | RegExp): number {
  const masked = maskedSource(source);
  if (typeof needle !== "string") return (masked.match(needle) ?? []).length;
  let count = 0;
  let idx = masked.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = masked.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * The nearest enclosing top-level declaration is the site's symbol. Column 0 is
 * deliberate: a raw lock statement always sits inside some top-level function, so
 * the last column-0 declaration above it names the unit that a refactor moves.
 */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var|class)\s+(\w+))/;

/** Framework-mandated handler names, which are not identities on their own. */
const ROUTE_HANDLER_SYMBOLS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** `src/app/api/x/[id]/route.ts` -> `/api/x/[id]`; anything else -> `null`. */
function routePathOf(rel: string): string | null {
  const match = /^src\/app\/(.*)\/route\.tsx?$/.exec(rel);
  if (!match) return null;
  const segments = (match[1] ?? "")
    .split("/")
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment));
  return `/${segments.join("/")}`;
}

/** Any acquisition of a transaction-scoped advisory lock, blocking or fail-fast. */
const ADVISORY_LOCK_CALL = /pg_(?:try_)?advisory_xact_lock\(/g;

/**
 * The first argument of a lock call, read across line breaks from the opening
 * parenthesis. Returns `null` when the call cannot be parsed — an unbalanced or
 * unterminated argument list — which the caller must treat as unclassifiable
 * rather than as anything in particular.
 *
 * Reading ACROSS lines is load-bearing, not tidiness. Both `pg_try_` sites this
 * repository already ships are written over three lines, so a line-local reader
 * is not an edge case here: it is the shape the codebase actually uses, and it
 * would score `SELECT pg_advisory_xact_lock(\n  1\n)` as a scoped key.
 */
function firstLockArgument(text: string, openParenIndex: number): string | null {
  let depth = 0;
  const limit = Math.min(text.length, openParenIndex + 2000);
  for (let i = openParenIndex; i < limit; i += 1) {
    const character = text[i];
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openParenIndex + 1, i);
      continue;
    }
    if (character === "," && depth === 1) return text.slice(openParenIndex + 1, i);
  }
  return null;
}

/**
 * FAIL CLOSED. An argument this scan cannot read is `UNCLASSIFIED`, which fails
 * the census, and is never quietly `SCOPED`.
 *
 * The direction matters because the two failure modes are not symmetric. Calling
 * a scoped key global costs a build failure and one line of registry. Calling a
 * global key scoped costs nothing at all at the time — it lands in a per-file
 * COUNT, which is the approval model #2722 exists to abolish, and the guard's own
 * remediation message is what tells the author to bump it. Only two shapes are
 * recognised, and everything else is handed to a human.
 */
function classifyLockArgument(argument: string | null): LockTier {
  if (argument === null) return "UNCLASSIFIED";
  const normalised = argument.replace(/\s+/g, "").replace(/::[A-Za-z0-9_]+$/, "");
  if (normalised === "1") return "GLOBAL";
  if (/^hashtext(?:extended)?\(/.test(normalised)) return "SCOPED";
  return "UNCLASSIFIED";
}

/**
 * Every raw advisory-lock acquisition in non-test `src/`, with its tier and its
 * stable identity.
 *
 * `pg_try_advisory_xact_lock` is scanned by the SAME matcher and classified by
 * the same argument reader as the blocking form, deliberately: a fail-fast
 * acquisition of key `1` is a Tier-2 acquisition. Matching the blocking spelling
 * alone left it in neither census — the tier test did not see it because the
 * anchored pattern failed, and the scoped count did not see it because
 * `pg_try_advisory_xact_lock(` does not contain the substring
 * `pg_advisory_xact_lock(`. Both censuses now derive from this one function, so
 * the two cannot disagree about what a site is again.
 */
function collectAdvisoryLockSites(
  sources: ReadonlyArray<{ rel: string; text: string }>,
): AdvisoryLockSite[] {
  const sites: AdvisoryLockSite[] = [];
  for (const { rel, text } of sources) {
    const routePath = routePathOf(rel);
    const ordinals = new Map<string, number>();

    // One masked copy of the whole file. It is the SAME LENGTH as the original
    // and every line break is where it was, so an offset in it still names a
    // line while the argument reader can cross line breaks.
    const maskedText = maskedSource(text);
    const maskedLines = maskedText.split("\n");
    const lineStarts: number[] = [];
    let offset = 0;
    for (const maskedLine of maskedLines) {
      lineStarts.push(offset);
      offset += maskedLine.length + 1;
    }
    const lineOf = (index: number): number => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((lineStarts[middle] ?? 0) <= index) low = middle;
        else high = middle - 1;
      }
      return low;
    };

    // The symbol is read line by line from the MASKED lines, which is what stops
    // a declaration written inside a comment opening a symbol: the comment is
    // spaces, and a column-0 anchor cannot match spaces. Re-testing the RAW line
    // for comment-ness — what this did before #3196 — only ever caught a comment
    // the private scanner recognised, and it recognised neither a trailing one
    // nor a block-comment body line without a leading star.
    const symbolByLine: string[] = [];
    let symbol = "(module scope)";
    maskedLines.forEach((maskedLine, index) => {
      const declaration = TOP_LEVEL_DECLARATION.exec(maskedLine);
      if (declaration) {
        symbol = declaration[1] ?? declaration[2] ?? symbol;
      }
      symbolByLine[index] = symbol;
    });

    for (const match of maskedText.matchAll(ADVISORY_LOCK_CALL)) {
      const index = match.index ?? 0;
      const lineIndex = lineOf(index);
      const siteSymbol = symbolByLine[lineIndex] ?? "(module scope)";
      const tier = classifyLockArgument(
        firstLockArgument(maskedText, index + match[0].length - 1),
      );
      const ordinal = (ordinals.get(siteSymbol) ?? 0) + 1;
      ordinals.set(siteSymbol, ordinal);
      const key =
        routePath !== null && ROUTE_HANDLER_SYMBOLS.has(siteSymbol)
          ? `${siteSymbol} ${routePath}#${ordinal}`
          : `${siteSymbol}#${ordinal}`;
      sites.push({
        rel,
        line: lineIndex + 1,
        symbol: siteSymbol,
        ordinal,
        tier,
        key,
        qualifiedKey: `${rel}::${siteSymbol}#${ordinal}`,
      });
    }
  }
  return sites;
}

/** The symbol half of a site key or a registry entry — the key without `#n`. */
function symbolOfKey(key: string): string {
  return key.replace(/#\d+$/, "");
}

/** Both accepted spellings of every site, so an entry may use either form. */
function indexSitesByKey(sites: readonly AdvisoryLockSite[]): Map<string, AdvisoryLockSite[]> {
  const byKey = new Map<string, AdvisoryLockSite[]>();
  const add = (key: string, site: AdvisoryLockSite) => {
    const existing = byKey.get(key);
    if (existing) existing.push(site);
    else byKey.set(key, [site]);
  };
  for (const site of sites) {
    add(site.key, site);
    if (site.qualifiedKey !== site.key) add(site.qualifiedKey, site);
  }
  return byKey;
}

/**
 * Every raw row-lock strength PostgreSQL offers, not just `FOR UPDATE` (#2623
 * T9(d)).
 *
 * The inventory used to match the literal `FOR UPDATE`, so the six non-test
 * `FOR KEY SHARE` statements this repository ships — the hosting queue
 * participant fence, the booking-request linked-member hold, the coverage drain's
 * claimed-identity lock, the hosting actor lock and the two Xero contact
 * reservations — appeared in NO counted inventory at all. They were exempt from
 * the "lock raw, read typed" rule in `raw-sql-shape-guard.test.ts` for the same
 * reason until that rule was widened. Nothing escaped: all six select a constant
 * through `$executeRaw`. But a seventh written as `$queryRaw` projecting columns
 * would have passed every gate — the exact #2289 failure mode.
 *
 * The two weaker modes are listed even though nothing uses them today, because
 * the point of a census is that a NEW site has to be classified rather than
 * merely written.
 */
const ROW_LOCK_STRENGTHS = /FOR (?:UPDATE|KEY SHARE|NO KEY UPDATE|SHARE)/g;

describe("advisory lock guard (#182 / H1 regression class)", () => {
  const sources = walk(SRC_DIR)
    .map((file) => ({
      rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
      text: fs.readFileSync(file, "utf8"),
    }))
    .filter(({ rel }) => !isTestFile(rel));

  it("keeps every canonical global pg_advisory_xact_lock(1) site in the reviewed per-site registry", () => {
    const sites = collectAdvisoryLockSites(sources);
    const byKey = indexSitesByKey(sites);
    const problems: string[] = [];

    // A registry that lists one site twice cannot be a census of anything.
    const registrations = new Map<string, number>();
    for (const entry of GLOBAL_LOCK_SITE_REGISTRY) {
      registrations.set(entry.site, (registrations.get(entry.site) ?? 0) + 1);
      if (!TWO_TIER_LOCK_INVARIANTS.includes(entry.invariant)) {
        problems.push(
          `BAD INVARIANT: "${entry.site}" cites ${entry.invariant}, which is not one of ${TWO_TIER_LOCK_INVARIANTS.join(", ")}.`,
        );
      }
      if (entry.reason.trim().length < 40) {
        problems.push(
          `THIN REASON: "${entry.site}" has no usable reason. Name the counterpart writer or the race that makes the narrow tier insufficient.`,
        );
      }
    }
    for (const [site, count] of registrations) {
      if (count > 1) {
        problems.push(
          `DUPLICATE ENTRY: "${site}" is registered ${count} times. One site, one entry — two reasons for one call site means neither can be trusted.`,
        );
      }
    }

    // Symbols whose site population is in question: an unregistered or
    // unclassifiable site, or an entry that no longer resolves cleanly. Every one
    // of them puts EVERY entry for that symbol in doubt — see the ordinal-shift
    // note below.
    const unsettledSymbols = new Set<string>();

    // Resolve every entry to exactly one live site.
    const claimedBy = new Map<string, string[]>();
    for (const entry of GLOBAL_LOCK_SITE_REGISTRY) {
      const matches = byKey.get(entry.site) ?? [];
      if (matches.length === 0) {
        unsettledSymbols.add(symbolOfKey(entry.site));
        problems.push(
          `STALE ENTRY: "${entry.site}" matches no advisory-lock site. The call was removed or renamed — delete the entry, or re-point it at the symbol that now holds the lock. A registry entry approving nothing is worse than no entry.`,
        );
        continue;
      }
      if (matches.length > 1) {
        unsettledSymbols.add(symbolOfKey(entry.site));
        problems.push(
          `AMBIGUOUS ENTRY: "${entry.site}" matches ${matches.length} sites (${matches
            .map((match) => `${match.rel}:${match.line}`)
            .join(
              ", ",
            )}). Use the file-qualified form so one reason binds to one call: ${matches
            .map((match) => `"${match.qualifiedKey}"`)
            .join(" / ")}.`,
        );
        continue;
      }
      const site = matches[0];
      if (!site) continue;
      if (site.tier !== entry.tier) {
        unsettledSymbols.add(symbolOfKey(entry.site));
        problems.push(
          `TIER CHANGED: "${entry.site}" is registered as ${entry.tier} but ${site.rel}:${site.line} now takes a ${site.tier} key. Re-classify the writer before updating the registry — a tier change is a lock-topology change, not an edit.`,
        );
      }
      const claims = claimedBy.get(site.qualifiedKey);
      if (claims) claims.push(entry.site);
      else claimedBy.set(site.qualifiedKey, [entry.site]);
    }
    for (const [qualifiedKey, claims] of claimedBy) {
      if (claims.length > 1) {
        problems.push(
          `DUPLICATE COVERAGE: ${qualifiedKey} is claimed by ${claims.length} entries (${claims
            .map((claim) => `"${claim}"`)
            .join(", ")}).`,
        );
      }
    }

    // Closed world: every Tier-2 acquisition must be one somebody approved, and
    // an acquisition nobody can classify is held to the same standard.
    for (const site of sites) {
      if (site.tier === "SCOPED") continue;
      if (site.tier === "UNCLASSIFIED") {
        unsettledSymbols.add(symbolOfKey(site.key));
        unsettledSymbols.add(symbolOfKey(site.qualifiedKey));
        problems.push(
          `UNCLASSIFIABLE lock argument: ${site.rel}:${site.line} in ${site.symbol} takes an advisory lock whose first argument this scan cannot read. It is treated as Tier 2 until a human says otherwise — write the key as the literal 1, or as hashtext(...)/hashtextextended(...), or classify it here explicitly. It is deliberately NOT counted as scoped.`,
        );
        continue;
      }
      if (claimedBy.has(site.qualifiedKey)) continue;
      unsettledSymbols.add(symbolOfKey(site.key));
      unsettledSymbols.add(symbolOfKey(site.qualifiedKey));
      const suggested =
        (byKey.get(site.key) ?? []).length === 1 ? site.key : site.qualifiedKey;
      problems.push(
        `UNREGISTERED Tier-2 site: ${site.rel}:${site.line} takes the global advisory key inside ${site.symbol}. Add { site: "${suggested}", tier: "GLOBAL", reason: "<which counterpart or race needs the global key>", invariant: "INV-LOCK-001" if this transaction takes the global key ALONE, or "INV-LOCK-002" if it also takes a scoped key such as acquireLodgeCapacityLock }.`,
      );
    }

    // THE ORDINAL SHIFT (#2688's hazard), in both directions. An ordinal is
    // stable only while the symbol's site population is. Insert a lock ahead of
    // existing ones and the report names the LAST call as unregistered; delete an
    // early one and it reports the TAIL as stale — and in both cases the entries
    // in between now describe calls they no longer match, silently, so doing
    // exactly what the message says re-approves them under the wrong reasons, or
    // deletes the wrong reason. Whenever a symbol's population is in question —
    // from either side, an unresolved site or an unresolved entry — every entry
    // for that symbol is named and has to be re-read.
    for (const unsettled of unsettledSymbols) {
      const affected = GLOBAL_LOCK_SITE_REGISTRY.filter(
        (entry) => symbolOfKey(entry.site) === unsettled,
      );
      if (affected.length === 0) continue;
      const population = sites.filter(
        (site) => symbolOfKey(site.key) === unsettled || symbolOfKey(site.qualifiedKey) === unsettled,
      ).length;
      problems.push(
        `ORDINAL SHIFT — RE-VERIFY EVERY ENTRY FOR "${unsettled}": it now holds ${population} advisory site(s), so the ordinals may have moved under the ${affected.length} existing entr${affected.length === 1 ? "y" : "ies"} (${affected
          .map((entry) => `"${entry.site}"`)
          .join(
            ", ",
          )}). Re-read each against the call it now names before adding or deleting one — renumbering is silent, and a reason bound to the wrong call is worse than no reason.`,
      );
    }

    expect(
      problems,
      "The canonical global pg_advisory_xact_lock(1) census failed (INV-LOCK-001, " +
        "INV-LOCK-002, INV-LOCK-003). Classify the writer using " +
        "docs/CONCURRENCY_AND_LOCKING.md: global-cohort lifecycle and settlement " +
        "money uses this canonical global key; capacity uses " +
        "acquireLodgeCapacityLock(tx, lodgeId); a writer doing both takes global " +
        "first, then per-lodge. Register the SITE with its own reason and PR " +
        "lock-impact evidence — never a bare count.",
    ).toEqual([]);
  });

  it("keeps every scoped advisory-lock family inside the reviewed inventory", () => {
    // Derived from the SAME scan as the Tier-2 census, not from an independent
    // substring count. The two disagreeing is what let a `pg_try_` acquisition of
    // the global key fall between them: the tier test read it as scoped, and the
    // substring count could not see it at all because
    // `pg_try_advisory_xact_lock(` does not contain `pg_advisory_xact_lock(`.
    const found: Record<string, number> = {};
    for (const site of collectAdvisoryLockSites(sources)) {
      if (site.tier !== "SCOPED") continue;
      found[site.rel] = (found[site.rel] ?? 0) + 1;
    }

    expect(
      found,
      "Scoped advisory-lock sites changed. Reconcile the key, counterpart " +
        "writers, and acquisition order in docs/CONCURRENCY_AND_LOCKING.md, " +
        "then update this inventory with PR compatibility evidence.",
    ).toEqual(SCOPED_ADVISORY_LOCK_INVENTORY);
  });

  it("keeps every SELECT row-lock protocol inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const count = countCodeOccurrences(text, ROW_LOCK_STRENGTHS);
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
      "Row-lock sites changed. Every strength counts (#2623 T9(d)): FOR " +
        "UPDATE, FOR NO KEY UPDATE, FOR SHARE and FOR KEY SHARE. Inventory " +
        "their counterpart writers and order against advisory and row locks " +
        "in docs/CONCURRENCY_AND_LOCKING.md.",
    ).toEqual(ROW_LOCK_SITE_INVENTORY);
  });

  it("keeps school held-reuse on global -> lodge -> re-read -> guarded claim", () => {
    const school = sources.find(
      ({ rel }) => rel === "src/lib/school-booking-request.ts",
    )?.text;
    expect(school).toBeDefined();

    const approvalStart =
      school?.indexOf("export async function approveSchoolBookingRequest") ?? -1;
    const approvalEnd =
      school?.indexOf("export type MemberWholeLodgeApprovalOverride") ?? -1;
    const approval = school?.slice(approvalStart, approvalEnd) ?? "";
    const locator = approval.indexOf("const heldLodgeLocator = expectedHeldBookingId");
    const transaction = approval.indexOf("conversion = await prisma.$transaction");
    const globalLock = approval.indexOf("pg_advisory_xact_lock(1)");
    const heldKey = approval.indexOf("expectedHeldLodgeId!", globalLock);
    const lodgeLock = approval.indexOf("acquireLodgeCapacityLock(tx, bookingLodgeId)");
    const requestReread = approval.indexOf(
      "const lockedRequest = await tx.bookingRequest.findUnique",
    );
    const heldReread = approval.indexOf("held = await tx.booking.findUnique");
    const heldClaim = approval.indexOf("const heldClaim = await tx.booking.updateMany");
    const firstSideEffect = approval.indexOf(
      "const guestCreates = await buildApprovalGuestCreates",
    );

    for (const marker of [
      locator,
      transaction,
      globalLock,
      heldKey,
      lodgeLock,
      requestReread,
      heldReread,
      heldClaim,
      firstSideEffect,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(approval.match(/pg_advisory_xact_lock\(1\)/g) ?? []).toHaveLength(1);
    expect(locator).toBeLessThan(transaction);
    expect(transaction).toBeLessThan(globalLock);
    expect(globalLock).toBeLessThan(heldKey);
    expect(heldKey).toBeLessThan(lodgeLock);
    expect(globalLock).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(requestReread);
    expect(requestReread).toBeLessThan(heldReread);
    expect(heldReread).toBeLessThan(heldClaim);
    expect(heldClaim).toBeLessThan(firstSideEffect);
    expect(approval).toContain("if (heldClaim.count === 0)");
    expect(approval).toContain("request.lodgeId !== held.lodgeId");
    expect(approval).toContain("lodgeId: conversion.lodgeId");
  });

  it("binds generic held conversion to the immutable held-booking lodge", () => {
    const generic = sources.find(
      ({ rel }) => rel === "src/lib/booking-request.ts",
    )?.text;
    expect(generic).toBeDefined();

    const approval =
      generic?.slice(
        generic.indexOf("export async function approveBookingRequest"),
      ) ?? "";
    const locator = approval.indexOf("const heldLodgeLocator = expectedHeldBookingId");
    const transaction = approval.indexOf("conversion = await prisma.$transaction");
    const globalLock = approval.indexOf("pg_advisory_xact_lock(1)", transaction);
    const heldKey = approval.indexOf("expectedHeldLodgeId!", globalLock);
    const lodgeLock = approval.indexOf("acquireLodgeCapacityLock(tx, requestLodgeId)");
    const requestReread = approval.indexOf(
      "const lockedRequest = await tx.bookingRequest.findUnique",
    );
    const heldReread = approval.indexOf("held = await tx.booking.findUnique");
    const guardedConversion = approval.indexOf("const converted = await tx.booking.updateMany");

    for (const marker of [
      locator,
      transaction,
      globalLock,
      heldKey,
      lodgeLock,
      requestReread,
      heldReread,
      guardedConversion,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(locator).toBeLessThan(transaction);
    expect(globalLock).toBeLessThan(heldKey);
    expect(heldKey).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(requestReread);
    expect(requestReread).toBeLessThan(heldReread);
    expect(heldReread).toBeLessThan(guardedConversion);
    expect(approval).toContain("request.lodgeId !== held.lodgeId");
    expect(approval).toContain("lodgeId: conversion.lodgeId");
  });

  it("mints the per-lodge capacity key only in lodge-capacity-lock.ts", () => {
    const offenders = sources
      .filter(({ rel }) => rel !== CAPACITY_LOCK_MINT)
      .filter(({ text }) => countCodeOccurrences(text, "hashtextextended") > 0)
      .map(({ rel }) => rel);

    expect(
      offenders,
      "hashtextextended found outside src/lib/lodge-capacity-lock.ts. The per-lodge " +
        "capacity key must only be constructed by acquireLodgeCapacityLock so " +
        "every participant provably shares one key — call the helper instead " +
        "of rebuilding the expression (INV-LOCK-002)."
    ).toEqual([]);
  });
});

/*
  THE MASKING RULE ITSELF, PINNED (#3196).

  This census used to own the last private comment scanner in the tree, and the
  reason it kept one was real: it hunts raw SQL, which lives inside string
  literals, while the prose it must ignore lives inside string literals too.
  Blanking everything hides the evidence; blanking nothing counts a sentence
  describing `FOR UPDATE` as a lock. #3196 moved the lexing to the shared
  `blankLiteralsWithSpans` and kept only the CHOICE here — which is a policy
  about SQL, and belongs to the census rather than to a general-purpose helper.

  These cases are what make that move checkable. Each is a shape the retired
  line-local scanner got WRONG or could only get right by accident, and every
  one of them is stated as behaviour rather than as a count, so a future edit to
  `holdsRawStatement` fails here and not four inventories away.
*/
describe("the masking rule (#3196, INV-SSOT-004)", () => {
  const rowLocks = (source: string): number =>
    countCodeOccurrences(source, ROW_LOCK_STRENGTHS);

  it("counts a raw statement in a backtick template", () => {
    expect(
      rowLocks("await tx.$executeRaw`SELECT 1 FROM x FOR UPDATE`;"),
    ).toBe(1);
  });

  it("counts a raw statement in a double-quoted literal, because $executeRawUnsafe takes one", () => {
    // #2623 F7. `const SQL = "SELECT … FOR UPDATE"` reaches the database, and a
    // masker that suppressed every double-quoted literal would score it ZERO and
    // drop a real lock out of the census silently.
    expect(rowLocks('const SQL = "SELECT 1 FROM x FOR UPDATE";')).toBe(1);
  });

  it("does not count PROSE about a statement in a double-quoted literal", () => {
    // #2623 T9(d), live in `adult-member-hosting-queue-participants.ts`.
    expect(
      rowLocks('throw new Error("never issued without its FOR KEY SHARE lock");'),
    ).toBe(0);
  });

  it("does not count a TRAILING comment, which the retired scanner never dropped", () => {
    // The private scanner decided comment-ness from the START of a line, so a
    // comment after code was read as code. Both of the next two cases scored 1
    // before #3196 and are the clearest evidence the swap changed the instrument.
    expect(rowLocks("const x = 1; // takes the row FOR UPDATE first")).toBe(0);
  });

  it("does not count a block-comment body line that has no leading star", () => {
    expect(rowLocks("/*\n  the merge takes it FOR UPDATE\n*/\nconst x = 1;")).toBe(0);
  });

  it("is not blinded by a regex literal containing a quote", () => {
    // THE #3155 DEFECT, which #3180 found LIVE in a sibling census where it hid a
    // real database write five hundred lines below the regex. `xero-contacts.ts`
    // writes `.replace(/"/g, "")` AND takes two scoped advisory locks after it,
    // so this census only ever escaped that fate by being line-local — which is
    // an accident of a limitation, not a defence.
    const source = [
      'const q = input.fullName.replace(/"/g, "");',
      "await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;",
      'const sql = "SELECT 1 FROM x FOR UPDATE";',
    ].join("\n");

    expect(rowLocks(source)).toBe(1);
    const sites = collectAdvisoryLockSites([{ rel: "src/lib/probe.ts", text: source }]);
    expect(sites.map((site) => site.tier)).toEqual(["GLOBAL"]);
  });

  it("counts a raw statement in a SINGLE-quoted literal too", () => {
    // The rule is quote-agnostic because the blanker reports both quotes as
    // `kind: "string"`. Pinned because the prose above was for a while written
    // as if only the double-quoted spelling were in scope, and a reader who
    // believed that would think `$executeRawUnsafe('SELECT … FOR UPDATE')` went
    // uncounted. It does not.
    expect(rowLocks("const SQL = 'SELECT 1 FROM x FOR UPDATE';")).toBe(1);
    expect(rowLocks("throw new Error('never issued without its FOR KEY SHARE lock');")).toBe(0);
  });

  it("does not count a needle that only appears inside a regex", () => {
    // A pattern is not a statement. `blankLiteralsWithSpans` reports the regex
    // body as its own kind and `holdsRawStatement` refuses it.
    expect(rowLocks('const re = /FOR UPDATE/;')).toBe(0);
  });

  /*
    THE MODULE CONTRACT THIS CENSUS RESTS ON, asserted here rather than assumed.
    Restoring a span only leaves line numbers and columns intact because a span
    is exactly as long as the spaces standing in for it. If that ever stopped
    being true, every line number this census reports would drift and nothing
    else in the tree would notice.
  */
  it("restores spans without moving a single offset", () => {
    const source = [
      "/* a docblock naming FOR UPDATE */",
      'const message = "prose about FOR KEY SHARE";',
      "const sql = `SELECT 1 FROM x FOR UPDATE`;",
      'const re = /"/g;',
      "await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`; // trailing",
    ].join("\n");

    const { code, spans } = blankLiteralsWithSpans(source);
    expect(code).toBe(blankLiterals(source));
    expect(code.length).toBe(source.length);
    expect(maskedSource(source).length).toBe(source.length);

    // Restoring EVERY span must reproduce the file byte for byte: that is what
    // says the spans are the complete account of what was blanked.
    const pieces: string[] = [];
    let cursor = 0;
    for (const span of spans) {
      expect(span.start).toBeGreaterThanOrEqual(cursor);
      pieces.push(code.slice(cursor, span.start), source.slice(span.start, span.end));
      cursor = span.end;
    }
    pieces.push(code.slice(cursor));
    expect(pieces.join("")).toBe(source);
  });

  /*
    A SPAN NEVER ENDS PAST THE SOURCE — the other half of the contract the
    restore above rests on, and the half that used to be breakable.
    `blankTemplateLiteral` and `endOfRegexLiteral` each step TWO characters over
    an escape, so a file whose last character is a backslash left the cursor one
    PAST the end and reported a span addressing a character that does not exist.
    Slicing survived it, because both slices clamp on their own — which is
    precisely why it needs a test: it was invisible to `maskedSource` and would
    have surfaced only in a caller doing ARITHMETIC on `end`.
  */
  it("never reports a span that ends past the end of the source", () => {
    const sources = [
      "`ab\\", // an unterminated template whose last character escapes
      "const re = /a\\", // the same shape in a regex literal
      'const s = "ab\\', // the string branch, which has always clamped
      "/* an unterminated block comment",
      "// an unterminated line comment",
    ];

    for (const source of sources) {
      const { code, spans } = blankLiteralsWithSpans(source);
      expect(code.length, source).toBe(source.length);

      for (const span of spans) {
        expect(
          span.end,
          `${JSON.stringify(source)} reported a ${span.kind} span ending at ${span.end}, outside a ${source.length}-character source. A span addresses the ORIGINAL text, so a caller may do arithmetic on it and not only slice with it.`,
        ).toBeLessThanOrEqual(source.length);
        expect(span.start, JSON.stringify(source)).toBeLessThanOrEqual(span.end);
      }
    }
  });

  it("keeps a lock site on the line it is written on", () => {
    const source = [
      "// a comment",
      "/* a block\n   comment */",
      'const label = "prose";',
      "await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;",
    ].join("\n");
    const sites = collectAdvisoryLockSites([{ rel: "src/lib/probe.ts", text: source }]);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.line).toBe(source.split("\n").findIndex((line) => line.includes("pg_advisory")) + 1);
  });
});
