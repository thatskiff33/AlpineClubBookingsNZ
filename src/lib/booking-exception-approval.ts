import type { AgeTier, BookingStatus } from "@prisma/client";
import type { CalendarDate } from "@/lib/club-time";

import { addDaysDateOnly, parseDateOnly } from "@/lib/date-only";
import { storedDateOnly } from "@/lib/stored-calendar-day";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import { resolveHostingCoverageIncidents } from "@/lib/adult-member-hosting-coverage-incidents";
import { recordAdultMemberHostingReviewDecision } from "@/lib/adult-member-hosting-review";
import { createConfirmedBooking } from "@/lib/booking-create";
import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import {
  assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  planMemberGuestConsentWrites,
  type MemberGuestAddPolicy,
  type MemberGuestConsentWritePlanEntry,
} from "@/lib/member-guest-add-policy";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { sendBookingPolicyExceptionApprovedEmail } from "@/lib/email";
import { BOOKABLE_AGE_TIER_VALUES } from "@/lib/age-tier-schema";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import { calculateBookingHoldDecision } from "@/lib/policies/booking-route-decisions";
import {
  DEFAULT_BOOKING_PAYMENT_METHOD,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
import type { GuestStayRange } from "@/lib/booking-guest-stay-ranges";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify-validation";
import type { HostingCoverageOverrideInput } from "@/lib/adult-member-hosting-same-owner";
import {
  CAPACITY_CONFLICT_MESSAGE,
  type ConfirmedOverride,
  type LoadedPolicyExceptionRequest,
  type PolicyExceptionApprovalHooks,
} from "@/lib/booking-exception-execution";
import {
  computeProposalHash,
  type ExceptionProposalSnapshot,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
  type ProposalGuest,
  type ProposalParty,
} from "@/lib/booking-exception-requests";
import {
  buildModificationProposalParties,
  evaluateProposalPartyViolations,
  parseStoredExceptionDelta,
  type LiveBookingGuestInput,
  type ModificationDeltaInput,
} from "@/lib/booking-exception-request-service";
import type { PolicyExceptionViolation } from "@/lib/booking-policy-exceptions";

/**
 * #2526 — the REAL {@link PolicyExceptionApprovalHooks} the admin approval route
 * hands to #2525's atomic approve-and-execute engine.
 *
 * #2525 owns the concurrency mechanics (lock order, fresh-role reauthorization,
 * guarded version CAS, drift gate, capacity recheck, atomic reservation release,
 * post-commit hand-off) behind an injected seam. This module is the other side
 * of that seam: the hooks, wired to the real permission model, the real policy
 * evaluators, the real capacity engine and the real canonical booking services.
 *
 * Everything here runs INSIDE the approval transaction, on the `tx` the engine
 * supplies, under the global lock(1) + per-lodge capacity lock the engine has
 * already taken — so nothing in this file may reach for the module Prisma client
 * (a second pool connection beneath those locks is the shape
 * docs/CONCURRENCY_AND_LOCKING.md forbids). The two reads that genuinely need
 * the module client are both OUTSIDE it: the club's hold policy and the
 * member-guest policy, resolved BEFORE the transaction by
 * {@link resolveNewBookingExecutionParams} and handed in; and the created
 * booking `notifyApproved` reads, which the engine calls only AFTER its commit,
 * with every lock already released.
 *
 * The three contracts #2525's reviews pinned, and where they live here:
 *
 *  1. `recheckCapacity` checks the FULL proposed party and EXCLUDES the live
 *     booking for a modification, mirroring the admission check the request
 *     service ran when the hold was taken. It never checks "the delta on top of
 *     the live base": that would double-count the live booking and
 *     false-keep-pending an approval that should execute.
 *  2. `executeApprovedProposal` is a HARD capacity refusal. It never passes
 *     `confirmOverCapacity`, never sets `adminOverride`, and turns
 *     `createConfirmedBooking`'s non-throwing `capacityExceeded` outcome into a
 *     THROW so the whole approval transaction rolls back instead of committing a
 *     claim with no booking behind it.
 *  3. `verifyLiveProposalIntegrity` is ALWAYS supplied (the engine fails closed
 *     for a modification without it) and is the gate proving the live booking
 *     still matches the reviewed base AND that the stored delta still reproduces
 *     the reviewed proposal.
 */

// ---------------------------------------------------------------------------
// Errors the route maps to HTTP
// ---------------------------------------------------------------------------

/**
 * The canonical create service reported `capacityExceeded` while executing an
 * approved NEW-booking proposal. Thrown (not returned) so Prisma rolls the whole
 * approval back: the request stays REQUESTED at its original version and the
 * officer is told the lodge is full — the same outcome, and the same honesty, as
 * #2525's in-engine kept-pending path.
 *
 * This can never be a FALSE keep-pending: when it throws, nothing has become
 * authoritative. The status claim, the reservation release and every row the
 * canonical service wrote are all inside the transaction being rolled back.
 */
export class PolicyExceptionExecutionCapacityError extends Error {
  constructor(readonly fullNights: string[]) {
    super(CAPACITY_CONFLICT_MESSAGE);
    this.name = "PolicyExceptionExecutionCapacityError";
  }
}

/**
 * The approval reached execution without a verified replayable delta, or without
 * the pre-resolved new-booking execution parameters. Only reachable through a
 * wiring bug — the engine always runs `verifyLiveProposalIntegrity` before
 * `executeApprovedProposal` for a modification — so it fails LOUDLY rather than
 * executing something unverified.
 */
export class PolicyExceptionUnverifiedExecutionError extends Error {
  constructor(detail: string) {
    super(`A policy-exception approval reached execution unverified: ${detail}`);
    this.name = "PolicyExceptionUnverifiedExecutionError";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const BOOKABLE_AGE_TIERS = new Set<string>(BOOKABLE_AGE_TIER_VALUES);

/** The proposed party as capacity-engine guest ranges (explicit night sets). */
function proposedGuestRanges(party: ProposalParty): GuestStayRange[] {
  return party.guests.map((guest) => ({ nights: [...guest.nights] }));
}

/**
 * The stay envelope of a frozen party, as real dates. The envelope is stored ON
 * the party (the min/max of its guest nights at freeze time), so this reads it
 * rather than re-deriving it — a re-derivation could disagree with what was
 * reviewed.
 */
function partyEnvelope(party: ProposalParty): { checkIn: Date; checkOut: Date } {
  return {
    checkIn: parseDateOnly(party.checkIn),
    checkOut: parseDateOnly(party.checkOut),
  };
}

/**
 * The window a capacity check must cover for a frozen party: the UNION of the
 * stored envelope and every frozen guest night.
 *
 * `checkCapacityForGuestRanges` only iterates nights inside the window it is
 * given, so deriving it from the stored envelope alone silently skipped any
 * frozen guest night outside that envelope (#2526 review). A freeze now expands
 * the envelope to cover its guests, so in practice the two agree — but a stored
 * snapshot is DATA, and the engine's stated contract is that it asserts capacity
 * itself rather than trusting the executor seam, so it must not depend on the
 * freeze having been well-formed. Widening can only ever make the check stricter.
 */
function partyCapacityWindow(party: ProposalParty): {
  checkIn: Date;
  checkOut: Date;
} {
  const envelope = partyEnvelope(party);
  const nights = party.guests.flatMap((guest) => guest.nights);
  if (nights.length === 0) return envelope;
  const sorted = [...new Set(nights)].sort();
  const firstNight = parseDateOnly(sorted[0]);
  const afterLastNight = addDaysDateOnly(parseDateOnly(sorted[sorted.length - 1]), 1);
  return {
    checkIn: firstNight < envelope.checkIn ? firstNight : envelope.checkIn,
    checkOut: afterLastNight > envelope.checkOut ? afterLastNight : envelope.checkOut,
  };
}

/** Did the approval review — and does it still uphold — the hosting rule? */
function overridesAdultMemberHosting(override: ConfirmedOverride): boolean {
  return override.overridable.some(
    (entry) => entry.reasonCode === "ADULT_MEMBER_HOSTING_REQUIRED",
  );
}

/**
 * The audit-grade sentence recorded wherever this approval overrode a rule. It
 * names the request and every reason code that was still tripping, so "who let
 * this through, and why" is answerable from the booking alone.
 */
export function buildOverrideReason(args: {
  requestId: string;
  override: ConfirmedOverride;
  adminNotes?: string | null;
}): string {
  const codes = args.override.overridable
    .map((entry) => entry.reasonCode)
    .join(", ");
  const note = args.adminNotes?.trim();
  const base = `Booking-policy exception approved (request ${args.requestId}): ${
    codes || "no rule still tripping"
  }`;
  return note ? `${base}. ${note}` : base;
}

// ---------------------------------------------------------------------------
// Fresh-DB reauthorization
// ---------------------------------------------------------------------------

type ReauthorizationDb = Pick<PrismaTransactionClient, "member">;

/**
 * Re-read the officer's CURRENT roles from the database and decide whether they
 * may approve a booking-policy exception.
 *
 * NEVER the session snapshot: a session token can be minutes old, and an officer
 * whose access was revoked between opening the queue and clicking Approve must
 * not execute a booking. The requirement is `bookings: edit` — the same gate the
 * rest of the booking-decision surface uses — plus an active, login-capable
 * account that is not mid password-reset remediation.
 */
export async function reauthorizeBookingOfficerFromDb(
  db: ReauthorizationDb,
  actorMemberId: string,
): Promise<boolean> {
  const member = await db.member.findUnique({
    where: { id: actorMemberId },
    select: {
      active: true,
      canLogin: true,
      forcePasswordChange: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
    },
  });
  if (!member?.active) return false;
  if (member.forcePasswordChange) return false;
  return hasAdminAreaAccess(
    { canLogin: member.canLogin, accessRoles: member.accessRoles },
    { area: "bookings", level: "edit" },
  );
}

// ---------------------------------------------------------------------------
// Live-booking integrity
// ---------------------------------------------------------------------------

/**
 * Load the live booking's guests in exactly the shape the request route froze
 * them in, so a replayed base is comparable byte-for-byte with the frozen one.
 */
async function loadLiveBookingForIntegrity(
  tx: PrismaTransactionClient,
  bookingId: string,
): Promise<{
  checkIn: Date;
  checkOut: Date;
  liveGuests: LiveBookingGuestInput[];
} | null> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          isMember: true,
          memberId: true,
          stayStart: true,
          stayEnd: true,
          // The stored explicit night set (#713). Without it the replay flattens
          // a sparse stay to its envelope and can never reproduce the frozen
          // hash for such a booking (#2526 review).
          nights: { select: { stayDate: true } },
        },
      },
    },
  });
  if (!booking) return null;
  // CT-4 (#2870), and THE OTHER HALF OF A FRAME PAIR: these five decodes must
  // stay spelled exactly as `/api/bookings/[id]/exception-requests` spells them
  // when it FREEZES the proposal, because the replay below re-hashes the result
  // and compares it to the frozen hash. They diverged once — the route decoded
  // the stored calendar days in UTC while this still projected them through
  // `APP_TIME_ZONE` — and for any club behind Greenwich the replayed base came
  // back a day early, so `verifyLiveProposalIntegrity` reported `drift` on a
  // booking nobody had touched. The officer was told to ask the member to
  // resubmit, and the resubmitted request reproduced it: no modification policy
  // exception could ever be approved. Change one side and you must change both.
  return {
    checkIn: storedDateOnly(booking.checkIn),
    checkOut: storedDateOnly(booking.checkOut),
    liveGuests: booking.guests.map((guest) => ({
      id: guest.id,
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId,
      stayStart: storedDateOnly(guest.stayStart),
      stayEnd: storedDateOnly(guest.stayEnd),
      nights: guest.nights.map((night) => ({
        stayDate: storedDateOnly(night.stayDate),
      })),
    })),
  };
}

