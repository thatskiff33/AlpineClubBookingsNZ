import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { addDaysDateOnly, parseDateOnly, formatDateOnly } from "@/lib/date-only";
import { clubTimeZone } from "@/lib/club-time/server";
import { normalizeGuestStayRange } from "@/lib/booking-guest-stay-range-input";
import { getStayNights } from "@/lib/policies/pricing";
import { validateMinimumStay } from "@/lib/booking-policies";
import { evaluateProposedAdultMemberHosting } from "@/lib/adult-member-hosting-review";
import { evaluateProposedPaidUpAdultPresence } from "@/lib/subscription-lockout-enforcement";
import type { AgeTierSettingsReader } from "@/lib/subscription-lockout-facts";
import type { SubscriptionLockoutMode } from "@/lib/membership-lockout-settings";
import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { isOperationallyPresentConsent } from "@/lib/member-guest-consent";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  ACTIVE_BOOKING_STATUSES,
  bookingHoldsCapacity,
} from "@/lib/booking-status";
import {
  releasePolicyExceptionReservation,
  reservePolicyExceptionCapacity,
} from "@/lib/booking-exception-reservations";
import type { GuestStayRange } from "@/lib/booking-guest-stay-ranges";
import { resolveModificationStayRanges } from "@/lib/booking-modification-stay-ranges";
import {
  assertLinkedBookingMembersCanBeBooked,
  resolveLinkedBookingMembersWithBoundary,
} from "@/lib/booking-guests";
import { loadMemberGuestAddPolicy } from "@/lib/member-guest-add-policy";
import {
  toMemberExceptionProposal,
  toMemberExceptionRequestItem,
  type MemberExceptionProposal,
  type MemberExceptionRequestItem,
} from "@/lib/member-exception-requests";
import type { PrismaTransactionClient } from "@/lib/db-transaction";
import {
  type AdultMemberHostingConsequence,
  type PolicyExceptionCapacityMode,
  type PolicyExceptionReasonCode,
  type PolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import {
  canonicalizeProposalParty,
  canonicalizeProposalSnapshot,
  computePolicyExceptionHoldExpiry,
  computeProposalHash,
  computeProposalReservation,
  firstReservedNight,
  freezePolicyExceptionEvidence,
  modificationExceptionOpenStateKey,
  newBookingExceptionOpenStateKey,
  normalizeMemberMessage,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
  type NightReservation,
  type ProposalGuest,
  type ProposalParty,
} from "@/lib/booking-exception-requests";

/**
 * The canonical global booking/money lock(1). A HELD modification request now
 * holds a PROVISIONAL capacity reservation (#2525), so creating one (which
 * reserves), superseding one (which releases the prior hold and reserves the
 * new) and cancelling one (which releases) are all capacity changes. They
 * compose the EXISTING keys in the house order — global lock(1) FIRST, then the
 * per-lodge capacity lock keyed on the frozen lodge — exactly as
 * `resolvePolicyExceptionRequestTerminal` and the approve-and-execute engine do
 * (`booking-exception-execution.ts`), so the reservation write/delete serialises
 * against every occupancy read and claim at that lodge and cannot deadlock with
 * the sibling execution paths. Kept in ONE helper so `advisory-lock-guard.test.ts`
 * counts a single `pg_advisory_xact_lock(1)` site for this file. See
 * docs/CONCURRENCY_AND_LOCKING.md -> "Provisional reservations for held
 * policy-exception requests (#2365)".
 */
async function acquireGlobalBookingLock(
  tx: Pick<PrismaTransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
}

/**
 * #2524: the request-CREATION service for eligible SOFT booking-policy failures.
 *
 * It turns a would-be-hard-stop (minimum stay, or enabled adult-member hosting)
 * into a durable, immutable member request an admin can decide later. It builds
 * ON the #2365 foundation — it consumes `freezePolicyExceptionEvidence`,
 * `computeProposalHash`, `canonicalizeProposalSnapshot`, `normalizeMemberMessage`
 * and the open-slot key helpers rather than reimplementing any of them.
 *
 * Scope boundary (the rest is #2525, `booking-exception-execution.ts`):
 *  - it NEVER reserves provisional capacity and NEVER touches or creates a live
 *    booking. A held request changes nothing but its own row;
 *  - approval + atomic canonical execution is a named seam it does not cross.
 *
 * Two request flavours share every discipline here (immutable proposal + hash,
 * frozen evidence, required <=1000-char message, a DB-enforced one-open-request
 * slot, guarded single-transition lifecycle, post-commit notification):
 *  - NEW_BOOKING  -> its own `NewBookingPolicyExceptionRequest` table;
 *  - MODIFICATION -> a POLICY_EXCEPTION `BookingChangeRequest` (the #2365 store).
 */

// ---------------------------------------------------------------------------
// Typed domain errors (routes map these to HTTP status codes)
// ---------------------------------------------------------------------------

/** No eligible soft violation trips the proposal — there is nothing to review. */
export class NoEligiblePolicyExceptionError extends Error {
  constructor() {
    super(
      "This proposal does not trip any reviewable booking-policy exception.",
    );
    this.name = "NoEligiblePolicyExceptionError";
  }
}

/** A request is already open for this subject (the one-open-request rule). */
export class OpenExceptionRequestConflictError extends Error {
  constructor() {
    super("A booking-policy exception request is already open.");
    this.name = "OpenExceptionRequestConflictError";
  }
}

/**
 * A supersede targeted a request that is no longer REQUESTED (already approved,
 * rejected, cancelled or superseded by someone else). Per the "lost claim runs
 * NO side effect" rule, the replacement request is NOT created.
 */
export class LostSupersedeClaimError extends Error {
  constructor() {
    super("The request you tried to replace is no longer open.");
    this.name = "LostSupersedeClaimError";
  }
}

/**
 * A HELD (HOLD-mode) modification request would need to RESERVE beds the lodge
 * does not currently have (#2525 FIX 4). We refuse it rather than write an
 * over-capacity provisional hold — an over-capacity hold is never an oversell
 * (the live booking still holds only its own beds) but it would phantom-block
 * other members' admissions and is a griefing vector. The member can resubmit
 * once capacity frees up. This mirrors the request service's existing "signal a
 * couldn't-proceed by a typed error the HTTP layer maps to a 4xx" contract
 * (NoEligible/OpenConflict/LostSupersede) — the smallest, most consistent choice,
 * and it keeps the invariant "a REQUESTED HOLD request always holds exactly its
 * reserved beds" intact (no `mode=HOLD but nothing reserved` ghost rows).
 */
export class PolicyExceptionCapacityUnavailableError extends Error {
  constructor() {
    super(
      "The lodge does not currently have room to hold this change. Please try again once space frees up.",
    );
    this.name = "PolicyExceptionCapacityUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ExceptionRequestGuestInput {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string | null;
  /** YYYY-MM-DD; falls back to the booking envelope when absent. */
  stayStart?: string | null;
  stayEnd?: string | null;
  /**
   * The guest's EXPLICIT night set (#713 multi-date-range mode), YYYY-MM-DD.
   *
   * Load-bearing, not optional detail (#2562 review). Both member surfaces send
   * per-guest night sets whenever the "Multiple date ranges" mode is on — which
   * needs no feature flag and is on by default for a booking that already has a
   * sparse guest — and a request that dropped them froze the ENVELOPE for every
   * guest instead. A member asking for one extra night then had six frozen,
   * reserved, reviewed, priced and executed against them. When present and
   * non-empty the guest stays exactly these nights; the envelope is derived from
   * them, exactly as the canonical create and modify paths do.
   */
  nights?: string[] | null;
}

export interface CreateNewBookingExceptionRequestInput {
  requestedByMemberId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  guests: ExceptionRequestGuestInput[];
  memberMessage: string;
  /** When set, the member is replacing THIS open request of theirs. */
  supersedeRequestId?: string | null;
}

export interface CreateModificationExceptionRequestInput {
  requestedByMemberId: string;
  bookingId: string;
  lodgeId: string;
  /** The live booking footprint the proposal was computed against. */
  base: ProposalParty;
  /** The full proposed result (never a delta). */
  proposed: ProposalParty;
  memberMessage: string;
  /** A short human summary rendered in the officer queue. */
  requestedSummary: string;
  /**
   * The RAW member delta the proposal was computed from (#2526). Stored beside
   * the frozen snapshot because the snapshot is a *result* — a full proposed
   * party with no BookingGuest ids — and the canonical modification service is
   * driven by a *delta* (which guest rows to remove, which ranges to move).
   * Re-deriving that delta from the snapshot would mean matching proposed guests
   * back onto live rows by name, which is ambiguous for two guests with the same
   * name; replaying the stored delta is exact.
   *
   * It is NOT trusted: `verifyLiveProposalIntegrity` (#2526) replays this delta
   * against the LIVE booking and refuses the approval unless the resulting
   * base+proposed pair hashes to the frozen `proposalHash`. A tampered delta, or
   * a live booking that has drifted since the request, therefore fails closed
   * with proposal drift instead of executing something nobody reviewed.
   */
  delta: ModificationDeltaInput;
  supersedeRequestId?: string | null;
  /**
   * Whether the LIVE booking being modified currently holds lodge capacity
   * (`bookingHoldsCapacity`, #1254). Required because a modification exception
   * request may be raised against any booking `getBookingEditPolicy` deems
   * editable — including DRAFT / generic PENDING / un-held PAYMENT_PENDING /
   * WAITLISTED / BUMPED bookings, none of which hold capacity. When the base
   * holds capacity the provisional reservation is the INCREMENTAL footprint;
   * when it does not, it is the FULL proposed footprint (#2525 FIX 7), because a
   * non-holding base contributes nothing to occupancy for the delta to sit atop.
   */
  baseHoldsCapacity: boolean;
}

// ---------------------------------------------------------------------------
// Proposal building + soft-policy re-evaluation (authoritative, server-side)
// ---------------------------------------------------------------------------

/** Expand a lodge-night envelope to sorted, unique YYYY-MM-DD strings. */
function envelopeNights(checkIn: Date, checkOut: Date): string[] {
  return getStayNights(checkIn, checkOut).map(formatDateOnly);
}

/**
 * Build the immutable proposed party from raw guest input, expanding each
 * guest's per-night footprint from their own stay range (falling back to the
 * booking envelope). Canonicalised so two freezes of the same facts are
 * byte-identical.
 *
 * Canonical parity, two ways (#2526 review):
 *
 *  - each guest's range goes through the SAME `normalizeGuestStayRange` the
 *    create route uses, so a half-supplied range (a Date In with no Date Out) is
 *    refused at freeze time instead of being quietly completed from the envelope
 *    and then refused at execution;
 *  - the party envelope EXPANDS to cover every guest night, mirroring
 *    `resolveBookingDateEnvelope` (#713), which is what `createConfirmedBooking`
 *    will do at execution. Freezing the submitted envelope instead let a request
 *    for one night carry a guest occupying nine: the officer queue showed a
 *    one-night stay, the engine capacity-checked one night, and the executed
 *    booking was nine nights of beds and price.
 */
export function buildProposalPartyFromGuests(
  checkIn: Date,
  checkOut: Date,
  guests: readonly ExceptionRequestGuestInput[],
): ProposalParty {
  const bookingNights = envelopeNights(checkIn, checkOut);
  const guestNights: string[][] = guests.map((guest, index) => {
    const range = normalizeGuestStayRange(
      {
        stayStart: guest.stayStart ?? null,
        stayEnd: guest.stayEnd ?? null,
        // The explicit night set wins over the range, which is what
        // `normalizeGuestStayRange` does for every other caller. Dropping it here
        // froze the envelope for a guest who picked three nights out of nine.
        nights: guest.nights ?? null,
      },
      { checkIn, checkOut },
      index,
    );
    // An explicit set is the guest's nights VERBATIM (already deduped and sorted
    // by the normaliser); only a contiguous range expands to its envelope.
    const nights =
      range.nights && range.nights.length > 0
        ? range.nights.map(formatDateOnly)
        : envelopeNights(range.stayStart, range.stayEnd);
    return nights.length > 0 ? nights : bookingNights;
  });

  // Expand-only envelope over the stated range plus every guest night.
  const allNights = [
    ...new Set([...bookingNights, ...guestNights.flat()]),
  ].sort();
  const envelopeCheckIn = allNights.length > 0
    ? parseDateOnly(allNights[0])
    : checkIn;
  const envelopeCheckOut = allNights.length > 0
    ? addDaysDateOnly(parseDateOnly(allNights[allNights.length - 1]), 1)
    : checkOut;

  const proposalGuests: ProposalGuest[] = guests.map((guest, index) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? null,
    nights: guestNights[index],
  }));
  return canonicalizeProposalParty({
    checkIn: formatDateOnly(envelopeCheckIn),
    checkOut: formatDateOnly(envelopeCheckOut),
    guests: proposalGuests,
  });
}

