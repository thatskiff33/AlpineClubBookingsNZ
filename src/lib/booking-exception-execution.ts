import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { releasePolicyExceptionReservation } from "@/lib/booking-exception-reservations";
import {
  classifyPolicyExceptionDrift,
  computeProposalHash,
  parseFrozenEvidence,
  reviewedViolationsFromEvidence,
  type ExceptionProposalSnapshot,
  type PolicyExceptionDriftResult,
  type PolicyExceptionRequestStatus,
} from "@/lib/booking-exception-requests";
import type {
  PolicyExceptionCapacityMode,
  PolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";
import type { PrismaTransactionClient } from "@/lib/db-transaction";

/**
 * Atomic approve-and-execute for booking-policy exception requests (#2525) — the
 * Critical core of TLR-8. This module owns the CONCURRENCY MECHANICS of turning a
 * held, reviewed proposal into a real booking (or a real modification): the lock
 * order, the fresh-role reauthorization, the guarded `version` claim, the
 * proposal/policy drift gate, the NO_HOLD capacity recheck, the atomic
 * reservation release, and the transaction-aware hand-off to the canonical
 * booking service — with post-commit notifications and provider work.
 *
 * The two genuinely EXTERNAL concerns are injected seams, because they are owned
 * by sibling lanes and depend on shapes those lanes freeze:
 *
 *  - {@link PolicyExceptionApprovalHooks.reauthorizeBookingOfficer} — the
 *    fresh-DB permission check for an Authorized Booking Officer (the route /
 *    session-guard layer owns the real permission model);
 *  - {@link PolicyExceptionApprovalHooks.evaluateCurrentViolations} — re-evaluate
 *    the FROZEN proposal against TODAY's policy configuration (#2364 evaluators);
 *  - {@link PolicyExceptionApprovalHooks.recheckCapacity} — the NO_HOLD capacity
 *    recheck against the frozen proposal;
 *  - {@link PolicyExceptionApprovalHooks.executeApprovedProposal} — map the frozen
 *    snapshot to a `createConfirmedBooking` / `modifyBookingBatch` call and run
 *    it ON THE APPROVAL'S TRANSACTION, returning the service's deferred
 *    post-commit thunk. **This is the #2524 boundary**: #2524 froze the snapshot
 *    (plus the payment/promo/credit fields the canonical services need) and so
 *    owns the snapshot -> canonical-input mapping. Both canonical services are
 *    now tx-aware (`input.tx` / `tx`), so the mapping simply threads the `tx`
 *    this seam is handed and the confirmed override set.
 *
 * Everything else is concrete and directly unit-testable with a fake `db` whose
 * `$transaction` runs the callback.
 */

// ---------------------------------------------------------------------------
// Lock helper (single call site so the advisory-lock inventory sees one)
// ---------------------------------------------------------------------------

/**
 * The canonical global booking/money lock(1). A policy-exception approval or
 * terminal release is a capacity change (reservation) and, for a modification,
 * a money/status transition on a booking, so per the #2365 lock contract it
 * composes the EXISTING keys in the house order — global lock(1) FIRST, then the
 * per-lodge capacity lock (and the member-night / member-credit keys the
 * canonical service takes after that). Kept in ONE helper so
 * `advisory-lock-guard.test.ts` counts a single `pg_advisory_xact_lock(1)` site
 * for this file. See docs/CONCURRENCY_AND_LOCKING.md.
 */
async function acquireGlobalBookingLock(
  tx: Pick<PrismaTransactionClient, "$executeRaw">,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The stored policy-exception request fields this engine reads. */
export interface LoadedPolicyExceptionRequest {
  id: string;
  status: PolicyExceptionRequestStatus;
  /**
   * The BookingChangeRequest discriminator. `null` for a NEW_BOOKING request,
   * which lives in its own table and has no such column (#2526).
   */
  kind: "LOCKED_PERIOD" | "POLICY_EXCEPTION" | null;
  version: number;
  /** The live booking a MODIFICATION targets; `null` for a NEW_BOOKING request. */
  bookingId: string | null;
  requestedByMemberId: string;
  proposalSnapshot: ExceptionProposalSnapshot;
  proposalHash: string;
  frozenEvidence: unknown;
  aggregateCapacityMode: PolicyExceptionCapacityMode | null;
}

/** The raw stored row a store hands back, before the engine parses its JSON. */
export interface StoredPolicyExceptionRequestRow {
  id: string;
  status: PolicyExceptionRequestStatus;
  kind: "LOCKED_PERIOD" | "POLICY_EXCEPTION" | null;
  version: number;
  bookingId: string | null;
  requestedByMemberId: string;
  proposalSnapshot: unknown;
  proposalHash: string | null;
  frozenEvidence: unknown;
  aggregateCapacityMode: PolicyExceptionCapacityMode | null;
}

// ---------------------------------------------------------------------------
// Request store (#2526): the two tables an exception request can live in
// ---------------------------------------------------------------------------

/**
 * The row-level operations the approval algorithm performs, factored out so the
 * SAME algorithm decides both request flavours (#2526).
 *
 * A MODIFICATION request is a `POLICY_EXCEPTION` row on the shared
 * `BookingChangeRequest` table; a NEW_BOOKING request is a row on its own
 * `NewBookingPolicyExceptionRequest` table (it cannot live on the shared one —
 * `bookingId` there is a required FK and a new booking has no row yet). Only the
 * five reads/writes below differ; the lock order, the fresh-role
 * reauthorization, the guarded CAS discipline, the drift gate, the capacity
 * recheck and the post-commit hand-off are identical, and duplicating them per
 * table is exactly how the two would drift apart.
 */
export interface PolicyExceptionRequestStore {
  /** Which table this store reads. */
  readonly source: "MODIFICATION" | "NEW_BOOKING";
  /**
   * Whether a HELD request in this store actually reserves beds while pending.
   *
   * The whole reason the HOLD capacity recheck happens AFTER the claim is that a
   * holding request's own reservation would otherwise count against itself. A
   * store that reserves nothing has no such problem, so it is rechecked BEFORE
   * the claim like a NO_HOLD request — which is what lets a conflict be RECORDED
   * (conflictCount / lastConflictAt / lastConflictReason) and committed, instead
   * of being thrown away with the rolled-back transaction (#2526 review). The
   * officer card and the member's own list read exactly those fields to explain
   * why a request is still pending.
   */
  readonly holdsReservation: boolean;
  /** Immutable pre-read used only to resolve the lodge for the lock. */
  preRead(
    tx: PrismaTransactionClient,
    requestId: string,
  ): Promise<{ proposalSnapshot: unknown } | null>;
  /**
   * Full fresh read under the locks, with the stored JSON left UNPARSED — the
   * engine owns the parse so "row is missing / wrong kind" (notFound) stays
   * distinguishable from "row is there but its snapshot will not parse"
   * (tampered), and both stores answer the two cases identically.
   */
  read(
    tx: PrismaTransactionClient,
    requestId: string,
  ): Promise<StoredPolicyExceptionRequestRow | null>;
  /** Guarded conflict bump; returns how many rows moved (1 = claimed). */
  recordConflict(
    tx: PrismaTransactionClient,
    args: { requestId: string; expectedVersion: number; message: string },
  ): Promise<number>;
  /** Guarded REQUESTED -> APPROVED CAS; returns how many rows moved. */
  claimApproved(
    tx: PrismaTransactionClient,
    args: { requestId: string; expectedVersion: number; actorMemberId: string },
  ): Promise<number>;
  /** Guarded REQUESTED -> terminal CAS; returns how many rows moved. */
  claimTerminal(
    tx: PrismaTransactionClient,
    args: {
      requestId: string;
      expectedVersion: number;
      to: PolicyExceptionTerminalStatus;
      actorMemberId?: string;
      supersededByRequestId?: string;
      /**
       * The officer's MEMBER-FACING decision explanation (#2562). Written to
       * `adminNotes`, which the member reads on their own request list.
       */
      adminNotes?: string;
      /**
       * The officer's PRIVATE note (#2562). Written to `internalNotes`, which no
       * member-facing projection, route select, email or notification names.
       */
      internalNotes?: string;
    },
  ): Promise<number>;
  /** Release the provisional reservation; returns rows deleted. */
  releaseReservation(
    tx: PrismaTransactionClient,
    requestId: string,
  ): Promise<number>;
}

/**
 * MODIFICATION requests: `POLICY_EXCEPTION` rows on `BookingChangeRequest`. The
 * `kind` guard is on EVERY read and claim so a locked-period row sharing the
 * table can never be reached by this workflow.
 */
export const modificationExceptionRequestStore: PolicyExceptionRequestStore = {
  source: "MODIFICATION",
  holdsReservation: true,

  async preRead(tx, requestId) {
    const row = await tx.bookingChangeRequest.findUnique({
      where: { id: requestId },
      select: { proposalSnapshot: true, kind: true },
    });
    if (!row || row.kind !== "POLICY_EXCEPTION") return null;
    return { proposalSnapshot: row.proposalSnapshot };
  },

  async read(tx, requestId) {
    const row = await tx.bookingChangeRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        kind: true,
        version: true,
        bookingId: true,
        requestedByMemberId: true,
        proposalSnapshot: true,
        proposalHash: true,
        frozenEvidence: true,
        aggregateCapacityMode: true,
      },
    });
    if (!row || row.kind !== "POLICY_EXCEPTION") return null;
    return {
      id: row.id,
      status: row.status as PolicyExceptionRequestStatus,
      kind: row.kind,
      version: row.version,
      bookingId: row.bookingId,
      requestedByMemberId: row.requestedByMemberId,
      proposalSnapshot: row.proposalSnapshot,
      proposalHash: row.proposalHash,
      frozenEvidence: row.frozenEvidence,
      aggregateCapacityMode: row.aggregateCapacityMode,
    };
  },

  async recordConflict(tx, { requestId, expectedVersion, message }) {
    const bumped = await tx.bookingChangeRequest.updateMany({
      where: { id: requestId, status: "REQUESTED", version: expectedVersion },
      data: {
        version: { increment: 1 },
        conflictCount: { increment: 1 },
        lastConflictAt: new Date(),
        lastConflictReason: message.slice(0, 500),
      },
    });
    return bumped.count;
  },

  async claimApproved(tx, { requestId, expectedVersion, actorMemberId }) {
    const claim = await tx.bookingChangeRequest.updateMany({
      where: {
        id: requestId,
        status: "REQUESTED",
        version: expectedVersion,
        kind: "POLICY_EXCEPTION",
      },
      data: {
        status: "APPROVED",
        version: { increment: 1 },
        reviewedByMemberId: actorMemberId,
        reviewedAt: new Date(),
        // Free the #2524 one-open-request slot on APPROVAL too. APPROVED is a
        // terminal status, so leaving `openStateKey` non-null would PERMANENTLY
        // block the member from ever opening another policy-exception request on
        // this booking — createModification's NULL-distinct unique index would
        // reject it with P2002. The terminal-release path nulls it; the approve
        // path must mirror that or the member is locked out for good.
        openStateKey: null,
      },
    });
    return claim.count;
  },

  async claimTerminal(
    tx,
    {
      requestId,
      expectedVersion,
      to,
      actorMemberId,
      supersededByRequestId,
      adminNotes,
      internalNotes,
    },
  ) {
    const now = new Date();
    const claim = await tx.bookingChangeRequest.updateMany({
      where: {
        id: requestId,
        status: "REQUESTED",
        version: expectedVersion,
        kind: "POLICY_EXCEPTION",
      },
      data: {
        status: to,
        version: { increment: 1 },
        // Free the #2524 one-open-request slot: a terminal request no longer
        // holds it, so the member may open a fresh proposal. Matches the request
        // service's own member cancel/supersede claims, which NULL it too.
        openStateKey: null,
        ...(to === "REJECTED"
          ? { reviewedByMemberId: actorMemberId ?? null, reviewedAt: now }
          : {}),
        ...(to === "CANCELLED" ? { cancelledAt: now } : {}),
        ...(to === "SUPERSEDED" && supersededByRequestId
          ? { supersededByRequestId }
          : {}),
        ...(adminNotes !== undefined ? { adminNotes: adminNotes || null } : {}),
        // #2562: the private half of the decision, stored beside the member-facing
        // half and never rendered with it.
        ...(internalNotes !== undefined
          ? { internalNotes: internalNotes || null }
          : {}),
      },
    });
    return claim.count;
  },

  releaseReservation(tx, requestId) {
    return releasePolicyExceptionReservation(tx, requestId);
  },
};