/**
 * Turn one frozen proposal guest into a canonical-create guest input.
 *
 * The frozen night list is authoritative and is passed through explicitly
 * (#713), so a non-contiguous stay survives the round-trip; `stayStart`/`stayEnd`
 * are its min/max envelope, exactly as the create service expects. An age tier
 * that is not bookable is refused rather than coerced — a stored snapshot is
 * data, and data that cannot be executed must fail closed.
 */
export function proposalGuestToCreateInput(guest: ProposalGuest) {
  if (!BOOKABLE_AGE_TIERS.has(guest.ageTier)) {
    throw new Error(
      `Frozen proposal guest has a non-bookable age tier: ${guest.ageTier}`,
    );
  }
  const nights = [...new Set(guest.nights)].sort();
  if (nights.length === 0) {
    throw new Error("Frozen proposal guest occupies no nights");
  }
  const stayStart = parseDateOnly(nights[0]);
  const stayEnd = parseDateOnly(nights[nights.length - 1]);
  stayEnd.setUTCDate(stayEnd.getUTCDate() + 1);
  return {
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    ...(guest.memberId ? { memberId: guest.memberId } : {}),
    stayStart,
    stayEnd,
    // Plain `yyyy-mm-dd` strings rather than `{ stayDate }` rows: both are valid
    // `GuestNightInput`s, and the flat form is also what the member-guest
    // authorisation pipeline's own guest type accepts, so one shape serves both.
    nights,
  };
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

export interface PolicyExceptionApprovalContext {
  /** The request being decided — the hooks read their own row from it. */
  requestId: string;
  /**
   * The CLUB's calendar day (`INV-CONFIG-002`), resolved by the route BEFORE
   * `approveAndExecutePolicyExceptionRequest` opened its transaction.
   *
   * #3123 review, `INV-LOCK-004`. The two canonical services this approval
   * executes — `modifyBookingBatch` and `createConfirmedBooking` — are both
   * transaction-AWARE, and this is the ONE path that supplies them a caller
   * transaction. By the time either runs, `pg_advisory_xact_lock(1)` and the
   * per-lodge capacity key are held, so neither may read the club's persisted
   * zone for itself: a `clubTimeSettings` query on the module client would need
   * a second pooled connection under both locks, and under concurrency every
   * transaction ends up holding one connection and waiting for another that
   * only a commit can free.
   *
   * The whole approval therefore acts on ONE club day, which is also the right
   * answer on its own terms: an approval that priced a change fee on one day
   * and a refund tier on another would be internally inconsistent across club
   * midnight.
   */
  todayAtClub: CalendarDate;
  /** The officer approving; re-read from the DB inside the transaction. */
  actorMemberId: string;
  /** Recorded on the canonical services' audit rows. */
  ipAddress: string;
  /**
   * The officer's MEMBER-FACING decision explanation, if they left one (#2562).
   * Persisted to `adminNotes` and interpolated into the approval email, both of
   * which the member reads — the officer UI says so before they submit it.
   */
  adminNotes?: string | null;
  /**
   * The officer's PRIVATE note, if they left one (#2562). Persisted to
   * `internalNotes` and read ONLY by admin-guarded surfaces. Deliberately NOT
   * passed to any email template, notification or member projection: the member
   * DTO has no field for it, and the approval email below composes its optional
   * line from `adminNotes` alone.
   */
  internalNotes?: string | null;
  /**
   * How a refund arising from the executed modification is settled (card refund
   * or account credit). Not part of the reviewed proposal — the proposal decides
   * WHAT changes, this decides how the resulting money moves — and required only
   * when the canonical service says the change needs one.
   */
  settlementMethod?: BookingModificationSettlementMethod;
  /**
   * A second-step Booking Officer acknowledgement for same-owner bookings that
   * the approved modification would strand. Separate from `adminNotes`: this is
   * private operational authority and its own mandatory reason.
   */
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
  /**
   * The member's own words from the request. Carried through as the booking's
   * `memberReviewJustification` so an adult-supervision review this approval
   * opens (see `reviewedMemberProposal`) records why the MEMBER says they are
   * doing it, rather than nothing at all.
   */
  memberMessage?: string | null;
  /**
   * NEW-booking execution parameters resolved BEFORE the transaction opened by
   * {@link resolveNewBookingExecutionParams}. Required for a new-booking
   * approval; ignored for a modification.
   */
  newBookingExecution?: {
    status: BookingStatus;
    shouldBePending: boolean;
    holdDays: number;
    paymentMethod: BookingPaymentMethod;
    /**
     * The "+ Add Member Guest" policy (epic #2305), read on the module client
     * before the transaction opened — the ordering rule in
     * `member-guest-add-policy.ts`. The new-booking executor needs it to run the
     * same member-guest authorisation the member's own create route runs.
     */
    memberGuestPolicy: MemberGuestAddPolicy;
  };
}

/** What the approval actually did, for the route's audit record. */
export interface PolicyExceptionApprovalOutcome {
  createdBookingId: string | null;
  hostingDecisionRecorded: boolean;
}

export interface PolicyExceptionApprovalHookSet {
  hooks: PolicyExceptionApprovalHooks;
  outcome: PolicyExceptionApprovalOutcome;
}

/**
 * Build the real hooks for ONE approval attempt.
 *
 * The returned set is SINGLE-SHOT: `verifyLiveProposalIntegrity` caches the delta
 * it verified so `executeApprovedProposal` replays exactly that one, and the
 * executor refuses to run when the cache is empty. Build a fresh set per attempt.
 */
export function buildPolicyExceptionApprovalHooks(
  context: PolicyExceptionApprovalContext,
): PolicyExceptionApprovalHookSet {
  let verifiedDelta: ModificationDeltaInput | null = null;
  const outcome: PolicyExceptionApprovalOutcome = {
    createdBookingId: null,
    hostingDecisionRecorded: false,
  };

  const hooks: PolicyExceptionApprovalHooks = {
    async reauthorizeBookingOfficer(tx, actorMemberId) {
      return reauthorizeBookingOfficerFromDb(tx, actorMemberId);
    },

    async evaluateCurrentViolations(
      snapshot: ExceptionProposalSnapshot,
      tx: PrismaTransactionClient,
      request: LoadedPolicyExceptionRequest,
    ): Promise<PolicyExceptionViolation[]> {
      // The SAME evaluator the request froze its evidence with, run on `tx`
      // against today's policy configuration. Any difference is a genuine
      // policy-config change, which #2525's drift gate classifies.
      return evaluateProposalPartyViolations(
        tx,
        snapshot.lodgeId,
        snapshot.proposed,
        {
          requestedByMemberId: request.requestedByMemberId,
          bookingId:
            snapshot.kind === "MODIFICATION" ? snapshot.bookingId : null,
        },
      );
    },

    async recheckCapacity(snapshot, tx) {
      // THE CONTRACT (#2525 handoff item 1): check the FULL proposed party and,
      // for a modification, EXCLUDE the live booking. Excluding it makes the
      // full-party check exactly an incremental-headroom check against a
      // capacity-holding base, and the correct full-footprint check against a
      // non-holding one (its id simply is not in the occupancy population). The
      // alternative — counting the live base and checking only the delta —
      // double-counts and false-keeps-pending approvals that should execute.
      //
      // The request's OWN provisional reservation is not excluded and does not
      // need to be: #2525 calls this AFTER releasing it (HOLD) or when there
      // never was one (NO_HOLD).
      const { checkIn, checkOut } = partyCapacityWindow(snapshot.proposed);
      const capacity = await checkCapacityForGuestRanges(
        snapshot.lodgeId,
        checkIn,
        checkOut,
        proposedGuestRanges(snapshot.proposed),
        snapshot.kind === "MODIFICATION" ? snapshot.bookingId : undefined,
        tx,
      );
      return capacity.available
        ? { ok: true }
        : { ok: false, message: CAPACITY_CONFLICT_MESSAGE };
    },

    async verifyLiveProposalIntegrity(snapshot, tx) {
      // A new-booking proposal has no live base to drift against; the engine's
      // tamper hash over the frozen snapshot is the whole integrity story.
      if (snapshot.kind !== "MODIFICATION") return { intact: true };

      const row = await tx.bookingChangeRequest.findUnique({
        where: { id: context.requestId },
        select: { requestedChanges: true },
      });
      const delta = parseStoredExceptionDelta(row?.requestedChanges);
      // A request stored before the delta existed (#2524 shipped ahead of #2526,
      // so in-flight rows exist), or one whose delta was hand-edited into
      // nonsense, cannot be executed against the canonical service. Fail closed
      // — but say WHY: "the live booking has changed" is untrue for a row that
      // simply predates the format, and it sends the officer looking for an edit
      // that never happened (#2526 review).
      if (!delta) {
        return { intact: false, reason: "unreplayable" };
      }

      const live = await loadLiveBookingForIntegrity(tx, snapshot.bookingId);
      if (!live) return { intact: false, reason: "drift" };

      // Replay the stored delta against the LIVE booking and require the result
      // to hash to the frozen proposal. This one equality proves both halves at
      // once: the live base still matches what was reviewed, AND the delta still
      // produces the proposal that was reviewed. Either kind of drift changes the
      // hash and refuses the approval.
      const replayed = buildModificationProposalParties({
        bookingCheckIn: live.checkIn,
        bookingCheckOut: live.checkOut,
        liveGuests: live.liveGuests,
        delta,
      });
      const replayedSnapshot: ModificationProposalSnapshot = {
        kind: "MODIFICATION",
        lodgeId: snapshot.lodgeId,
        bookingId: snapshot.bookingId,
        base: replayed.base,
        proposed: replayed.proposed,
      };
      if (computeProposalHash(replayedSnapshot) !== computeProposalHash(snapshot)) {
        return { intact: false, reason: "drift" };
      }
      verifiedDelta = delta;
      return { intact: true };
    },

    /**
     * Tell the member their NEW-booking request was approved, AFTER the commit.
     *
     * The canonical create service emails only a $0 confirmation or a non-member
     * hold notice, so an approved exception landing on PAYMENT_PENDING told the
     * member nothing at all — and PAYMENT_PENDING holds no beds, so the stay
     * could be filled or reaped while they had no idea they had one (#2526
     * review). A MODIFICATION needs nothing here: `modifyBookingBatch` sends the
     * canonical "your booking was changed" email itself, and a second notice
     * would compete with it.
     */
    async notifyApproved(request) {
      const bookingId = outcome.createdBookingId;
      if (!bookingId) return;
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          finalPriceCents: true,
          lodgeId: true,
          status: true,
          member: { select: { id: true, email: true, firstName: true } },
          guests: { select: { id: true } },
          payment: { select: { status: true } },
        },
      });
      if (!booking?.member?.email) return;
      // What is still owed: the whole price unless the create already settled it
      // ($0 / fully credit-covered bookings reach PAID or CONFIRMED and send
      // their own confirmation).
      const settled =
        booking.status === "PAID" ||
        booking.status === "CONFIRMED" ||
        booking.payment?.status === "SUCCEEDED";
      await sendBookingPolicyExceptionApprovedEmail(
        { bookingId: booking.id, recipientMemberId: booking.member.id },
        booking.member.email,
        {
          firstName: booking.member.firstName,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guestCount: booking.guests.length,
          amountDueCents: settled ? 0 : booking.finalPriceCents,
          adminNotes: context.adminNotes ?? null,
          lodgeId: booking.lodgeId,
        },
      );
      void request;
    },

    async executeApprovedProposal({ tx, request, snapshot, override }) {
      const overrideReason = buildOverrideReason({
        requestId: request.id,
        override,
        adminNotes: context.adminNotes,
      });

      if (snapshot.kind === "MODIFICATION") {
        return executeApprovedModification({
          tx,
          request,
          snapshot,
          override,
          overrideReason,
          context,
          delta: verifiedDelta,
          outcome,
        });
      }
      return executeApprovedNewBooking({
        tx,
        request,
        snapshot,
        override,
        overrideReason,
        context,
        outcome,
      });
    },
  };

  return { hooks, outcome };
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