export interface LiveBookingGuestInput {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  memberId: string | null;
  stayStart: Date;
  stayEnd: Date;
  /**
   * The guest's stored explicit night set (#713). REQUIRED for a faithful replay
   * (#2526 review finding): the canonical planner preserves a guest's stored
   * night rows whenever it is not resetting them, so flattening a sparse stay to
   * its stayStart..stayEnd envelope would freeze - and capacity-check, and price
   * - beds on nights the execution never books. Absent/empty means the guest
   * genuinely has no explicit set and the envelope is authoritative.
   */
  nights?: ReadonlyArray<{ stayDate: Date }> | null;
}

export interface ModificationDeltaInput {
  /** YYYY-MM-DD; absent keeps the live value. */
  checkIn?: string | null;
  checkOut?: string | null;
  addGuests?: ExceptionRequestGuestInput[];
  removeGuestIds?: string[];
  guestStayRanges?: Array<{
    guestId: string;
    stayStart?: string | null;
    stayEnd?: string | null;
    /**
     * The guest's explicit night set (#713). Carried for the same reason as on
     * `ExceptionRequestGuestInput`: the shared resolver's range-input mode hinges
     * on ANY range input anywhere, and a night set stripped on the way in flipped
     * the whole request into no-range-inputs mode — which resets every guest to the
     * envelope on a date change, and keeps their STORED nights when the dates did
     * not move, so the frozen proposal was either far wider than the ask or
     * identical to the base.
     */
    nights?: string[] | null;
  }>;
}

/** The nights a resolved stay range covers: its explicit set, or its envelope. */
function nightsForResolvedRange(range: {
  stayStart: Date;
  stayEnd: Date;
  nights?: Date[];
}): string[] {
  return range.nights && range.nights.length > 0
    ? [...new Set(range.nights.map(formatDateOnly))].sort()
    : envelopeNights(range.stayStart, range.stayEnd);
}

/**
 * Build the frozen base (live) and proposed (post-delta) parties for a
 * modification request. The stored proposed snapshot is the authoritative,
 * reviewed artifact #2525 executes byte-for-byte, so this is where "what the
 * member asked for" is rendered once.
 *
 * The proposed party is resolved by the CANONICAL planner's own helper
 * (`resolveModificationStayRanges`, shared with `resolveTargetDates` and
 * `prepareGuestPlan`) rather than by a lookalike of it. That is the whole
 * integrity story of this workflow: an officer approves a frozen party, and the
 * approval then drives the canonical service with the stored DELTA - so "the
 * party this delta produces" has to be one function, computed once, not two
 * implementations that agree until they do not.
 *
 * The divergence this replaced was real and reachable (#2526 review). The old
 * model decided per guest ("no range entry + dates moved => reset to the new
 * envelope") while the planner decides on a GLOBAL flag ("any range input
 * anywhere => every guest without their own entry keeps their stored nights"), so
 * a date change plus a partial `guestStayRanges` froze, hashed, reviewed and
 * capacity-checked a party the execution never created. The old model also
 * flattened a sparse stored night set to its envelope, claiming beds on nights
 * nobody books.
 *
 * Range-validation failures propagate as `BookingGuestStayRangeValidationError`
 * (the HTTP layer maps them to 400) rather than being coerced into something
 * plausible: a delta the canonical service would refuse must not be frozen as a
 * reviewable proposal.
 */
export function buildModificationProposalParties(args: {
  bookingCheckIn: Date;
  bookingCheckOut: Date;
  liveGuests: readonly LiveBookingGuestInput[];
  delta: ModificationDeltaInput;
}): { base: ProposalParty; proposed: ProposalParty } {
  const { bookingCheckIn, bookingCheckOut, liveGuests, delta } = args;

  const resolved = resolveModificationStayRanges({
    booking: { checkIn: bookingCheckIn, checkOut: bookingCheckOut },
    guests: liveGuests,
    input: {
      checkIn: delta.checkIn,
      checkOut: delta.checkOut,
      addGuests: delta.addGuests,
      removeGuestIds: delta.removeGuestIds,
      guestStayRanges: delta.guestStayRanges,
    },
  });

  const baseGuests: ProposalGuest[] = liveGuests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId,
    nights: nightsForResolvedRange({
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
      ...(guest.nights && guest.nights.length > 0
        ? { nights: guest.nights.map((night) => night.stayDate) }
        : {}),
    }),
  }));

  const proposedRemaining: ProposalGuest[] = resolved.remaining.map(
    ({ guest, ...range }) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId,
      nights: nightsForResolvedRange(range),
    }),
  );

  const proposedAdded: ProposalGuest[] = (delta.addGuests ?? []).map(
    (guest, index) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      memberId: guest.memberId ?? null,
      nights: nightsForResolvedRange(resolved.added[index]),
    }),
  );

  const base = canonicalizeProposalParty({
    checkIn: formatDateOnly(bookingCheckIn),
    checkOut: formatDateOnly(bookingCheckOut),
    guests: baseGuests,
  });
  const proposed = canonicalizeProposalParty({
    checkIn: formatDateOnly(resolved.checkIn),
    checkOut: formatDateOnly(resolved.checkOut),
    guests: [...proposedRemaining, ...proposedAdded],
  });
  return { base, proposed };
}

// ---------------------------------------------------------------------------
// The replayable modification delta (#2526)
// ---------------------------------------------------------------------------

function optionalDateOnly(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A stored explicit night set, canonicalised: date-only strings, deduped, sorted.
 * Absent or empty becomes `undefined` so the stored delta stays byte-stable
 * (`normalizeStoredExceptionDelta`'s contract) and a re-freeze of the same request
 * writes the same JSON.
 */
function optionalNightList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nights = [
    ...new Set(
      value.filter(
        (night): night is string => typeof night === "string" && night.length > 0,
      ),
    ),
  ].sort();
  return nights.length > 0 ? nights : undefined;
}

/**
 * Canonicalise the stored delta so a re-freeze of the same member request writes
 * the same JSON: absent/empty collections are dropped rather than stored as `[]`,
 * and blank date strings become absent. Purely cosmetic for correctness — the
 * approval verifies the delta by REPLAYING it, not by comparing its text — but it
 * keeps the stored evidence readable and diffable.
 */
export function normalizeStoredExceptionDelta(
  input: ModificationDeltaInput | null | undefined,
): Record<string, unknown> {
  // Defensive: the field is REQUIRED by the input type, so every real call site
  // supplies it. Tolerating an absent one keeps a caller bug from throwing
  // inside the member's request transaction — it stores an empty delta, and the
  // approval then fails closed (the replay cannot reproduce the frozen hash).
  const delta = input ?? {};
  const out: Record<string, unknown> = {};
  const checkIn = optionalDateOnly(delta.checkIn);
  const checkOut = optionalDateOnly(delta.checkOut);
  if (checkIn) out.checkIn = checkIn;
  if (checkOut) out.checkOut = checkOut;
  if (delta.addGuests?.length) {
    out.addGuests = delta.addGuests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      ...(guest.memberId ? { memberId: guest.memberId } : {}),
      ...(optionalDateOnly(guest.stayStart)
        ? { stayStart: guest.stayStart }
        : {}),
      ...(optionalDateOnly(guest.stayEnd) ? { stayEnd: guest.stayEnd } : {}),
      // #713 explicit night set. Stored so the approval REPLAY produces the same
      // party the freeze did — without it the replay lost the member's night
      // selection and could only reproduce the frozen hash by accident.
      ...(optionalNightList(guest.nights)
        ? { nights: optionalNightList(guest.nights) }
        : {}),
    }));
  }
  if (delta.removeGuestIds?.length) {
    out.removeGuestIds = [...delta.removeGuestIds];
  }
  if (delta.guestStayRanges?.length) {
    out.guestStayRanges = delta.guestStayRanges.map((range) => ({
      guestId: range.guestId,
      ...(optionalDateOnly(range.stayStart) ? { stayStart: range.stayStart } : {}),
      ...(optionalDateOnly(range.stayEnd) ? { stayEnd: range.stayEnd } : {}),
      ...(optionalNightList(range.nights)
        ? { nights: optionalNightList(range.nights) }
        : {}),
    }));
  }
  return out;
}