/**
 * NEW_BOOKING requests: rows on `NewBookingPolicyExceptionRequest`.
 *
 * `releaseReservation` is a no-op returning 0 — the provisional-reservation
 * ledger is keyed on `BookingChangeRequest`, so a new-booking request holds no
 * beds while pending (tracked separately; the approval's own capacity recheck
 * and the canonical create service's hard refusal are what keep it from
 * overselling).
 */
export const newBookingExceptionRequestStore: PolicyExceptionRequestStore = {
  source: "NEW_BOOKING",
  // Nothing is reserved, so nothing can count against itself: this store's
  // capacity recheck runs BEFORE the claim and records its conflict.
  holdsReservation: false,

  async preRead(tx, requestId) {
    const row = await tx.newBookingPolicyExceptionRequest.findUnique({
      where: { id: requestId },
      select: { proposalSnapshot: true },
    });
    return row ? { proposalSnapshot: row.proposalSnapshot } : null;
  },

  async read(tx, requestId) {
    const row = await tx.newBookingPolicyExceptionRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        version: true,
        requestedByMemberId: true,
        proposalSnapshot: true,
        proposalHash: true,
        frozenEvidence: true,
        aggregateCapacityMode: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      status: row.status as PolicyExceptionRequestStatus,
      kind: null,
      version: row.version,
      bookingId: null,
      requestedByMemberId: row.requestedByMemberId,
      proposalSnapshot: row.proposalSnapshot,
      proposalHash: row.proposalHash,
      frozenEvidence: row.frozenEvidence,
      aggregateCapacityMode: row.aggregateCapacityMode,
    };
  },

  async recordConflict(tx, { requestId, expectedVersion, message }) {
    const bumped = await tx.newBookingPolicyExceptionRequest.updateMany({
      where: { id: requestId, status: "REQUESTED", version: expectedVersion },
      data: {
        version: { increment: 1 },
        conflictCount: { increment: 1 },
        lastConflictAt: new Date(),
        lastConflictReason: message.slice(0, 500),
      },
    });
    return bumped.count;
  },

  async claimApproved(tx, { requestId, expectedVersion, actorMemberId }) {
    const claim = await tx.newBookingPolicyExceptionRequest.updateMany({
      where: { id: requestId, status: "REQUESTED", version: expectedVersion },
      data: {
        status: "APPROVED",
        version: { increment: 1 },
        reviewedByMemberId: actorMemberId,
        reviewedAt: new Date(),
        openStateKey: null,
      },
    });
    return claim.count;
  },

  async claimTerminal(
    tx,
    {
      requestId,
      expectedVersion,
      to,
      actorMemberId,
      supersededByRequestId,
      adminNotes,
      internalNotes,
    },
  ) {
    const now = new Date();
    const claim = await tx.newBookingPolicyExceptionRequest.updateMany({
      where: { id: requestId, status: "REQUESTED", version: expectedVersion },
      data: {
        status: to,
        version: { increment: 1 },
        openStateKey: null,
        ...(to === "REJECTED"
          ? { reviewedByMemberId: actorMemberId ?? null, reviewedAt: now }
          : {}),
        ...(to === "CANCELLED" ? { cancelledAt: now } : {}),
        ...(to === "SUPERSEDED" && supersededByRequestId
          ? { supersededByRequestId }
          : {}),
        ...(adminNotes !== undefined ? { adminNotes: adminNotes || null } : {}),
        // #2562: the private half of the decision, stored beside the member-facing
        // half and never rendered with it.
        ...(internalNotes !== undefined
          ? { internalNotes: internalNotes || null }
          : {}),
      },
    });
    return claim.count;
  },

  async releaseReservation() {
    return 0;
  },
};