async function executeApprovedModification(args: {
  tx: PrismaTransactionClient;
  request: LoadedPolicyExceptionRequest;
  snapshot: ModificationProposalSnapshot;
  override: ConfirmedOverride;
  overrideReason: string;
  context: PolicyExceptionApprovalContext;
  delta: ModificationDeltaInput | null;
  outcome: PolicyExceptionApprovalOutcome;
}): Promise<{ deferredPostCommit: () => Promise<void> }> {
  const { tx, request, snapshot, override, overrideReason, context, delta, outcome } =
    args;
  if (!delta) {
    throw new PolicyExceptionUnverifiedExecutionError("no verified delta");
  }

  // The canonical modification service, ON THIS TRANSACTION.
  //
  // Actor role ADMIN is what applies the reviewed MINIMUM_STAY override: the
  // service enforces minimum stay only for non-admin actors. That blanket skip is
  // safe HERE and only here, because #2525's drift gate has already proved the
  // frozen proposal trips EXACTLY the reviewed violations — a rule that newly
  // trips is `newViolations` and never reaches execution.
  //
  // Deliberately NOT passed: `confirmOverCapacity` (capacity stays a HARD refusal
  // — an approving officer is not a capacity-override actor) and `adminOverride`
  // (this is not a date-override edit; it is the member's reviewed proposal).
  const result = await modifyBookingBatch({
    bookingId: snapshot.bookingId,
    actor: { id: context.actorMemberId, role: "ADMIN" },
    input: {
      // #2526 review: ADMIN is borrowed for ONE thing — the reviewed minimum-stay
      // override. This flag hands back every rule that was NOT reviewed: the
      // beyond-family member-guest refusal, the consent step, the D-8
      // profile/bookability gate, the cross-family marker, the member-guest
      // subscription check, and the adult-supervision review. Without it an
      // approval labelled "Minimum stay" could attach an unrelated member to
      // somebody else's booking with no consent and un-park a child-safety review
      // in the officer's name. See `BatchModifyInput.reviewedMemberProposal`.
      reviewedMemberProposal: true,
      // The member's own words, for a supervision review this approval opens.
      ...(context.memberMessage?.trim()
        ? { memberReviewJustification: context.memberMessage.trim() }
        : {}),
      checkIn: delta.checkIn ?? undefined,
      checkOut: delta.checkOut ?? undefined,
      addGuests: delta.addGuests?.map((guest) => ({
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier as AgeTier,
        isMember: guest.isMember,
        ...(guest.memberId ? { memberId: guest.memberId } : {}),
        stayStart: guest.stayStart ?? null,
        stayEnd: guest.stayEnd ?? null,
        nights: guest.nights ?? null,
      })),
      removeGuestIds: delta.removeGuestIds,
      guestStayRanges: delta.guestStayRanges,
      ...(context.settlementMethod
        ? { settlementMethod: context.settlementMethod }
        : {}),
      // The member learns their request was approved from the canonical change
      // email the service already sends — no second, competing notice.
      notifyMember: true,
    },
    ipAddress: context.ipAddress,
    ...(overridesAdultMemberHosting(override)
      ? {
          approvedExceptionAdultMemberHostingDecision: {
            reason: overrideReason,
            byMemberId: context.actorMemberId,
          },
        }
      : {}),
    ...(context.hostingCoverageOverride
      ? { hostingCoverageOverride: context.hostingCoverageOverride }
      : {}),
    todayAtClub: context.todayAtClub,
    tx,
  });

  // The service reconciles the hosting hazard from the rows it just wrote and
  // deliberately opens it PENDING (an unrelated edit must never auto-approve an
  // exception). When the approval DID review that rule and it still trips, the
  // officer's decision is written now, in the same transaction — otherwise the
  // booking would carry a pending hosting review nobody will action even though
  // an officer has already decided it, with a reason, on this exact proposal.
  // A reviewed rule that has since CLEARED is deliberately not decided here:
  // there is nothing left to decide, and #2525 records the resolution instead.
  if (overridesAdultMemberHosting(override)) {
    outcome.hostingDecisionRecorded = await recordAdultMemberHostingReviewDecision(
      snapshot.bookingId,
      tx,
      { reason: overrideReason, byMemberId: context.actorMemberId },
    );

    // #2576 §7's third automatic resolution: "the incident should resolve
    // automatically if ... a valid policy exception is approved". Without this the
    // approval was undone on the next pass — the drain tests only whether the
    // hazard is gone, and an approved exception AUTHORISES the hazard rather than
    // removing it, so an officer who had just decided these exact uncovered nights,
    // with a reason, had a `critical` incident re-affirmed against their own
    // decision, permanently, with no route or UI able to clear it.
    //
    // In this transaction, alongside the decision it belongs to, and guarded on
    // `resolvedAt: null` so a replayed approval closes nothing twice. The decision
    // itself is a guarded PENDING → APPROVED claim, so a hazard that has since
    // changed materially reopens as PENDING and this resolution does not apply to
    // it.
    if (outcome.hostingDecisionRecorded) {
      await resolveHostingCoverageIncidents(
        {
          bookingId: snapshot.bookingId,
          resolution: "EXCEPTION_APPROVED",
          actorMemberId: context.actorMemberId,
        },
        tx,
      );
    }
  }

  // Persist the officer's notes on the decided request, in the same transaction.
  // Two separate columns (#2562): the member-facing explanation and the private
  // note, each written only when the officer actually left one, so an approval
  // with no note does not blank a note a previous write recorded.
  const notes = context.adminNotes?.trim();
  const internal = context.internalNotes?.trim();
  if (notes || internal) {
    await tx.bookingChangeRequest.updateMany({
      where: { id: request.id },
      data: {
        ...(notes ? { adminNotes: notes.slice(0, 2000) } : {}),
        ...(internal ? { internalNotes: internal.slice(0, 2000) } : {}),
      },
    });
  }

  return { deferredPostCommit: result.deferredPostCommit ?? (async () => {}) };
}