/**
 * Read the stored delta back out of a `requestedChanges` value WITHOUT trusting
 * it. Anything that is not a well-formed delta returns null, which fails the
 * approval closed (proposal drift) rather than replaying nonsense. Even a
 * well-formed delta is only provisional: the caller must still prove the replay
 * reproduces the frozen proposal hash.
 */
export function parseStoredExceptionDelta(
  requestedChanges: unknown,
): ModificationDeltaInput | null {
  if (
    !requestedChanges ||
    typeof requestedChanges !== "object" ||
    Array.isArray(requestedChanges)
  ) {
    return null;
  }
  const raw = (requestedChanges as { delta?: unknown }).delta;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const stringOrUndefined = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  let addGuests: ExceptionRequestGuestInput[] | undefined;
  if (record.addGuests !== undefined) {
    if (!Array.isArray(record.addGuests)) return null;
    addGuests = [];
    for (const entry of record.addGuests) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const guest = entry as Record<string, unknown>;
      if (
        typeof guest.firstName !== "string" ||
        typeof guest.lastName !== "string" ||
        typeof guest.ageTier !== "string" ||
        typeof guest.isMember !== "boolean"
      ) {
        return null;
      }
      // A stored `nights` that is not an array of strings is not a well-formed
      // delta: fail closed (the approval then reports proposal drift) rather than
      // replaying a party with the night set silently dropped.
      if (guest.nights !== undefined) {
        if (
          !Array.isArray(guest.nights) ||
          !guest.nights.every((night) => typeof night === "string")
        ) {
          return null;
        }
      }
      addGuests.push({
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember,
        memberId: stringOrUndefined(guest.memberId) ?? null,
        stayStart: stringOrUndefined(guest.stayStart) ?? null,
        stayEnd: stringOrUndefined(guest.stayEnd) ?? null,
        nights: optionalNightList(guest.nights) ?? null,
      });
    }
  }

  let removeGuestIds: string[] | undefined;
  if (record.removeGuestIds !== undefined) {
    if (!Array.isArray(record.removeGuestIds)) return null;
    if (!record.removeGuestIds.every((id) => typeof id === "string")) return null;
    removeGuestIds = record.removeGuestIds as string[];
  }

  let guestStayRanges: ModificationDeltaInput["guestStayRanges"];
  if (record.guestStayRanges !== undefined) {
    if (!Array.isArray(record.guestStayRanges)) return null;
    guestStayRanges = [];
    for (const entry of record.guestStayRanges) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const range = entry as Record<string, unknown>;
      if (typeof range.guestId !== "string") return null;
      if (range.nights !== undefined) {
        if (
          !Array.isArray(range.nights) ||
          !range.nights.every((night) => typeof night === "string")
        ) {
          return null;
        }
      }
      guestStayRanges.push({
        guestId: range.guestId,
        stayStart: stringOrUndefined(range.stayStart) ?? null,
        stayEnd: stringOrUndefined(range.stayEnd) ?? null,
        nights: optionalNightList(range.nights) ?? null,
      });
    }
  }

  return {
    checkIn: stringOrUndefined(record.checkIn) ?? null,
    checkOut: stringOrUndefined(record.checkOut) ?? null,
    addGuests,
    removeGuestIds,
    guestStayRanges,
  };
}

/**
 * The narrow client the two soft-policy evaluators need. Declared structurally
 * (not `typeof prisma`) so the SAME evaluation can run on a `$transaction`
 * client: #2526's approval re-evaluates the frozen proposal INSIDE the approval
 * transaction, under the global and per-lodge locks it already holds, and
 * reaching for the module client there would check out a second pool connection
 * beneath those locks — the shape docs/CONCURRENCY_AND_LOCKING.md forbids.
 */
export type PolicyEvaluationDb = Pick<
  typeof prisma,
  | "booking"
  | "member"
  | "adultMemberHostingPolicy"
  | "lodge"
  | "minimumStayPolicy"
  // #2543: the paid-up-adult evaluation reads subscription facts
  // (SubscriptionLockoutDb) and its D-12 presence derivation reads the
  // requester's family boundary and the live rows' stored consent status.
  | "memberSubscription"
  | "membershipType"
  | "seasonalMembershipAssignment"
  | "familyGroupMember"
  | "bookingGuest"
>;

/**
 * Re-evaluate the eligible soft policies (minimum stay + adult-member hosting)
 * for a proposed party against CURRENT policy configuration. Authoritative and
 * server-side: the client's claimed violations are never trusted — the request
 * freezes exactly what this returns. Both request flavours funnel through here,
 * so a new booking and a modification cannot disagree about how a proposal is
 * judged.
 */
export async function evaluateProposalPartyViolations(
  db: PolicyEvaluationDb,
  lodgeId: string,
  party: ProposalParty,
  /**
   * Who is asking, and about which booking (#2543/#2569). Optional, and used by
   * both the paid-up-adult and adult-member-hosting evaluations below.
   *
   * It exists to make the override door actually open. A booking path refuses a
   * party because its only paid-up adult member is a cross-family member guest
   * whose invite is still PENDING (D-12: they hold a bed and nothing else, and may
   * never accept). The member then submits the SAME party here. Without these
   * facts this re-evaluation counted that PENDING adult as present, found no
   * violation, and the request machinery correctly refused to create a request
   * there was nothing to review — so the 409's promised door led nowhere.
   *
   * `ProposalGuest` deliberately does NOT carry the fact: the proposal is frozen
   * and hashed, and adding a field would change every existing proposal hash. It
   * is derived here instead.
   */
  presence?: {
    /** The member submitting the request; their family boundary decides scope. */
    requestedByMemberId?: string | null;
    /** For a MODIFICATION proposal: the live booking whose rows already exist. */
    bookingId?: string | null;
  },
): Promise<PolicyExceptionViolation[]> {
  return evaluatePartyViolations(db, lodgeId, party, presence, true);
}

/**
 * Evaluate the non-hosting soft policies for a party already persisted on one
 * booking. Hosting is deliberately absent here: persisted hosting evidence must
 * use `evaluatePersistedBookingAdultMemberHostingReadOnly`, whose canonical
 * snapshot includes sparse nights, operational consent, split siblings and
 * same-owner exclusions that a proposal cannot represent.
 */
export async function evaluatePersistedBookingNonHostingPolicyViolations(
  db: PolicyEvaluationDb,
  lodgeId: string,
  party: ProposalParty,
  presence: { requestedByMemberId?: string | null; bookingId: string },
  options?: {
    /**
     * The membership season these nights fall in, resolved authoritatively by the
     * caller. See the same parameter on `evaluateProposedPaidUpAdultPresence` for
     * why a read-only evidence caller must resolve it rather than letting the
     * paid-up-adult rule read the process-level financial-year cache: nothing on a
     * diagnostics path seeds that cache, so a club whose year-end month is not
     * March would have its party judged in the wrong season. Omitted by every
     * product caller, whose gated request has already seeded it.
     */
    seasonYear?: number;
    /**
     * The club's subscription-lockout mode, read authoritatively by the caller. Same
     * reason as `seasonYear`: left to itself the paid-up-adult rule peeks it through
     * readers that turn a database failure into `NO_BLOCK`, which is a safe
     * direction for a booking write and a fabricated answer for evidence.
     */
    subscriptionLockoutMode?: SubscriptionLockoutMode;
    /**
     * How the paid-up-adult rule reads the club's age-tier settings. Same split and
     * the same reason as the two above: left to itself the rule reads them through
     * the CACHED reader, which swallows a database failure into `AGE_TIER_DEFAULTS`
     * — the platform's own tier rule standing in for the club's, with nothing
     * marking the answer as unobserved. A read-only evidence caller passes a strict
     * reader bound to its transaction; every product caller omits it and is
     * unchanged. See `AgeTierSettingsReader`.
     */
    readAgeTierSettings?: AgeTierSettingsReader;
  },
): Promise<PolicyExceptionViolation[]> {
  return evaluatePartyViolations(
    db,
    lodgeId,
    party,
    presence,
    false,
    options?.seasonYear,
    options?.subscriptionLockoutMode,
    options?.readAgeTierSettings,
  );
}