/** The confirmed override the executor must apply: exactly the reviewed
 * soft-violations that STILL trip unchanged, plus the ones that DISAPPEARED (for
 * which the execution runs WITHOUT an override and records the resolution). */
export interface ConfirmedOverride {
  /** Reviewed violations still tripping — the approval MAY override these. */
  overridable: PolicyExceptionDriftResult["overridable"];
  /** Reviewed violations that no longer trip — record resolution, no override. */
  clearedReviewed: PolicyExceptionDriftResult["clearedReviewed"];
}

/**
 * What a live-integrity check answers. `true` / `false` keep the original boolean
 * contract; the object form names the failure so the caller can report it
 * truthfully.
 *
 *  - `drift` — the live booking (or the replayed delta) no longer reproduces the
 *    reviewed proposal. Resubmission is the remedy AND the reason is true.
 *  - `unreplayable` — the request carries no replayable delta at all (a row
 *    written before the format existed, or one hand-edited into nonsense).
 *    Resubmission is still the remedy, but nothing about the booking moved.
 */
export type PolicyExceptionIntegrityResult =
  | boolean
  | { intact: boolean; reason?: "drift" | "unreplayable" };

export interface PolicyExceptionApprovalHooks {
  /** Re-read the actor's CURRENT roles/permissions from the DB (never the
   * session snapshot) and return whether they may approve. Runs inside the
   * approval transaction, before any write. */
  reauthorizeBookingOfficer(
    tx: PrismaTransactionClient,
    actorMemberId: string,
  ): Promise<boolean>;
  /** Re-evaluate the FROZEN proposal against today's policy configuration.
   * Returns the current covered soft-violations (empty when the proposal now
   * satisfies every reviewed rule). #2364 evaluators. */
  evaluateCurrentViolations(
    snapshot: ExceptionProposalSnapshot,
    tx: PrismaTransactionClient,
    request: LoadedPolicyExceptionRequest,
  ): Promise<PolicyExceptionViolation[]>;
  /** NO_HOLD capacity recheck against the frozen proposal, under the per-lodge
   * lock already held. `ok: false` keeps the request PENDING with `message`. */
  recheckCapacity(
    snapshot: ExceptionProposalSnapshot,
    tx: PrismaTransactionClient,
  ): Promise<{ ok: boolean; message?: string }>;
  /** Map the frozen snapshot to the canonical booking service and run it on
   * `tx`, returning the service's deferred post-commit thunk. The #2524 seam. */
  executeApprovedProposal(args: {
    tx: PrismaTransactionClient;
    request: LoadedPolicyExceptionRequest;
    snapshot: ExceptionProposalSnapshot;
    override: ConfirmedOverride;
  }): Promise<{ deferredPostCommit: () => Promise<void> }>;
  /** Optional live-proposal integrity check beyond the tamper hash — for a
   * MODIFICATION, prove the live booking's base footprint still matches the
   * frozen `base` party (#2524 owns the booking->party mapping). Absent => the
   * tamper hash is the only integrity gate.
   *
   * A bare `false` is still accepted (it means "drift"); returning the richer
   * result lets the hook say WHICH kind of failure it was, so a request that
   * simply predates the replayable-delta format is not reported to the officer
   * and the member as a live booking that changed (#2526 review). */
  verifyLiveProposalIntegrity?(
    snapshot: ExceptionProposalSnapshot,
    tx: PrismaTransactionClient,
  ): Promise<PolicyExceptionIntegrityResult>;
  /** Post-commit member notification of the approval outcome. Optional. */
  notifyApproved?(request: LoadedPolicyExceptionRequest): Promise<void>;
}