async function executeApprovedNewBooking(args: {
  tx: PrismaTransactionClient;
  request: LoadedPolicyExceptionRequest;
  snapshot: NewBookingProposalSnapshot;
  override: ConfirmedOverride;
  overrideReason: string;
  context: PolicyExceptionApprovalContext;
  outcome: PolicyExceptionApprovalOutcome;
}): Promise<{ deferredPostCommit: () => Promise<void> }> {
  const { tx, request, snapshot, override, overrideReason, context, outcome } = args;
  const execution = context.newBookingExecution;
  if (!execution) {
    throw new PolicyExceptionUnverifiedExecutionError(
      "no resolved new-booking execution parameters",
    );
  }

  const { checkIn, checkOut } = partyEnvelope(snapshot.proposed);
  const frozenGuests = snapshot.proposed.guests.map(proposalGuestToCreateInput);

  // THE GUEST-AUTHORISATION PIPELINE (#2526 review). `createConfirmedBooking`
  // does NOT validate guest member links — every other caller runs this sequence
  // itself before creating (the member/on-behalf create route, and even
  // `admin-booking-copy`). Skipping it let a member name any active member's id
  // in an exception request and have an approval attach them: no beyond-family
  // refusal, no consent request, no profile/bookability gate, and the guest row
  // keeping the REQUESTER's declared age tier and membership instead of the
  // member record's — which also priced them at the member rate.
  //
  // It runs with MEMBER semantics (`skipAuthorization: false`), because the
  // requester is the member and the officer reviewed minimum stay / hosting, not
  // the membership and privacy rules the queue promises still apply. A refusal
  // throws `BookingGuestValidationError`, which rolls the whole approval back and
  // the route reports with that error's own status.
  const { members: linkedMembers, boundary } =
    await resolveLinkedBookingMembersWithBoundary(
      tx,
      request.requestedByMemberId,
      frozenGuests.map((guest) => guest.memberId),
      {
        skipAuthorization: false,
        memberGuestWideningEnabled: execution.memberGuestPolicy.wideningEnabled,
      },
    );
  await assertLinkedBookingMembersCanBeBooked(
    tx,
    linkedMembers,
    request.requestedByMemberId,
    {
      actorRole: "MEMBER",
      onBehalfOfMemberId: null,
      // D-8: a blocked cross-family member is refused neutrally.
      crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
    },
  );
  // The member record is authoritative for a linked guest's name, age tier and
  // membership — the frozen party carries what the REQUESTER declared, and
  // pricing reads these fields.
  const normalizedGuests = normalizeBookingGuestInputs(frozenGuests, linkedMembers);
  const consentPlan = planMemberGuestConsentWrites({
    guests: normalizedGuests,
    boundary,
    actor: { kind: "MEMBER" },
    now: new Date(),
    bookingCheckIn: checkIn,
    policy: execution.memberGuestPolicy,
  });
  // Rebuilt field by field onto the create-service input shape: the
  // authorisation helpers are generic over a looser guest type (dates as strings
  // are legal there), so spreading their output back would widen `stayStart` /
  // `nights` out of the create contract.
  const guests = frozenGuests.map((guest, index) => {
    const normalized = normalizedGuests[index];
    const planned = consentPlan.guests[index];
    return {
      ...guest,
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      ageTier: normalized.ageTier,
      isMember: normalized.isMember,
      ...(normalized.memberId ? { memberId: normalized.memberId } : {}),
      ...(planned?.memberGuestConsent
        ? { memberGuestConsent: planned.memberGuestConsent }
        : {}),
      ...(planned?.crossFamilyMemberGuest !== undefined
        ? { crossFamilyMemberGuest: planned.crossFamilyMemberGuest }
        : {}),
    };
  });
  const memberGuestEntries = consentPlan.entriesByMemberId;

  const created = await createConfirmedBooking({
    // #3123 review — the club day the route resolved before this transaction
    // opened, shared with the modification executor above (`INV-LOCK-004`).
    todayAtClub: context.todayAtClub,
    effectiveMemberId: request.requestedByMemberId,
    // An officer executing a member's reviewed proposal IS an on-behalf create.
    isOnBehalf: true,
    // ...but only the REVIEWED rules are theirs to decide, so the
    // adult-supervision review keeps member semantics (#2526 review).
    reviewedMemberProposal: true,
    ...(context.memberMessage?.trim()
      ? { memberReviewJustification: context.memberMessage.trim() }
      : {}),
    sessionUserId: context.actorMemberId,
    checkIn,
    checkOut,
    guests,
    status: execution.status,
    shouldBePending: execution.shouldBePending,
    holdDays: execution.holdDays,
    paymentMethod: execution.paymentMethod,
    // D-R4: a hosting exception is accepted only with a reason attributable to
    // the officer, and only when the approval actually reviewed that rule. A
    // reviewed rule that has since cleared passes nothing, so the create opens no
    // review at all — the correct record of "there was no hazard".
    adultMemberHostingReason: overridesAdultMemberHosting(override)
      ? overrideReason
      : undefined,
    lodgeId: snapshot.lodgeId,
    // HARD capacity refusal: never `confirmOverCapacity`, never `waitlistIntent`.
    notifyMember: true,
    tx,
  });

  if (created.type === "capacityExceeded") {
    // THROW, never return: the engine's contract is that a failed execution
    // aborts the transaction, so the claim and the reservation release roll back
    // with it and the request is left exactly as it was — REQUESTED, at its
    // original version. Returning here would commit an APPROVED request with no
    // booking behind it.
    throw new PolicyExceptionExecutionCapacityError(created.fullNights);
  }

  outcome.createdBookingId = created.booking.id;

  // Record the executed booking on the request row, in the same transaction, so
  // the officer queue links straight to what the approval produced.
  await tx.newBookingPolicyExceptionRequest.updateMany({
    where: { id: request.id },
    data: {
      createdBookingId: created.booking.id,
      ...(context.adminNotes?.trim()
        ? { adminNotes: context.adminNotes.trim().slice(0, 2000) }
        : {}),
      // #2562: the private half, stored beside the member-facing half. It reaches
      // no email, no notification and no member projection.
      ...(context.internalNotes?.trim()
        ? { internalNotes: context.internalNotes.trim().slice(0, 2000) }
        : {}),
    },
  });

  const canonicalDeferred = created.deferredPostCommit;
  const createdBooking = created.booking;
  return {
    deferredPostCommit: async () => {
      if (canonicalDeferred) await canonicalDeferred();
      // The consent requests and family-add notices the member's own create route
      // dispatches after ITS commit (#2526 review). Without them a beyond-family
      // member guest was linked with a PENDING consent row nobody was ever told
      // about — a bed held for someone who was never asked, which only the
      // nightly sweep clears.
      await dispatchNewBookingMemberGuestNotifications({
        booking: createdBooking,
        bookerMemberId: request.requestedByMemberId,
        actorMemberId: context.actorMemberId,
        memberGuestEntries,
      });
    },
  };
}