async function evaluatePartyViolations(
  db: PolicyEvaluationDb,
  lodgeId: string,
  party: ProposalParty,
  presence:
    | { requestedByMemberId?: string | null; bookingId?: string | null }
    | undefined,
  includeProposedHosting: boolean,
  seasonYear?: number,
  subscriptionLockoutMode?: SubscriptionLockoutMode,
  readAgeTierSettings?: AgeTierSettingsReader,
): Promise<PolicyExceptionViolation[]> {
  const checkIn = parseDateOnly(party.checkIn);
  const checkOut = parseDateOnly(party.checkOut);

  const violations: PolicyExceptionViolation[] = [];

  const stay = await validateMinimumStay(checkIn, checkOut, lodgeId, db);
  if (!stay.valid) {
    violations.push(...stay.violations);
  }

  const bookingOwnerMemberId = await resolveProposalBookingOwner(db, presence);
  const hosting = includeProposedHosting
    ? await evaluateProposedAdultMemberHosting(db, {
        bookingOwnerMemberId,
        lodgeId,
        checkIn,
        checkOut,
        guests: party.guests.map((guest) => ({
          firstName: guest.firstName,
          lastName: guest.lastName,
          memberId: guest.memberId,
          nights: guest.nights,
        })),
      })
    : null;
  if (hosting) {
    violations.push(hosting);
  }

  // #2543 — the paid-up-adult requirement. Registering it HERE is what turns
  // the booking refusal into an actual door: the member re-submits the same
  // party to `POST /api/bookings/exception-requests`, this re-evaluation
  // (server-side, never the client's claim) reproduces the violation, and the
  // #2365 machinery freezes it, HOLDs the beds and queues it for a Booking
  // Officer. Without this line the refusal would name a workflow the member
  // could not enter.
  const operationallyPresentFor = await resolveProposalOperationalPresence(
    db,
    party,
    presence,
  );
  const paidUpAdult = await evaluateProposedPaidUpAdultPresence(db, {
    lodgeId,
    checkIn,
    checkOut,
    bookingOwnerMemberId,
    guests: party.guests.map((guest) => ({
      ...guest,
      operationallyPresent: operationallyPresentFor(guest.memberId),
    })),
    seasonYear,
    mode: subscriptionLockoutMode,
    ...(readAgeTierSettings ? { readAgeTierSettings } : {}),
  });
  if (paidUpAdult) {
    violations.push(paidUpAdult);
  }

  return violations;
}

/**
 * Who would OWN the booking a proposal describes (#2543, owner decision 3 Aug
 * 2026).
 *
 * The second half of making the override door real. The paid-up-adult requirement
 * also fires when the booking OWNER is an unfinancial member, staying or not; a
 * booking path that refused on that trigger must reproduce the SAME violation
 * here, or the request machinery finds nothing to review, refuses to create a
 * request, and the 409 names a workflow the member cannot enter.
 *
 * A MODIFICATION reads the live booking's own `memberId` rather than trusting the
 * requester to be it: that is the member the booking paths judge, and reading it
 * server-side is what stops the door being opened against somebody else's
 * standing. A NEW booking has no row yet, so the requester is who would own it.
 * `ProposalGuest` deliberately does not carry the fact, exactly as with D-12
 * presence — the proposal is frozen and hashed, and a new field would change every
 * existing proposal hash.
 */
async function resolveProposalBookingOwner(
  db: PolicyEvaluationDb,
  presence:
    | { requestedByMemberId?: string | null; bookingId?: string | null }
    | undefined,
): Promise<string | null> {
  if (presence?.bookingId) {
    const booking = await db.booking.findUnique({
      where: { id: presence.bookingId },
      select: { memberId: true },
    });
    return booking?.memberId ?? null;
  }
  return presence?.requestedByMemberId?.trim() || null;
}

/**
 * D-12 operational presence for each member in a PROPOSED party (#2543).
 *
 * Returns a lookup that answers `undefined` — i.e. "absent, so present", the #2364
 * default — whenever there is nothing to go on, so a caller that supplies no
 * context gets exactly the previous behaviour.
 *
 * The rule, in two halves:
 *
 *  - a member guest BEYOND the requester's family boundary is invited PENDING when
 *    the booking is eventually made, so they are not yet present. This is the case
 *    the booking paths refuse on, and reproducing it here is the whole point;
 *  - EXCEPT where a live row for that member on this booking is already
 *    operationally present (a CONFIRMED cross-family guest, or a family-scope row
 *    with no consent status at all), in which case they are present. Without this
 *    half a modification proposal would raise a violation for a party the booking
 *    path allows, and an admin would be asked to review something that needed no
 *    review.
 */
async function resolveProposalOperationalPresence(
  db: PolicyEvaluationDb,
  party: ProposalParty,
  presence:
    | { requestedByMemberId?: string | null; bookingId?: string | null }
    | undefined,
): Promise<(memberId: string | null) => boolean | undefined> {
  const requestedByMemberId = presence?.requestedByMemberId?.trim();
  if (!requestedByMemberId) return () => undefined;

  const memberIds = [
    ...new Set(
      party.guests
        .map((guest) => guest.memberId?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (memberIds.length === 0) return () => undefined;

  const boundary = await computeMemberGuestBoundary(
    db,
    requestedByMemberId,
    memberIds,
  );

  const alreadyPresent = new Set<string>();
  if (presence?.bookingId) {
    const liveRows = await db.bookingGuest.findMany({
      where: { bookingId: presence.bookingId },
      select: { memberId: true, consentStatus: true },
    });
    for (const row of liveRows) {
      if (row.memberId && isOperationallyPresentConsent(row.consentStatus)) {
        alreadyPresent.add(row.memberId);
      }
    }
  }

  return (memberId) => {
    const id = memberId?.trim();
    if (!id) return undefined;
    if (boundary.scopeByMemberId.get(id) !== "BEYOND_FAMILY") return undefined;
    return alreadyPresent.has(id) ? true : false;
  };
}

interface FrozenProposal {
  snapshot: NewBookingProposalSnapshot | ModificationProposalSnapshot;
  proposalHash: string;
  frozenEvidence: ReturnType<typeof freezePolicyExceptionEvidence>;
  aggregateCapacityMode: PolicyExceptionCapacityMode;
  violations: PolicyExceptionViolation[];
}

/**
 * Freeze a proposal: refuse it if no eligible soft violation trips (nothing to
 * review), otherwise build the canonical snapshot + hash and the #2363 evidence
 * aggregate. `aggregateCapacityMode` is guaranteed non-null because a non-empty
 * violation set always resolves HOLD-if-any-HOLD.
 */
function freezeProposal(
  snapshotInput: NewBookingProposalSnapshot | ModificationProposalSnapshot,
  violations: PolicyExceptionViolation[],
): FrozenProposal {
  if (violations.length === 0) {
    throw new NoEligiblePolicyExceptionError();
  }
  const frozenEvidence = freezePolicyExceptionEvidence(violations);
  if (frozenEvidence.capacityMode === null) {
    // Unreachable given violations.length > 0, but the DB column is NOT NULL, so
    // fail closed rather than write a null aggregate.
    throw new NoEligiblePolicyExceptionError();
  }
  const snapshot = canonicalizeProposalSnapshot(snapshotInput) as
    | NewBookingProposalSnapshot
    | ModificationProposalSnapshot;
  return {
    snapshot,
    proposalHash: computeProposalHash(snapshot),
    frozenEvidence,
    aggregateCapacityMode: frozenEvidence.capacityMode,
    violations,
  };
}

function isOpenSlotUniqueViolation(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = error.meta?.target;
    if (Array.isArray(target)) {
      return target.some((column) => String(column).includes("openStateKey"));
    }
    return true;
  }
  // Test seam / defensive: a plain P2002-coded object still maps to the conflict.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// NEW_BOOKING requests
// ---------------------------------------------------------------------------

export interface CreatedExceptionRequest {
  id: string;
  status: string;
  proposalHash: string;
  reasonCodes: PolicyExceptionReasonCode[];
  aggregateCapacityMode: PolicyExceptionCapacityMode;
  /**
   * The proposal EXACTLY as it was frozen, returned to the member who just
   * submitted it (#2562).
   *
   * Not a courtesy. The freeze is not the raw payload: the party envelope EXPANDS
   * to cover every guest night (mirroring what the canonical create will do), and a
   * guest's nights resolve through the canonical planner's own helper. So the
   * proposal an officer decides can legitimately be WIDER than the dates the member
   * typed — and a member who is never shown that difference cannot tell that the
   * request they are tracking is not the request they thought they made. Returning
   * it lets the submission screen show the frozen article immediately, while
   * withdraw and replace are still available.
   */
  proposal: MemberExceptionProposal;
  /**
   * Whether this request actually reserved beds, from the write itself rather than
   * from the policy's capacity mode (#2562). Always false for a new-booking
   * request; on a modification, true only when reservation rows were really
   * written — which excludes a HOLD proposal whose incremental footprint came out
   * empty (a pure shrink).
   */
  capacityHeld: boolean;
}

/**
 * Refuse a request whose party names a member the requester may not book, BEFORE
 * it is frozen for review (#2526 review).
 *
 * The approval runs the full pipeline itself and fails closed, so this is not the
 * security boundary — it is there so an officer never reviews and approves a
 * party that cannot be executed, and so the member finds out at submission rather
 * than days later through a refusal they cannot interpret. It runs the same
 * MEMBER-semantics resolve the member's own booking path runs: with the
 * memberGuests module off (the shipped default) a beyond-family member id is
 * refused byte-for-byte as it always was; with it on, the request is allowed and
 * the approval opens the consent request.
 *
 * Throws `BookingGuestValidationError`, which `mapExceptionRequestError` turns
 * into that error's own status.
 */
async function assertRequestedPartyMemberGuestsAllowed(args: {
  requestedByMemberId: string;
  memberIds: Array<string | null | undefined>;
}): Promise<void> {
  if (!args.memberIds.some((memberId) => Boolean(memberId))) return;
  const policy = await loadMemberGuestAddPolicy();
  const { members, boundary } = await resolveLinkedBookingMembersWithBoundary(
    prisma,
    args.requestedByMemberId,
    args.memberIds,
    {
      skipAuthorization: false,
      memberGuestWideningEnabled: policy.wideningEnabled,
    },
  );
  await assertLinkedBookingMembersCanBeBooked(
    prisma,
    members,
    args.requestedByMemberId,
    {
      actorRole: "MEMBER",
      onBehalfOfMemberId: null,
      crossFamilyMemberIds: boundary.beyondFamilyMemberIds,
    },
  );
}

/**
 * Create a NEW-booking policy-exception request. Evaluates the soft policies
 * server-side, freezes the immutable proposal + evidence, and stores it under
 * the member's one-open-request slot. If `supersedeRequestId` is set, the old
 * request is claimed REQUESTED -> SUPERSEDED first with a guarded `updateMany`;
 * a lost claim aborts with NO new row created. The live booking layer is never
 * touched — a new booking does not exist yet.
 */
export async function createNewBookingExceptionRequest(
  input: CreateNewBookingExceptionRequestInput,
): Promise<CreatedExceptionRequest> {
  const memberMessage = normalizeMemberMessage(input.memberMessage);

  await assertRequestedPartyMemberGuestsAllowed({
    requestedByMemberId: input.requestedByMemberId,
    memberIds: input.guests.map((guest) => guest.memberId),
  });

  const proposedParty = buildProposalPartyFromGuests(
    input.checkIn,
    input.checkOut,
    input.guests,
  );

  const violations = await evaluateProposalPartyViolations(
    prisma,
    input.lodgeId,
    proposedParty,
    // #2543 — no live booking exists yet, so every cross-family member guest in the
    // proposal is somebody who would be invited PENDING.
    { requestedByMemberId: input.requestedByMemberId },
  );

  const frozen = freezeProposal(
    { kind: "NEW_BOOKING", lodgeId: input.lodgeId, proposed: proposedParty },
    violations,
  );

  const openStateKey = newBookingExceptionOpenStateKey(
    input.requestedByMemberId,
    frozen.proposalHash,
  );

  try {
    const created = await prisma.$transaction(async (tx) => {
      // The predecessor's attempt count, read BEFORE the claim so a replacement
      // can carry it forward (#2526 review). The officer card renders this as
      // "Attempts", and every replacement starting again at 1 told them a request
      // the member had resubmitted three times was a first ask.
      let attemptCount = 1;
      if (input.supersedeRequestId) {
        const predecessor =
          await tx.newBookingPolicyExceptionRequest.findUnique({
            where: { id: input.supersedeRequestId },
            select: { attemptCount: true },
          });
        const claim = await tx.newBookingPolicyExceptionRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            requestedByMemberId: input.requestedByMemberId,
            status: "REQUESTED",
          },
          data: {
            status: "SUPERSEDED",
            openStateKey: null,
            cancelledAt: new Date(),
            version: { increment: 1 },
          },
        });
        // Lost claim: the target is no longer open. NO side effect — do not
        // create the replacement request.
        if (claim.count === 0) {
          throw new LostSupersedeClaimError();
        }
        // Only counted once the claim landed, so a lost claim cannot inflate it.
        attemptCount = (predecessor?.attemptCount ?? 1) + 1;
      }

      const request = await tx.newBookingPolicyExceptionRequest.create({
        data: {
          lodgeId: input.lodgeId,
          requestedByMemberId: input.requestedByMemberId,
          status: "REQUESTED",
          attemptCount,
          proposalSnapshot: frozen.snapshot as unknown as Prisma.InputJsonValue,
          proposalHash: frozen.proposalHash,
          frozenEvidence:
            frozen.frozenEvidence as unknown as Prisma.InputJsonValue,
          aggregateCapacityMode: frozen.aggregateCapacityMode,
          memberMessage,
          openStateKey,
        },
        select: { id: true, status: true },
      });

      if (input.supersedeRequestId) {
        await tx.newBookingPolicyExceptionRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            status: "SUPERSEDED",
            supersededByRequestId: null,
          },
          data: { supersededByRequestId: request.id },
        });
      }

      return request;
    });

    return {
      id: created.id,
      status: created.status,
      proposalHash: frozen.proposalHash,
      reasonCodes: frozen.frozenEvidence.reasonCodes,
      aggregateCapacityMode: frozen.aggregateCapacityMode,
      proposal: toMemberExceptionProposal(frozen.snapshot),
      // A new-booking request reserves nothing, whatever its capacity mode says:
      // the reservation ledger is keyed on an existing BookingChangeRequest and
      // there is no booking row yet.
      capacityHeld: false,
    };
  } catch (error) {
    if (isOpenSlotUniqueViolation(error)) {
      throw new OpenExceptionRequestConflictError();
    }
    throw error;
  }
}