export type ApprovePolicyExceptionResult =
  | {
      outcome: "executed";
      requestId: string;
      /**
       * The transaction committed, but the post-commit provider/notification
       * work threw. The approval IS done; only the follow-ups failed (#2526
       * review). Never a reason to report the request as still pending.
       */
      followUpFailed?: boolean;
    }
  | { outcome: "notFound" }
  | { outcome: "notAuthorized" }
  | { outcome: "claimLost" }
  | { outcome: "proposalDrift"; message: string }
  | {
      outcome: "policyDrift";
      message: string;
      changedReviewed: PolicyExceptionDriftResult["changedReviewed"];
      newViolations: PolicyExceptionDriftResult["newViolations"];
    }
  | { outcome: "keptPendingCapacity"; message: string };

type ApprovalDb = Pick<typeof prisma, "$transaction">;

/**
 * A MODIFICATION approval reached the engine without a
 * {@link PolicyExceptionApprovalHooks.verifyLiveProposalIntegrity} hook. That
 * hook is the ONLY gate comparing a modification's frozen `base` party against
 * the live booking, so its absence for a MODIFICATION is a wiring bug that must
 * FAIL CLOSED and LOUD — never silently execute against a possibly-stale base.
 */
export class PolicyExceptionIntegrityHookMissingError extends Error {
  constructor() {
    super(
      "A modification policy-exception approval requires a live-proposal integrity check, but none was configured.",
    );
    this.name = "PolicyExceptionIntegrityHookMissingError";
  }
}