/**
 * Dispatch the member-guest consent requests and family-add notices for a
 * booking an approval just created. Mirrors the member create route's own
 * post-commit pair, including its "log, never surface" discipline: the booking is
 * already committed, so a notification problem must never be reported as an
 * approval failure.
 */
async function dispatchNewBookingMemberGuestNotifications(args: {
  booking: { id: string; guests: Array<{ id: string; memberId: string | null }> };
  bookerMemberId: string;
  actorMemberId: string;
  memberGuestEntries: Map<string, MemberGuestConsentWritePlanEntry>;
}): Promise<void> {
  const { booking, bookerMemberId, actorMemberId, memberGuestEntries } = args;

  if (memberGuestEntries.size > 0) {
    const rows = matchMemberGuestNotificationRows({
      createdGuests: booking.guests,
      entriesByMemberId: memberGuestEntries,
    });
    if (rows.length > 0) {
      try {
        const { sendMemberGuestAddNotifications } = await import(
          "@/lib/member-guest-consent-notifications"
        );
        await sendMemberGuestAddNotifications({
          bookingId: booking.id,
          rows,
          // The member asked; the officer only let the reviewed rule through.
          actor: { kind: "MEMBER" },
        });
      } catch (err) {
        logger.error(
          { err, bookingId: booking.id },
          "Failed to dispatch member-guest add notifications for an approved policy exception",
        );
      }
    }
  }

  const addedMemberIds = booking.guests
    .map((guest) => guest.memberId)
    .filter((memberId): memberId is string => Boolean(memberId));
  if (addedMemberIds.length === 0) return;
  try {
    const { sendFamilyMemberBookingAddNotifications } = await import(
      "@/lib/family-booking-add-notifications"
    );
    await sendFamilyMemberBookingAddNotifications({
      bookingId: booking.id,
      bookerMemberId,
      actorMemberId,
      addedMemberIds,
    });
  } catch (err) {
    logger.error(
      { err, bookingId: booking.id },
      "Failed to dispatch family booking-add notifications for an approved policy exception",
    );
  }
}