/**
 * Member cancels their own OPEN new-booking request. A guarded single
 * transition REQUESTED -> CANCELLED that also frees the open slot. Returns true
 * only when the claim landed; a lost claim (already terminal) returns false and
 * the caller runs NO side effect.
 */
export async function cancelNewBookingExceptionRequest(input: {
  id: string;
  requestedByMemberId: string;
}): Promise<boolean> {
  const claim = await prisma.newBookingPolicyExceptionRequest.updateMany({
    where: {
      id: input.id,
      requestedByMemberId: input.requestedByMemberId,
      status: "REQUESTED",
    },
    data: {
      status: "CANCELLED",
      openStateKey: null,
      cancelledAt: new Date(),
      version: { increment: 1 },
    },
  });
  return claim.count === 1;
}

// ---------------------------------------------------------------------------
// MODIFICATION requests (POLICY_EXCEPTION BookingChangeRequest)
// ---------------------------------------------------------------------------

/**
 * Create a MODIFICATION policy-exception request on the #2365 BookingChangeRequest
 * store. Freezes the base (live) + proposed footprints and the evidence, and
 * holds the member's one-open POLICY_EXCEPTION slot on this booking. The live
 * booking is NEVER modified here. Supersede + guarded-claim discipline matches
 * the new-booking path.
 */
export async function createModificationExceptionRequest(
  input: CreateModificationExceptionRequestInput,
): Promise<CreatedExceptionRequest> {
  const memberMessage = normalizeMemberMessage(input.memberMessage);

  await assertRequestedPartyMemberGuestsAllowed({
    requestedByMemberId: input.requestedByMemberId,
    memberIds: (input.delta.addGuests ?? []).map((guest) => guest.memberId),
  });

  const violations = await evaluateProposalPartyViolations(
    prisma,
    input.lodgeId,
    input.proposed,
    // #2543 — a modification: rows already on the booking are judged by their
    // stored consent status, and only the ones this proposal would newly invite
    // count as not-yet-present.
    {
      requestedByMemberId: input.requestedByMemberId,
      bookingId: input.bookingId,
    },
  );

  const frozen = freezeProposal(
    {
      kind: "MODIFICATION",
      lodgeId: input.lodgeId,
      bookingId: input.bookingId,
      base: input.base,
      proposed: input.proposed,
    },
    violations,
  );

  const openStateKey = modificationExceptionOpenStateKey(
    input.bookingId,
    input.requestedByMemberId,
  );

  // A HELD (HOLD-mode) modification reserves per-night beds while pending
  // (#2525); a supersede releases the prior request's hold. Either makes this a
  // capacity change, so the transaction takes the house global -> per-lodge locks
  // before touching the reservation ledger. A NO_HOLD, non-supersede create is a
  // pure row insert and needs neither.
  const holdsCapacity = frozen.aggregateCapacityMode === "HOLD";

  // The exact footprint this HOLD request will reserve: INCREMENTAL beds over a
  // capacity-holding base, or the FULL proposed footprint over a non-holding base
  // (#2525 FIX 7). Computed once (pure) so the admission check below guards
  // EXACTLY the beds we are about to write.
  const reservationFootprint: NightReservation[] = holdsCapacity
    ? computeProposalReservation(frozen.snapshot, {
        baseHoldsCapacity: input.baseHoldsCapacity,
      })
    : [];
  const reservesBeds = reservationFootprint.length > 0;
  const mutatesReservation = reservesBeds || Boolean(input.supersedeRequestId);

  // #2553: a request that actually keeps real beds while it waits gets a
  // deadline. Stamped once, at creation, from the frozen footprint's earliest
  // night, and never rewritten — the reaper's clock is therefore an immutable
  // fact of the request rather than something a later write can move.
  //
  // The gate is `reservesBeds`, NOT `holdsCapacity`: a HOLD aggregate whose
  // incremental footprint is EMPTY (a pure shrink, or a reshuffle that adds no
  // bed on any night) writes no `PolicyExceptionReservationNight` row and
  // therefore strands nothing. Giving it a TTL would let a cron silently close a
  // live request nobody has decided, which is a member-visible change this issue
  // never asked for. NULL is exactly "no capacity is at stake here", so the
  // reaper leaves it in the officer queue until a human decides it.
  //
  // #3123 — the club's PERSISTED zone, not the environment's, decides when the
  // first held night begins. Resolved here, in the request path, and passed in:
  // the expiry rule stays a pure function of its inputs, which is what lets the
  // reaper re-derive the identical deadline for a row that never got one.
  const holdExpiresAt = reservesBeds
    ? computePolicyExceptionHoldExpiry({
        createdAt: new Date(),
        firstHeldNight: firstReservedNight(reservationFootprint),
        zone: await clubTimeZone(),
      })
    : null;

  // The full proposed party as capacity-engine guest ranges (explicit per-night
  // sets), for the pre-reservation admission check (#2525 FIX 4).
  const proposedParty = (frozen.snapshot as ModificationProposalSnapshot).proposed;
  const proposedCheckIn = parseDateOnly(proposedParty.checkIn);
  const proposedCheckOut = parseDateOnly(proposedParty.checkOut);
  const proposedGuestRanges: GuestStayRange[] = proposedParty.guests.map(
    (guest) => ({ nights: guest.nights }),
  );

  try {
    const created = await prisma.$transaction(async (tx) => {
      if (mutatesReservation) {
        await acquireGlobalBookingLock(tx);
        await acquireLodgeCapacityLock(tx, input.lodgeId);
      }

      // See the new-booking path: the replacement carries the predecessor's
      // attempt count forward so the officer card's "Attempts" means something.
      let attemptCount = 1;
      if (input.supersedeRequestId) {
        const predecessor = await tx.bookingChangeRequest.findUnique({
          where: { id: input.supersedeRequestId },
          select: { attemptCount: true },
        });
        const claim = await tx.bookingChangeRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            // Scope the supersede to THIS booking (#2525 FIX 6). A supersede
            // replaces the member's open request on the SAME booking, and we hold
            // only THIS booking's lodge lock here — so releasing a request that
            // lived on a DIFFERENT booking/lodge would delete its reservation
            // without serialising against that lodge's occupancy readers. Scoping
            // to `bookingId` makes a cross-booking supersede claim 0 rows (a lost
            // claim) rather than an unserialised cross-lodge release.
            bookingId: input.bookingId,
            requestedByMemberId: input.requestedByMemberId,
            kind: "POLICY_EXCEPTION",
            status: "REQUESTED",
          },
          data: {
            status: "SUPERSEDED",
            openStateKey: null,
            cancelledAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (claim.count === 0) {
          throw new LostSupersedeClaimError();
        }
        attemptCount = (predecessor?.attemptCount ?? 1) + 1;
        // The superseded request no longer holds beds — release its provisional
        // reservation atomically with the SUPERSEDED claim (under the same locks),
        // so the hold the replacement takes below cannot double-count the beds the
        // old proposal held.
        await releasePolicyExceptionReservation(tx, input.supersedeRequestId);
      }

      // (#2525 FIX 4) Admission control BEFORE writing an over-capacity hold. Run
      // it under the per-lodge lock already held, AFTER any supersede release (so
      // a resubmit's own freed beds do not count against it). Excluding the live
      // booking makes the full-proposed check equivalent to an incremental-headroom
      // check for a capacity-holding base, and the correct full-footprint check for
      // a non-holding base (its id is simply absent from the occupancy population,
      // so the exclusion is a harmless no-op). A shortfall refuses the request
      // rather than persisting a phantom-bed hold that would block other members.
      if (reservesBeds) {
        const capacity = await checkCapacityForGuestRanges(
          input.lodgeId,
          proposedCheckIn,
          proposedCheckOut,
          proposedGuestRanges,
          input.bookingId,
          tx,
        );
        if (!capacity.available) {
          throw new PolicyExceptionCapacityUnavailableError();
        }
      }

      const request = await tx.bookingChangeRequest.create({
        data: {
          bookingId: input.bookingId,
          requestedByMemberId: input.requestedByMemberId,
          kind: "POLICY_EXCEPTION",
          status: "REQUESTED",
          attemptCount,
          // requestedChanges is a required column; keep the existing queue's
          // {requested:{summary}} shape so the officer view renders a summary
          // without a policy-exception-specific branch.
          requestedChanges: {
            source: "POLICY_EXCEPTION",
            requested: { summary: input.requestedSummary },
            // #2526: the replayable member delta. See `delta` on the input type
            // — untrusted, and re-verified against the frozen hash at approval.
            delta: normalizeStoredExceptionDelta(input.delta),
          } as unknown as Prisma.InputJsonValue,
          proposalSnapshot: frozen.snapshot as unknown as Prisma.InputJsonValue,
          proposalHash: frozen.proposalHash,
          frozenEvidence:
            frozen.frozenEvidence as unknown as Prisma.InputJsonValue,
          aggregateCapacityMode: frozen.aggregateCapacityMode,
          memberMessage,
          openStateKey,
          holdExpiresAt,
        },
        select: { id: true, status: true },
      });

      // Reserve the capacity a HELD request holds while pending, keyed on the new
      // request id, under the per-lodge lock taken above — EXACTLY the footprint
      // the admission check just cleared. NO_HOLD proposals (and pure shrinks)
      // reserve nothing; the approval rechecks capacity instead.
      if (reservesBeds) {
        await reservePolicyExceptionCapacity(tx, {
          changeRequestId: request.id,
          lodgeId: input.lodgeId,
          reservation: reservationFootprint,
        });
      }

      if (input.supersedeRequestId) {
        await tx.bookingChangeRequest.updateMany({
          where: {
            id: input.supersedeRequestId,
            status: "SUPERSEDED",
            supersededByRequestId: null,
          },
          data: { supersededByRequestId: request.id },
        });
      }

      return request;
    });

    return {
      id: created.id,
      status: created.status,
      proposalHash: frozen.proposalHash,
      reasonCodes: frozen.frozenEvidence.reasonCodes,
      aggregateCapacityMode: frozen.aggregateCapacityMode,
      proposal: toMemberExceptionProposal(frozen.snapshot),
      // The FACT of the write, not the policy's intent: `reservesBeds` is the same
      // predicate that decided whether reservation rows were inserted above.
      capacityHeld: reservesBeds,
    };
  } catch (error) {
    if (isOpenSlotUniqueViolation(error)) {
      throw new OpenExceptionRequestConflictError();
    }
    throw error;
  }
}