/**
 * Internal rollback signal for a HOLD approval whose post-release capacity
 * recheck found the lodge can no longer fit the proposal. Thrown inside the
 * approval transaction so Prisma ROLLS THE WHOLE APPROVAL BACK (undoing the
 * claim and the reservation release), leaving the request REQUESTED and pending
 * — then caught by the caller and surfaced as a graceful `keptPendingCapacity`
 * outcome instead of an executed overbook. Not exported: it never escapes this
 * module.
 */
class KeptPendingCapacitySignal extends Error {
  constructor(readonly capacityMessage: string) {
    super("kept-pending-capacity");
    this.name = "KeptPendingCapacitySignal";
  }
}

/**
 * Parse a stored `proposalSnapshot` JSON without trusting it. Returns null on
 * anything that is not a well-formed new-booking / modification snapshot, which
 * fails the approval closed rather than executing against nonsense.
 */
export function parseProposalSnapshot(
  value: unknown,
): ExceptionProposalSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "NEW_BOOKING") {
    if (typeof record.lodgeId !== "string" || !record.proposed) return null;
    return value as ExceptionProposalSnapshot;
  }
  if (record.kind === "MODIFICATION") {
    if (
      typeof record.lodgeId !== "string" ||
      typeof record.bookingId !== "string" ||
      !record.base ||
      !record.proposed
    ) {
      return null;
    }
    return value as ExceptionProposalSnapshot;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Approve and execute
// ---------------------------------------------------------------------------

/**
 * Atomically approve a HELD policy-exception request and execute the reviewed
 * proposal in ONE transaction — no mark-approved-then-call-service gap.
 *
 * Sequence (all inside the approval transaction):
 *
 *  1. Pre-read only the immutable frozen `lodgeId`, then take global lock(1),
 *     then the per-lodge capacity lock (the canonical service re-enters the
 *     lodge lock and takes member-night / member-credit after it, preserving
 *     global -> lodge -> member order).
 *  2. Reauthorize from FRESH DB roles. A failure writes nothing.
 *  3. Re-read the request FRESH under the locks; require REQUESTED,
 *     POLICY_EXCEPTION, and the expected `version` (optimistic token). A miss
 *     is a lost claim with no side effect.
 *  4. Recompute the proposal hash from the stored snapshot (tamper gate) and,
 *     for a modification, run the optional live-integrity check. A mismatch keeps
 *     the request out of execution and reports proposal drift (resubmission).
 *  5. Re-evaluate the frozen proposal against today's policy and classify drift.
 *     A materially-changed or new violation keeps it REQUESTED and reports policy
 *     drift; a disappeared reviewed rule executes WITHOUT overriding it.
 *  6. For a NO_HOLD aggregate (nothing was reserved) recheck capacity; a conflict
 *     keeps the request REQUESTED with a recorded reason (it does NOT fail it).
 *  7. Guarded `version` CAS claim REQUESTED -> APPROVED. A lost claim runs NO
 *     side effect.
 *  8. Release the provisional reservation (delete its night rows) — atomic with
 *     the claim; for a HOLD request its beds are immediately re-taken by the
 *     executed booking, for NO_HOLD there is nothing to release.
 *  9. Invoke the tx-aware canonical service on this same transaction, capturing
 *     its deferred post-commit thunk.
 * 10. AFTER commit: run the canonical provider work and the member approval
 *     notification.
 */
export async function approveAndExecutePolicyExceptionRequest(params: {
  requestId: string;
  expectedVersion: number;
  actorMemberId: string;
  hooks: PolicyExceptionApprovalHooks;
  /**
   * Which table the request lives in (#2526). Defaults to the MODIFICATION store
   * (`POLICY_EXCEPTION` rows on `BookingChangeRequest`), which is what every
   * pre-#2526 caller means.
   */
  store?: PolicyExceptionRequestStore;
  db?: ApprovalDb;
}): Promise<ApprovePolicyExceptionResult> {
  const db = params.db ?? prisma;
  const { requestId, expectedVersion, actorMemberId, hooks } = params;
  const store = params.store ?? modificationExceptionRequestStore;

  // Captured inside the transaction so provider work fires strictly AFTER commit.
  let canonicalDeferred: (() => Promise<void>) | null = null;
  let approvedRequest: LoadedPolicyExceptionRequest | null = null;

  let result: ApprovePolicyExceptionResult;
  try {
    result = await db.$transaction(
    async (tx): Promise<ApprovePolicyExceptionResult> => {
      // (1) Pre-read the immutable frozen lodge, then lock global -> per-lodge.
      const preRead = await store.preRead(tx, requestId);
      if (!preRead) return { outcome: "notFound" };
      const preSnapshot = parseProposalSnapshot(preRead.proposalSnapshot);
      if (!preSnapshot) return { outcome: "notFound" };

      await acquireGlobalBookingLock(tx);
      await acquireLodgeCapacityLock(tx, preSnapshot.lodgeId);

      // (2) Reauthorize from fresh DB roles. No write yet, so a refusal is clean.
      const authorized = await hooks.reauthorizeBookingOfficer(tx, actorMemberId);
      if (!authorized) return { outcome: "notAuthorized" };

      // (3) Re-read the request FRESH under the locks.
      // `read` returns null only for a missing or wrong-kind row (notFound); an
      // unparseable snapshot comes back as a row and is reported as tampering.
      const row = await store.read(tx, requestId);
      if (!row) return { outcome: "notFound" };
      if (row.status !== "REQUESTED" || row.version !== expectedVersion) {
        return { outcome: "claimLost" };
      }
      const snapshot = parseProposalSnapshot(row.proposalSnapshot);
      if (!snapshot || row.proposalHash == null) {
        return { outcome: "proposalDrift", message: PROPOSAL_TAMPERED_MESSAGE };
      }

      const request: LoadedPolicyExceptionRequest = {
        id: row.id,
        status: row.status,
        kind: row.kind,
        version: row.version,
        bookingId: row.bookingId,
        requestedByMemberId: row.requestedByMemberId,
        proposalSnapshot: snapshot,
        proposalHash: row.proposalHash,
        frozenEvidence: row.frozenEvidence,
        aggregateCapacityMode: row.aggregateCapacityMode,
      };

      // (4) Tamper gate + optional live-integrity (modification base drift).
      if (computeProposalHash(snapshot) !== row.proposalHash) {
        return { outcome: "proposalDrift", message: PROPOSAL_TAMPERED_MESSAGE };
      }
      if (hooks.verifyLiveProposalIntegrity) {
        const integrity = await hooks.verifyLiveProposalIntegrity(snapshot, tx);
        const intact =
          typeof integrity === "boolean" ? integrity : integrity.intact;
        if (!intact) {
          const reason =
            typeof integrity === "boolean" ? "drift" : integrity.reason ?? "drift";
          return {
            outcome: "proposalDrift",
            message:
              reason === "unreplayable"
                ? PROPOSAL_UNREPLAYABLE_MESSAGE
                : PROPOSAL_DRIFT_MESSAGE,
          };
        }
      } else if (snapshot.kind === "MODIFICATION") {
        // FAIL CLOSED (#2525): for a MODIFICATION the live booking may have
        // drifted from the frozen `base` since the request was made, and this
        // hook is the ONLY gate comparing frozen base vs live. Absent, we cannot
        // prove the live footprint still matches — so refuse LOUDLY rather than
        // execute against a possibly-stale base (which the tamper hash, computed
        // over the FROZEN snapshot alone, cannot catch). New-booking snapshots
        // have no live base to drift and legitimately run without this hook.
        throw new PolicyExceptionIntegrityHookMissingError();
      }

      // (5) Policy drift: evaluate current violations of the frozen proposal.
      const evidence = parseFrozenEvidence(row.frozenEvidence);
      if (!evidence) {
        return { outcome: "proposalDrift", message: PROPOSAL_TAMPERED_MESSAGE };
      }
      const reviewed = reviewedViolationsFromEvidence(evidence);
      const current = await hooks.evaluateCurrentViolations(snapshot, tx, request);
      const drift = classifyPolicyExceptionDrift(reviewed, current);
      if (!drift.executable) {
        return {
          outcome: "policyDrift",
          message: POLICY_DRIFT_MESSAGE,
          changedReviewed: drift.changedReviewed,
          newViolations: drift.newViolations,
        };
      }

      // (6) Pre-claim capacity recheck. A conflict keeps it PENDING (does not
      // fail) and RECORDS the reason, which is only possible before the claim —
      // the post-claim path at (8b) signals by rolling the transaction back, and
      // a rollback discards any conflict row written inside it.
      //
      // Reached whenever this request holds no beds of its own: a NO_HOLD
      // aggregate, or ANY request in a store that reserves nothing (a new-booking
      // request, whose reservation ledger does not exist — #2526 review). Only a
      // request that genuinely holds beds has to wait for (8b), because only its
      // own reservation could count against it.
      if (row.aggregateCapacityMode === "NO_HOLD" || !store.holdsReservation) {
        const capacity = await hooks.recheckCapacity(snapshot, tx);
        if (!capacity.ok) {
          const message = capacity.message ?? CAPACITY_CONFLICT_MESSAGE;
          const bumped = await store.recordConflict(tx, {
            requestId,
            expectedVersion,
            message,
          });
          if (bumped !== 1) return { outcome: "claimLost" };
          return { outcome: "keptPendingCapacity", message };
        }
      }

      // (7) Guarded version CAS claim REQUESTED -> APPROVED. Lost => no effect.
      const claim = await store.claimApproved(tx, {
        requestId,
        expectedVersion,
        actorMemberId,
      });
      if (claim !== 1) return { outcome: "claimLost" };

      // (8) Release the provisional reservation, atomic with the claim. For a
      // HOLD request the freed beds are immediately re-taken by the executed
      // booking below; for NO_HOLD nothing was reserved (count 0).
      await store.releaseReservation(tx, requestId);

      // (8b) HOLD capacity recheck (#2525). NO_HOLD was rechecked at (6) before
      // the claim; a HOLD request holds its own beds, so it is rechecked HERE —
      // after (8) just freed them — so its own reservation never counts against
      // itself. If the lodge genuinely no longer fits the proposal, roll the whole
      // approval back (undoing the claim and the release) via a signal the caller
      // turns into a graceful `keptPendingCapacity`, leaving the request REQUESTED
      // and pending exactly like the NO_HOLD conflict. The engine asserts capacity
      // itself rather than trusting the executor seam to be a hard refusal.
      if (row.aggregateCapacityMode !== "NO_HOLD" && store.holdsReservation) {
        const capacity = await hooks.recheckCapacity(snapshot, tx);
        if (!capacity.ok) {
          throw new KeptPendingCapacitySignal(
            capacity.message ?? CAPACITY_CONFLICT_MESSAGE,
          );
        }
      }

      // (9) Execute the reviewed proposal on THIS transaction (tx-aware canonical
      // service). The override is exactly the reviewed violations that still
      // trip; disappeared ones are recorded but never overridden.
      const executed = await hooks.executeApprovedProposal({
        tx,
        request,
        snapshot,
        override: {
          overridable: drift.overridable,
          clearedReviewed: drift.clearedReviewed,
        },
      });
      canonicalDeferred = executed.deferredPostCommit;
      approvedRequest = request;
      return { outcome: "executed", requestId };
    },
    );
  } catch (error) {
    // The HOLD post-release recheck (8b) rolled the whole approval back because
    // the lodge no longer fits the proposal. Surface it as the graceful
    // pending outcome; the request is untouched (still REQUESTED at its version).
    if (error instanceof KeptPendingCapacitySignal) {
      // The rollback undid the claim and the release — and it would also have
      // undone a conflict row written inside that transaction, which is why the
      // conflict is recorded HERE, in its own committed transaction (#2526
      // review). Guarded on the same `expectedVersion`, so it is a no-op if the
      // row has since moved; a failure to record must never turn an honest
      // kept-pending answer into an error, so it is logged and swallowed.
      try {
        await db.$transaction((tx) =>
          store.recordConflict(tx, {
            requestId,
            expectedVersion,
            message: error.capacityMessage,
          }),
        );
      } catch (recordError) {
        logger.error(
          { err: recordError, requestId },
          "Failed to record a kept-pending capacity conflict after rollback",
        );
      }
      return { outcome: "keptPendingCapacity", message: error.capacityMessage };
    }
    throw error;
  }

  // (10) Post-commit provider work + member notification, only on execution.
  //
  // THE TRANSACTION HAS ALREADY COMMITTED. The request is APPROVED and the
  // booking exists, so a failure here can never mean "the approval did not
  // happen" — and reporting it as one is exactly the false keep-pending this
  // workflow exists to make impossible (#2526 review). The canonical services'
  // post-commit thunks await unguarded provider/audit calls, so a transient
  // failure is a real possibility. Contain it: the outcome stays `executed` and
  // carries `followUpFailed`, which the route reports as "approved, but some
  // follow-up work failed".
  if (result.outcome === "executed") {
    const followUpErrors: unknown[] = [];
    if (canonicalDeferred) {
      try {
        await (canonicalDeferred as () => Promise<void>)();
      } catch (error) {
        followUpErrors.push(error);
      }
    }
    if (hooks.notifyApproved && approvedRequest) {
      try {
        await hooks.notifyApproved(approvedRequest);
      } catch (error) {
        followUpErrors.push(error);
      }
    }
    if (followUpErrors.length > 0) {
      logger.error(
        { errs: followUpErrors, requestId },
        "Booking-policy exception approval committed, but post-commit follow-up work failed",
      );
      return { ...result, followUpFailed: true };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Terminal release (reject / cancel / supersede)
// ---------------------------------------------------------------------------

export type PolicyExceptionTerminalStatus =
  | "REJECTED"
  | "CANCELLED"
  | "SUPERSEDED"
  // #2553: the provisional hold ran out before anybody decided the request, so
  // the reaper cron closes it here — through this SAME helper, never a forked
  // release path.
  | "EXPIRED";

/**
 * Why this helper refused a row BEFORE it ever reached the guarded claim. A
 * refusal is PERMANENT for that row — retrying changes nothing — which is exactly
 * what separates it from an ordinary lost claim, where the next read sees the
 * fresh version and succeeds. An unattended caller (the #2553 reaper) has to be
 * able to tell the two apart, or a row it can never resolve looks like a race it
 * lost and its stranded beds stay invisible behind a green cron-health row.
 */
export type ResolveTerminalRefusal =
  /** Missing row, or a row that is not a POLICY_EXCEPTION request. */
  | "not-policy-exception"
  /** `proposalSnapshot` does not parse, so there is no lodge to lock. */
  | "unreadable-proposal";

export interface ResolveTerminalResult {
  /** Whether the guarded claim moved the row (a lost claim runs no release). */
  claimed: boolean;
  /** How many reservation night rows were released (0 for a NO_HOLD request). */
  released: number;
  /**
   * Set only when `claimed` is false AND the refusal is permanent (see
   * {@link ResolveTerminalRefusal}). Absent means the ordinary optimistic-claim
   * loss: somebody else moved the row first and already dealt with its beds.
   */
  refused?: ResolveTerminalRefusal;
}

/**
 * Atomically move a HELD policy-exception request to a terminal RELEASING status
 * (REJECTED by an officer, CANCELLED by the member, SUPERSEDED by a newer
 * proposal, or EXPIRED by the #2553 hold reaper) and release its provisional
 * reservation in the SAME guarded transaction.
 *
 * The guarded `version` CAS is the single-flight: a lost claim (someone already
 * moved the row, or the version advanced) releases NOTHING and runs no side
 * effect. Locks compose the house order — global lock(1) first, then the
 * per-lodge capacity lock keyed on the frozen lodge — because the release is a
 * capacity change and must serialise against every occupancy read/claim at that
 * lodge. Provider notifications are the caller's post-commit concern.
 *
 * Two pre-claim checks can refuse the row outright — it is not a
 * POLICY_EXCEPTION request, or its `proposalSnapshot` does not parse (so there is
 * no lodge to lock). Those cases return `claimed: false` WITH a `refused` reason,
 * because unlike a lost claim they never resolve on a retry; the reaper counts and
 * logs them rather than assuming a decision won the race.
 */
export async function resolvePolicyExceptionRequestTerminal(params: {
  requestId: string;
  expectedVersion: number;
  to: PolicyExceptionTerminalStatus;
  actorMemberId?: string;
  supersededByRequestId?: string;
  /** The officer's MEMBER-FACING decision explanation (#2562). */
  adminNotes?: string;
  /** The officer's PRIVATE note (#2562); never reaches a member surface. */
  internalNotes?: string;
  /** Which table the request lives in (#2526). Defaults to MODIFICATION. */
  store?: PolicyExceptionRequestStore;
  db?: ApprovalDb;
}): Promise<ResolveTerminalResult> {
  const db = params.db ?? prisma;
  const {
    requestId,
    expectedVersion,
    to,
    actorMemberId,
    supersededByRequestId,
    adminNotes,
    internalNotes,
  } = params;
  const store = params.store ?? modificationExceptionRequestStore;

  return db.$transaction(async (tx): Promise<ResolveTerminalResult> => {
    // The store's own preRead applies the kind guard, so null covers BOTH a
    // missing row and a row of the wrong kind — the one combined refusal the
    // ResolveTerminalRefusal doc promises.
    const preRead = await store.preRead(tx, requestId);
    if (!preRead) {
      return { claimed: false, released: 0, refused: "not-policy-exception" };
    }
    const snapshot = parseProposalSnapshot(preRead.proposalSnapshot);
    if (!snapshot) {
      return { claimed: false, released: 0, refused: "unreadable-proposal" };
    }

    await acquireGlobalBookingLock(tx);
    await acquireLodgeCapacityLock(tx, snapshot.lodgeId);

    const claim = await store.claimTerminal(tx, {
      requestId,
      expectedVersion,
      to,
      actorMemberId,
      supersededByRequestId,
      adminNotes,
      internalNotes,
    });
    if (claim !== 1) return { claimed: false, released: 0 };

    const released = await store.releaseReservation(tx, requestId);
    return { claimed: true, released };
  });
}

// ---------------------------------------------------------------------------
// Messages
//
// A refusal states what WAS established plus the next step, never a cause the
// engine cannot distinguish (`INV-EXCEPT-035`, #3089): a replay mismatch is a
// live edit OR corrected code re-deriving the evidence (#3087); a moved
// fingerprint is a policy edit OR only a re-derived night set. A cause it DID
// observe — an unreplayable row (#2526) — keeps its own words.
// ---------------------------------------------------------------------------

export const PROPOSAL_TAMPERED_MESSAGE =
  "This request's stored proposal no longer matches its signature. Please resubmit the request.";
export const PROPOSAL_DRIFT_MESSAGE =
  "This request can no longer be applied exactly as it was reviewed, so nothing has been changed. Ask the member to submit it again, then review it against the booking as it stands now.";
export const PROPOSAL_UNREPLAYABLE_MESSAGE =
  "This request was made before the current approval format and cannot be applied. Ask the member to resubmit it; nothing about the booking has changed.";
export const POLICY_DRIFT_MESSAGE =
  "The exceptions this request needs are no longer the ones that were reviewed, so nothing has been changed. Ask the member to submit it again, then review it against the situation as it stands now.";
export const CAPACITY_CONFLICT_MESSAGE =
  "The lodge no longer has room for this booking. The request stays pending so it can be approved once capacity frees up.";