// ---------------------------------------------------------------------------
// Pre-transaction execution parameters
// ---------------------------------------------------------------------------

/**
 * Resolve the NEW-booking execution parameters (hold decision + payment method)
 * BEFORE the approval transaction opens.
 *
 * The hold-policy read walks booking periods on the module client, which is
 * exactly why it cannot live inside a hook. The values it produces are the ones
 * the member booking route would produce for this party today: a party with
 * non-members outside the hold window is created PENDING with the club's hold
 * days, everything else goes straight to PAYMENT_PENDING, and the payment method
 * is the club's default — the member pays through the normal link, because an
 * approval never picks a payment method on somebody's behalf.
 */
export async function resolveNewBookingExecutionParams(
  snapshot: NewBookingProposalSnapshot,
): Promise<NonNullable<PolicyExceptionApprovalContext["newBookingExecution"]>> {
  const checkIn = parseDateOnly(snapshot.proposed.checkIn);
  const hasNonMembers = snapshot.proposed.guests.some((guest) => !guest.isMember);
  const holdPolicy = hasNonMembers
    ? await getNonMemberHoldPolicy(checkIn, snapshot.lodgeId)
    : { enabled: false, holdDays: 0, source: "default" as const };
  const decision = calculateBookingHoldDecision({
    hasNonMembers,
    checkIn,
    holdDays: holdPolicy.holdDays,
    holdEnabled: holdPolicy.enabled,
  });
  return {
    status: decision.status,
    shouldBePending: decision.shouldBePending,
    holdDays: holdPolicy.holdDays,
    paymentMethod: DEFAULT_BOOKING_PAYMENT_METHOD,
    // Read here for the same reason the hold policy is: the module flag + policy
    // singleton must not be queried on a second pool connection beneath the
    // approval's locks (`member-guest-add-policy.ts`).
    memberGuestPolicy: await loadMemberGuestAddPolicy(),
  };
}