/**
 * Member cancels their own OPEN modification policy-exception request. Guarded
 * single transition, frees the slot, returns false (no side effect) on a lost
 * claim. Scoped to POLICY_EXCEPTION so it can never touch a locked-period row,
 * to the request's own `bookingId` so a request reached via the wrong booking
 * URL cannot be claimed (which would mislabel the success-path audit with the
 * URL's booking rather than the request's real one), and — #2674 — to a booking
 * that has not been soft-deleted. Each of those is a predicate ON THE CLAIM, so
 * every failure mode is the same indistinguishable lost claim: 0 rows, false,
 * no write, no reservation release, and the route's plain 409.
 */
export async function cancelModificationExceptionRequest(input: {
  id: string;
  bookingId: string;
  requestedByMemberId: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // A cancel RELEASES any provisional reservation the held request holds
    // (#2525), which is a capacity change, so it takes the house global ->
    // per-lodge locks keyed on the frozen lodge before the guarded claim — the
    // same discipline as `resolvePolicyExceptionRequestTerminal`. The pre-read
    // resolves only the immutable frozen lodge for the lock; authorization and
    // the single-flight stay in the member/booking-scoped guarded claim below, so
    // a lost claim (wrong owner, wrong booking, or already terminal) releases
    // nothing.
    const pre = await tx.bookingChangeRequest.findUnique({
      where: { id: input.id },
      select: { proposalSnapshot: true, kind: true },
    });
    if (!pre || pre.kind !== "POLICY_EXCEPTION") return false;
    const snapshot = pre.proposalSnapshot as { lodgeId?: unknown } | null;
    const lodgeId =
      snapshot && typeof snapshot.lodgeId === "string" ? snapshot.lodgeId : null;

    await acquireGlobalBookingLock(tx);
    if (lodgeId) await acquireLodgeCapacityLock(tx, lodgeId);

    const claim = await tx.bookingChangeRequest.updateMany({
      where: {
        id: input.id,
        bookingId: input.bookingId,
        requestedByMemberId: input.requestedByMemberId,
        kind: "POLICY_EXCEPTION",
        status: "REQUESTED",
        // #2674: and the booking must not be SOFT-DELETED.
        //
        // WHY THIS PATH WAS GENUINELY REACHABLE. #2674 was filed against the
        // arrival-time write, which already refuses a deleted booking by
        // accident — its status gate admits only live bookings, and
        // `Booking.deletedAt` has exactly one writer
        // (`softDeleteCancelledBooking`, src/lib/booking-delete.ts) which
        // refuses anything not already CANCELLED and never clears the column,
        // so a soft-deleted booking is CANCELLED permanently. This claim had no
        // such accident to inherit: the route above it never loads the Booking
        // at all, and the `where` here named the REQUEST's own columns and
        // nothing about the booking. A member could cancel their open exception
        // request on a booking the club had deleted, writing CANCELLED +
        // cancelledAt + a version bump, releasing the provisional reservation,
        // and earning a success audit row against a deleted record.
        //
        // AND THE STATE IS PRODUCIBLE. `CANCELLED + deletedAt + an open
        // REQUESTED policy-exception request` needs nothing exotic: booking
        // cancellation never resolves change requests (booking-cancel.ts does
        // not mention `bookingChangeRequest` once), and
        // `getCancelledBookingDeleteBlockers` does not count them either, so an
        // open request neither closes itself on cancel nor blocks the delete.
        //
        // WHY A RELATION FILTER RATHER THAN A PRE-READ. Three reasons, and the
        // third is the deciding one:
        //  - it is ATOMIC with the claim. A read-then-write would leave a window
        //    in which the booking is deleted between the check and the update;
        //    here the guard is evaluated by the same statement that takes the
        //    row, under the locks already held.
        //  - it costs no extra query, and the existing lost-claim branch already
        //    handles a zero count with no side effect at all.
        //  - it leaks NOTHING. A deleted booking now loses the claim exactly as
        //    a wrong-owner or wrong-booking caller does, so all three produce
        //    the identical 409. A pre-read answering 404 would have been the
        //    worse shape here: this route has no authorisation step in front of
        //    it — the claim IS the authorisation — so a 404-on-deleted branch
        //    ahead of it would let ANY signed-in member probe any booking id
        //    from the URL and learn whether that booking was deleted. 409
        //    "no longer open and cannot be cancelled" is also honest on the
        //    facts: on a deleted booking the request is not cancellable.
        //
        // The provisional capacity hold is not stranded by refusing here: the
        // #2553 hold reaper (`cron-policy-exception-hold-reaper.ts`) releases it
        // and moves the request to EXPIRED on its own deadline.
        booking: { deletedAt: null },
      },
      data: {
        status: "CANCELLED",
        openStateKey: null,
        cancelledAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (claim.count !== 1) return false;

    await releasePolicyExceptionReservation(tx, input.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Unified officer queue read (merges both sources)
// ---------------------------------------------------------------------------

const ACTOR_SELECT = {
  select: { id: true, firstName: true, lastName: true, email: true },
} as const;

export type ExceptionQueueStatusFilter =
  | "REQUESTED"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "SUPERSEDED"
  // #2553: a request the hold reaper closed. Accepted by the admin queue route's
  // own filter too, so the type and the route agree; the officer SCREEN that
  // surfaces an "Expired" tab is #2526.
  | "EXPIRED"
  | "ALL";

/** One covered policy as frozen into the evidence, for the officer queue. */
export interface ExceptionQueuePolicyRef {
  reasonCode: PolicyExceptionReasonCode;
  policyId: string;
  policyVersion: number;
  capacityMode: PolicyExceptionCapacityMode;
}

export interface UnifiedExceptionQueueItem {
  source: "NEW_BOOKING" | "MODIFICATION";
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The optimistic-concurrency token (#2526). The officer queue hands it back on
   * the approve/reject call so a decision made against a stale screen loses its
   * guarded CAS instead of deciding a request that changed underneath it.
   */
  version: number;
  bookingId: string | null;
  lodgeId: string | null;
  requestedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  reviewedBy: { id: string; firstName: string; lastName: string } | null;
  reviewedAt: Date | null;
  memberMessage: string | null;
  proposalHash: string | null;
  aggregateCapacityMode: PolicyExceptionCapacityMode | null;
  reasonCodes: PolicyExceptionReasonCode[];
  /** Every covered policy at the frozen revision — the reviewed evidence. */
  policyRefs: ExceptionQueuePolicyRef[];
  /**
   * What the club's hosting setting DID about this violation at the time (#2569),
   * or null where the request carries no hosting reason. See
   * `frozenHostingConsequence`: the queue has to distinguish a booking that was
   * made and flagged from one that was refused outright.
   */
  hostingConsequence: AdultMemberHostingConsequence | null;
  affectedNights: string[];
  /** The proposed stay envelope as frozen, so the queue shows what it decides. */
  proposedCheckIn: string | null;
  proposedCheckOut: string | null;
  /** How many guests the proposed party holds. */
  proposedGuestCount: number | null;
  /**
   * The officer's MEMBER-FACING decision explanation, once a decision has been
   * recorded (#2562). Rendered to the member on their own request list, so the
   * officer UI labels it as member-visible before they submit it.
   */
  adminNotes: string | null;
  /**
   * The officer's PRIVATE note (#2562). Admin surfaces only — this queue read is
   * behind `requireAdmin`, and the member projection
   * (`src/lib/member-exception-requests.ts`) has no field for it.
   */
  internalNotes: string | null;
  /** The booking a successful new-booking approval created (NEW_BOOKING only). */
  createdBookingId: string | null;
  attemptCount: number;
  conflictCount: number;
  lastConflictAt: Date | null;
  lastConflictReason: string | null;
  supersededByRequestId: string | null;
  summary: string | null;
}

/** Bounded read: the review queue holds a small, bounded set of live requests. */
const UNIFIED_QUEUE_SOURCE_CAP = 500;

function frozenReasonCodes(value: unknown): PolicyExceptionReasonCode[] {
  if (value && typeof value === "object" && "reasonCodes" in value) {
    const codes = (value as { reasonCodes?: unknown }).reasonCodes;
    if (Array.isArray(codes)) {
      return codes.filter((c): c is PolicyExceptionReasonCode => typeof c === "string");
    }
  }
  return [];
}

function frozenAffectedNights(value: unknown): string[] {
  if (value && typeof value === "object" && "affectedNights" in value) {
    const nights = (value as { affectedNights?: unknown }).affectedNights;
    if (Array.isArray(nights)) {
      return nights.filter((n): n is string => typeof n === "string");
    }
  }
  return [];
}

/** The frozen lodge id out of a stored proposal snapshot, or null. */
function snapshotLodgeId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lodgeId = (value as { lodgeId?: unknown }).lodgeId;
  return typeof lodgeId === "string" ? lodgeId : null;
}

function frozenPolicyRefs(value: unknown): ExceptionQueuePolicyRef[] {
  if (!value || typeof value !== "object" || !("policyRefs" in value)) return [];
  const refs = (value as { policyRefs?: unknown }).policyRefs;
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (ref): ref is ExceptionQueuePolicyRef =>
      Boolean(ref) &&
      typeof ref === "object" &&
      typeof (ref as ExceptionQueuePolicyRef).reasonCode === "string" &&
      typeof (ref as ExceptionQueuePolicyRef).policyId === "string" &&
      typeof (ref as ExceptionQueuePolicyRef).policyVersion === "number",
  );
}

/**
 * The hosting CONSEQUENCE frozen onto this request's evidence, or null where the
 * request has no hosting reason (#2569).
 *
 * The officer queue needs it because the same reason code means two different
 * things. Under `ADMIN_REVIEW_REQUIRED` the booking was MADE and an officer is
 * asked to look at it; under `ENFORCED` it was REFUSED and exists only as this
 * request. "Adult member must host" describes both, and an officer who reads it as
 * the first while it is the second believes a member has a booking they do not
 * have — and will not treat the queue as the thing standing between them and a bed.
 *
 * Read off the FROZEN violation rather than the live policy row, deliberately: the
 * club may have changed the setting since, and what the officer is deciding is what
 * happened at the time. A snapshot frozen before #2569 carries no consequence, and
 * absent reads as the only one that existed then, `ADMIN_REVIEW_REQUIRED`.
 */
function frozenHostingConsequence(
  value: unknown,
): AdultMemberHostingConsequence | null {
  if (!value || typeof value !== "object") return null;
  const violations = (value as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) return null;
  for (const violation of violations) {
    if (!violation || typeof violation !== "object") continue;
    const row = violation as {
      reasonCode?: unknown;
      consequence?: unknown;
    };
    if (row.reasonCode !== "ADULT_MEMBER_HOSTING_REQUIRED") continue;
    return row.consequence === "ENFORCED"
      ? "ENFORCED"
      : "ADMIN_REVIEW_REQUIRED";
  }
  return null;
}

/** The frozen proposed party's envelope + size, read defensively. */
function proposedPartyFacts(value: unknown): {
  checkIn: string | null;
  checkOut: string | null;
  guestCount: number | null;
} {
  const empty = { checkIn: null, checkOut: null, guestCount: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const proposed = (value as { proposed?: unknown }).proposed;
  if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) {
    return empty;
  }
  const party = proposed as Record<string, unknown>;
  return {
    checkIn: typeof party.checkIn === "string" ? party.checkIn : null,
    checkOut: typeof party.checkOut === "string" ? party.checkOut : null,
    guestCount: Array.isArray(party.guests) ? party.guests.length : null,
  };
}

function summaryFromRequestedChanges(value: unknown): string | null {
  if (value && typeof value === "object") {
    const requested = (value as { requested?: unknown }).requested;
    if (requested && typeof requested === "object") {
      const summary = (requested as { summary?: unknown }).summary;
      if (typeof summary === "string") return summary;
    }
  }
  return null;
}

/**
 * The single officer-facing read of every policy-exception request, merging the
 * new-booking table and the POLICY_EXCEPTION BookingChangeRequest rows into one
 * age-ordered list. Rows are fetched per source (bounded), mapped to a common
 * shape, merge-sorted newest-first, then paged in memory — correct across two
 * tables, which a single SQL OFFSET cannot be. Returns the same
 * `{ data, page, pageSize, total }` envelope as the existing change-request
 * queue so the officer UI reads one shape.
 */
export async function readUnifiedExceptionQueue(input: {
  status: ExceptionQueueStatusFilter;
  page: number;
  pageSize: number;
}): Promise<{
  data: UnifiedExceptionQueueItem[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const statusWhere =
    input.status === "ALL" ? {} : { status: input.status };

  const [newBookingRows, modificationRows] = await Promise.all([
    prisma.newBookingPolicyExceptionRequest.findMany({
      where: statusWhere,
      include: { requestedBy: ACTOR_SELECT, reviewedBy: ACTOR_SELECT },
      orderBy: { createdAt: "desc" },
      take: UNIFIED_QUEUE_SOURCE_CAP,
    }),
    prisma.bookingChangeRequest.findMany({
      where: { kind: "POLICY_EXCEPTION", ...statusWhere },
      include: { requestedBy: ACTOR_SELECT, reviewedBy: ACTOR_SELECT },
      orderBy: { createdAt: "desc" },
      take: UNIFIED_QUEUE_SOURCE_CAP,
    }),
  ]);

  const items: UnifiedExceptionQueueItem[] = [
    ...newBookingRows.map(
      (row): UnifiedExceptionQueueItem => ({
        source: "NEW_BOOKING",
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        version: row.version,
        bookingId: null,
        lodgeId: row.lodgeId,
        requestedBy: row.requestedBy,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt,
        memberMessage: row.memberMessage,
        proposalHash: row.proposalHash,
        aggregateCapacityMode: row.aggregateCapacityMode,
        reasonCodes: frozenReasonCodes(row.frozenEvidence),
        policyRefs: frozenPolicyRefs(row.frozenEvidence),
        hostingConsequence: frozenHostingConsequence(row.frozenEvidence),
        affectedNights: frozenAffectedNights(row.frozenEvidence),
        proposedCheckIn: proposedPartyFacts(row.proposalSnapshot).checkIn,
        proposedCheckOut: proposedPartyFacts(row.proposalSnapshot).checkOut,
        proposedGuestCount: proposedPartyFacts(row.proposalSnapshot).guestCount,
        adminNotes: row.adminNotes,
        internalNotes: row.internalNotes,
        createdBookingId: row.createdBookingId,
        attemptCount: row.attemptCount,
        conflictCount: row.conflictCount,
        lastConflictAt: row.lastConflictAt,
        lastConflictReason: row.lastConflictReason,
        supersededByRequestId: row.supersededByRequestId,
        summary: null,
      }),
    ),
    ...modificationRows.map(
      (row): UnifiedExceptionQueueItem => ({
        source: "MODIFICATION",
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        version: row.version,
        bookingId: row.bookingId,
        // The lodge a modification proposal targets is frozen INTO the snapshot
        // (the booking's lodge at request time), not stored as a column here.
        lodgeId: snapshotLodgeId(row.proposalSnapshot),
        requestedBy: row.requestedBy,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt,
        memberMessage: row.memberMessage,
        proposalHash: row.proposalHash,
        aggregateCapacityMode: row.aggregateCapacityMode,
        reasonCodes: frozenReasonCodes(row.frozenEvidence),
        policyRefs: frozenPolicyRefs(row.frozenEvidence),
        hostingConsequence: frozenHostingConsequence(row.frozenEvidence),
        affectedNights: frozenAffectedNights(row.frozenEvidence),
        proposedCheckIn: proposedPartyFacts(row.proposalSnapshot).checkIn,
        proposedCheckOut: proposedPartyFacts(row.proposalSnapshot).checkOut,
        proposedGuestCount: proposedPartyFacts(row.proposalSnapshot).guestCount,
        adminNotes: row.adminNotes,
        internalNotes: row.internalNotes,
        createdBookingId: null,
        attemptCount: row.attemptCount,
        conflictCount: row.conflictCount,
        lastConflictAt: row.lastConflictAt,
        lastConflictReason: row.lastConflictReason,
        supersededByRequestId: row.supersededByRequestId,
        summary: summaryFromRequestedChanges(row.requestedChanges),
      }),
    ),
  ];

  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const total = items.length;
  const start = (input.page - 1) * input.pageSize;
  const data = items.slice(start, start + input.pageSize);

  return { data, page: input.page, pageSize: input.pageSize, total };
}

// ---------------------------------------------------------------------------
// Member-facing read (#2562): the requester's own requests, both flavours
// ---------------------------------------------------------------------------

/**
 * How many of a member's own requests their request area shows. Bounded, and
 * generous: the section is a status list on My Bookings, not an archive, and a
 * member who has raised more than fifty booking-rule requests has a different
 * conversation to have with the club.
 */
const MEMBER_EXCEPTION_REQUEST_CAP = 50;

/**
 * What one created booking can honestly be said about, from its own row.
 *
 * TWO facts, not one (#2562 re-review). `holdsCapacity` answers "are the beds on
 * it"; `awaitsPayment` answers "is it still live and still owed". Both are false for
 * a cancelled or reaped booking, and reading the first as a proxy for the second is
 * what told a member to go and pay a booking that no longer existed.
 */
interface CreatedBookingCapacityFacts {
  holdsCapacity: boolean;
  awaitsPayment: boolean;
}

/**
 * Read the created bookings' OWN capacity answers, keyed by booking id (#2562).
 *
 * WHY THIS IS A BOOKING READ and not a fact about the request. An approved
 * new-booking exception creates the booking the member's own wizard would have
 * created: `resolveNewBookingExecutionParams` passes
 * `calculateBookingHoldDecision`'s status, which is only ever PENDING or
 * PAYMENT_PENDING, and the create sets no `originBookingRequest` and no
 * `adminCapacityHoldAt`. Neither status holds capacity on its own (#737), so
 * `bookingHoldsCapacity` is false and another member can still take those nights
 * — until the member pays, at which point the same booking DOES hold them. Only
 * the booking row can answer that, and it answers differently on different days,
 * which is why nothing derives it from the approval.
 *
 * A booking id with no row (deleted, or a soft pointer that never resolved) is
 * simply absent from the map, and the caller's `?? null` turns that into "state
 * the rule, assert nothing".
 */
async function readCreatedBookingCapacityHolds(
  bookingIds: string[],
): Promise<Map<string, CreatedBookingCapacityFacts>> {
  const holds = new Map<string, CreatedBookingCapacityFacts>();
  if (bookingIds.length === 0) return holds;
  const bookings = await prisma.booking.findMany({
    where: { id: { in: bookingIds } },
    select: {
      id: true,
      status: true,
      adminCapacityHoldAt: true,
      // The relation-based PENDING extension (#1254): a converted-request booking
      // holds its beds while unpaid. Selected as an id so the read stays a
      // presence check rather than pulling the request row.
      originBookingRequest: { select: { id: true } },
    },
  });
  for (const booking of bookings) {
    holds.set(booking.id, {
      holdsCapacity: bookingHoldsCapacity({
        status: booking.status,
        isRequestConverted: booking.originBookingRequest !== null,
        hasAdminCapacityHold: booking.adminCapacityHoldAt !== null,
      }),
      // STILL LIVE. `ACTIVE_BOOKING_STATUSES` is the club's own answer to "is this
      // booking a thing that is still happening": PENDING, PAYMENT_PENDING,
      // CONFIRMED, PAID, AWAITING_REVIEW. A non-holding booking inside that set is
      // non-holding because it is UNPAID, which is the only case where telling the
      // member to open it and pay it is true; CANCELLED, BUMPED and every
      // waitlist/draft state fall outside it and get the closed sentence instead.
      awaitsPayment: (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(
        booking.status,
      ),
    });
  }
  return holds;
}

/**
 * Every booking-policy exception request the member RAISED, merged from both
 * tables and projected through the member DTO (#2562).
 *
 * Scoped on `requestedByMemberId` alone, which is deliberately the requester and
 * not the booking's owner: a family delegate can raise a request on somebody
 * else's booking, and it is the person who asked who needs to track, withdraw and
 * replace it. The booking's owner sees the outcome on the booking itself.
 *
 * Three things this function is careful about:
 *
 *  1. It selects a STRICT COLUMN LIST, and `internalNotes` is not in it. The
 *     officer's private note is never read on this path at all, so it cannot be
 *     leaked by a later mapper edit — there is nothing in memory to leak.
 *  2. `capacityHeld` comes from the RESERVATION LEDGER (`_count` of live
 *     `PolicyExceptionReservationNight` rows), never from `aggregateCapacityMode`.
 *     A new-booking request reserves nothing whatever its mode says, so its answer
 *     is hard-coded false at the one place that knows why; a modification answers
 *     from its real rows, which is also correct for the pure-shrink case where a
 *     HOLD aggregate reserved no bed at all.
 *  3. Both sources are capped, merged, then sorted newest-first in memory —
 *     correct across two tables, which one SQL ORDER BY cannot be.
 *  4. An APPROVED new-booking row gets the CREATED BOOKING's own capacity answer,
 *     read from that booking's status through `bookingHoldsCapacity`. Approval
 *     creates the booking the member's own wizard would have created — PENDING or
 *     PAYMENT_PENDING — and neither holds a bed until it is paid, so "approved"
 *     is not evidence about beds. Without this read the row told the member their
 *     beds were on the booking, which is the held-beds promise the owner's
 *     decision forbids on this path.
 */
export async function readMemberExceptionRequests(
  requestedByMemberId: string,
): Promise<MemberExceptionRequestItem[]> {
  const [newBookingRows, modificationRows] = await Promise.all([
    prisma.newBookingPolicyExceptionRequest.findMany({
      where: { requestedByMemberId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        reviewedAt: true,
        proposalSnapshot: true,
        frozenEvidence: true,
        memberMessage: true,
        // The MEMBER-FACING decision explanation. `internalNotes` is deliberately
        // absent from this select — see the doc comment above.
        adminNotes: true,
        lastConflictReason: true,
        lastConflictAt: true,
        createdBookingId: true,
        supersededByRequestId: true,
        // For the capacity SENTENCE only (#2562). `capacityHeld` on this path is
        // hard-coded false; the mode is what lets the words say WHY.
        aggregateCapacityMode: true,
      },
      orderBy: { createdAt: "desc" },
      take: MEMBER_EXCEPTION_REQUEST_CAP,
    }),
    prisma.bookingChangeRequest.findMany({
      where: { requestedByMemberId, kind: "POLICY_EXCEPTION" },
      select: {
        id: true,
        status: true,
        createdAt: true,
        reviewedAt: true,
        bookingId: true,
        proposalSnapshot: true,
        frozenEvidence: true,
        memberMessage: true,
        adminNotes: true,
        lastConflictReason: true,
        lastConflictAt: true,
        supersededByRequestId: true,
        // The frozen HOLD-if-any-HOLD aggregate, for the capacity SENTENCE and
        // never for the capacity ANSWER (#2562): a NO_HOLD request that needs beds
        // and a HOLD request that needs none both hold nothing, and telling a
        // member the second when the first is true is the lie this fixes.
        aggregateCapacityMode: true,
        // The reservation ledger IS the capacity answer (#2525). A count, not the
        // rows: the member is told whether beds are held, never which nights the
        // ledger holds them on.
        _count: { select: { reservationNights: true } },
      },
      orderBy: { createdAt: "desc" },
      take: MEMBER_EXCEPTION_REQUEST_CAP,
    }),
  ]);

  // The created bookings' OWN capacity answers, for the approved new-booking rows
  // only. One extra query, skipped entirely when nothing was approved, and it
  // reads the three fields `bookingHoldsCapacity` needs and nothing else.
  const createdBookingFactsById =
    await readCreatedBookingCapacityHolds(
      newBookingRows
        .filter((row) => row.status === "APPROVED" && row.createdBookingId)
        .map((row) => row.createdBookingId as string),
    );

  const items: MemberExceptionRequestItem[] = [
    ...newBookingRows.map((row) =>
      toMemberExceptionRequestItem({
        ...row,
        source: "NEW_BOOKING",
        bookingId: null,
        // FALSE for every new-booking request, always: the provisional
        // reservation ledger is keyed on an existing BookingChangeRequest, and a
        // new booking has no row to key on. Saying "holding beds" here is the
        // exact lie the officer queue had to be corrected for in #2526.
        holdsReservationNights: false,
        // The created booking's answers, or null where there is no booking or the
        // row could not be read. Null makes the sentence state the RULE rather
        // than assert an answer, which is the safe direction here.
        createdBookingHoldsCapacity: row.createdBookingId
          ? (createdBookingFactsById.get(row.createdBookingId)?.holdsCapacity ??
            null)
          : null,
        // Whether that booking can still be paid (#2562 re-review). Without it the
        // row told a member whose booking had been cancelled or reaped to open it and
        // pay it before somebody else took the nights.
        createdBookingAwaitsPayment: row.createdBookingId
          ? (createdBookingFactsById.get(row.createdBookingId)?.awaitsPayment ??
            null)
          : null,
      }),
    ),
    ...modificationRows.map((row) =>
      toMemberExceptionRequestItem({
        ...row,
        source: "MODIFICATION",
        createdBookingId: null,
        holdsReservationNights: row._count.reservationNights > 0,
        // No booking was CREATED on this path — the change was applied to one the
        // member already had — so there is no created-booking answer to give, and
        // the wording branch for MODIFICATION never asks for one.
        createdBookingHoldsCapacity: null,
        createdBookingAwaitsPayment: null,
      }),
    ),
  ];

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items.slice(0, MEMBER_EXCEPTION_REQUEST_CAP);
}
