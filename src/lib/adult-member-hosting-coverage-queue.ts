import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import type { HostingCoverageIncidentCause } from "@/lib/adult-member-hosting-coverage-incidents";
import {
  assertHostingCoverageQueueParticipantsLocked,
  type HostingCoverageQueueParticipantProof,
} from "@/lib/adult-member-hosting-queue-participants";

/**
 * The durable queue of BOUNDED same-owner re-evaluation work (#2576 §8).
 *
 * Storage mechanics only — enqueue, claim, complete. The policy that decides what
 * an item MEANS lives in `adult-member-hosting-coverage-drain.ts`, and the split
 * is what keeps the import graph acyclic: the hosting reconciler enqueues (so it
 * imports this), and the drain reconciles (so it imports the reconciler).
 *
 * WHY A QUEUE AT ALL. §8 lists the changes that cannot reasonably be blocked — a
 * membership lapsing, an administrative cancellation, a payment or lifecycle
 * failure, an automated transition, a data correction, an authorised officer
 * action — and requires that the re-evaluation they imply is "durably recorded in
 * the same transaction or equivalent reliable outbox mechanism", then run against
 * facts RE-READ AFTER COMMIT. Doing that work inline inside the authoritative
 * transaction would fail all three parts: it would read uncommitted facts, it
 * would extend a money/status transaction across several other bookings, and a
 * failure in it would roll back a change the club had already authorised.
 *
 * AT-LEAST-ONCE, NEVER AT-MOST-ONCE. An item is claimed, processed and completed;
 * a crash between claim and completion leaves it unprocessed and the general cron
 * sweep re-runs it. Every downstream effect is therefore built to be idempotent —
 * see `openOrUpdateHostingCoverageIncident` and
 * `claimHostingCoverageOwnerNotification`.
 */

export type HostingCoverageQueueDb = Pick<
  PrismaClient,
  "hostingCoverageReevaluation"
>;

export interface HostingCoverageReevaluationInput {
  /** The booking OWNER whose same-owner bookings need re-evaluating (§1, §10). */
  memberId: string;
  /** The affected lodge — exact, never a fan-out (§4, §10). */
  lodgeId: string;
  /** The affected NZ lodge-nights (YYYY-MM-DD). Sorted and de-duplicated here. */
  nights: readonly string[];
  cause: HostingCoverageIncidentCause;
  sourceBookingId?: string | null;
  actorMemberId?: string | null;
  reason?: string | null;
}

export interface HostingCoverageReevaluationItem {
  id: string;
  memberId: string;
  lodgeId: string;
  nights: string[];
  cause: HostingCoverageIncidentCause;
  sourceBookingId: string | null;
  actorMemberId: string | null;
  reason: string | null;
  attempts: number;
  /** Opaque ownership proof for this one delivery attempt. */
  claimToken: string;
}

export type HostingCoverageReevaluationClaim = Pick<
  HostingCoverageReevaluationItem,
  "id" | "claimToken"
>;

const HOSTING_COVERAGE_REEVALUATION_LEASE_MS = 15 * 60 * 1000;

/**
 * Record one bounded unit of re-evaluation work, INSIDE the caller's transaction.
 *
 * In the transaction on purpose, and it is the whole reliability argument: the
 * authoritative change and the obligation to look at its consequences commit or
 * roll back together. There is no window in which a membership lapse is committed
 * and the club has no record that somebody has to check what it broke.
 *
 * Returns null when there is nothing to record — no nights, which happens for a
 * change that touched no lodge-night at all — rather than writing an item the
 * drain would have to recognise as empty.
 */
export async function enqueueHostingCoverageReevaluation(
  input: HostingCoverageReevaluationInput,
  participantProof: HostingCoverageQueueParticipantProof,
  db: HostingCoverageQueueDb,
): Promise<string | null> {
  // The storage primitive is the final authority boundary. A caller cannot
  // bypass the participant fence with a cast: proofs are runtime-issued and
  // tracked privately by adult-member-hosting-queue-participants.ts.
  assertHostingCoverageQueueParticipantsLocked(participantProof, input);
  const nights = [...new Set(input.nights)].sort();
  if (nights.length === 0) return null;
  const row = await db.hostingCoverageReevaluation.create({
    data: {
      memberId: input.memberId,
      lodgeId: input.lodgeId,
      nights: nights as unknown as Prisma.InputJsonValue,
      cause: input.cause,
      sourceBookingId: input.sourceBookingId ?? null,
      actorMemberId: input.actorMemberId ?? null,
      reason: input.reason ? input.reason.trim().slice(0, 500) : null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Claim up to `limit` unprocessed items, oldest first.
 *
 * A GUARDED, EXPIRING CLAIM per row rather than a `SELECT ... FOR UPDATE SKIP
 * LOCKED` batch, because processing and provider delivery deliberately happen
 * after the claim transaction. The opaque token is the ownership proof used by
 * completion and failure; `claimExpiresAt` is what makes a crashed worker
 * retryable without making an item visible while a live worker still owns it.
 * Two simultaneous or staggered drains therefore split the work instead of
 * repeatedly incrementing `attempts` for the same in-flight item.
 *
 * `attempts` is incremented AT CLAIM TIME, not on failure. A poison item that
 * throws every time therefore still counts up, and `maxAttempts` retires it —
 * whereas incrementing on failure loses the count whenever the process dies mid
 * item, which is the failure mode most likely to be repeated.
 *
 * `memberId` AND `lodgeId` NARROW THE CLAIM, AND THE INLINE DRAIN ALWAYS SUPPLIES
 * THEM. An unfiltered claim is right for the cron and wrong inside a member's
 * request: after an officer's bulk cancellation or a membership sweep leaves a
 * backlog, the next unrelated member's guest edit would claim up to 25 items
 * belonging to OTHER owners at OTHER lodges, fan each out to as many as 25
 * dependents, and await a multi-query reconciliation plus a synchronous
 * loss-of-cover email for each — all before answering a request that had nothing to
 * do with any of it. Correctness survived (failures are swallowed and the cron
 * re-runs the items) but the route could hang. Filtered, the inline drain does
 * exactly the work its own transaction created.
 *
 * `sourceBookingIds` IS THE CROSS-ACCOUNT HALF OF THE SAME NARROWING (#3039), and
 * it is keyed on the BOOKING rather than the owner for a reason worth stating.
 *
 * A Group Trip fan-out writes items for OTHER accounts: one per sibling booking,
 * each naming that sibling's own owner as `memberId`. A claim narrowed to the single
 * owner whose booking was written therefore skips every one of them, and a stranded
 * sibling waits up to three hours for the cron instead of being escalated with the
 * change. That much needed fixing.
 *
 * WIDENING TO THE SIBLING OWNERS WOULD HAVE FIXED IT AND BROKEN SOMETHING ELSE. An
 * owner filter carries no lower bound and this claim is oldest-first, so a sibling
 * owner sitting on a dozen unrelated stale items would have filled every inline slot
 * with THEIR backlog — each fanning out to as many as the dependent ceiling and each
 * able to send a synchronous loss-of-cover email — inside the actor's request, while
 * the actor's own fresh items were not drained inline at all. That is exactly the
 * hazard the single-owner filter existed to prevent, reintroduced across accounts.
 *
 * Keying on `sourceBookingId` closes it exactly: the caller passes the trip's
 * dependent BOOKING ids, so the only cross-account items this claim can reach are
 * items about bookings in the very trip the committed change touched. An older
 * unprocessed item about one of those bookings is not somebody else's backlog — it
 * is the same booking's overdue re-evaluation, and settling it is the same
 * idempotent existential re-read. The list is bounded by the trip
 * (`GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT`).
 *
 * The two arms are OR-ed: the written booking's own owner, or a dependent booking of
 * its trip. Under `AND` rather than beside the lease disjunction above, because two
 * `OR` keys at one level keep only the last — which would silently drop the lease
 * filter and let a live worker's in-flight item be re-claimed.
 */
export async function claimHostingCoverageReevaluations(
  options: {
    limit?: number;
    maxAttempts?: number;
    memberId?: string | null;
    /**
     * The trip's dependent bookings, whose items belong to OTHER accounts. Unioned
     * with `memberId` rather than replacing it: the claim is "this owner's items, or
     * an item about one of these bookings".
     */
    sourceBookingIds?: readonly string[] | null;
    lodgeId?: string | null;
    /** Rows already attempted by this drain; a released failure must not be reclaimed inline. */
    excludeIds?: readonly string[];
  } = {},
  db: HostingCoverageQueueDb,
): Promise<HostingCoverageReevaluationItem[]> {
  const limit = options.limit ?? 25;
  const maxAttempts = options.maxAttempts ?? 5;
  const claimedAt = new Date();
  const candidates = await db.hostingCoverageReevaluation.findMany({
    where: {
      processedAt: null,
      attempts: { lt: maxAttempts },
      OR: [{ claimToken: null }, { claimExpiresAt: { lt: claimedAt } }],
      ...(options.excludeIds && options.excludeIds.length > 0
        ? { id: { notIn: [...options.excludeIds] } }
        : {}),
      ...(options.sourceBookingIds && options.sourceBookingIds.length > 0
        ? {
            AND: [
              {
                OR: [
                  ...(options.memberId
                    ? [{ memberId: options.memberId }]
                    : []),
                  {
                    sourceBookingId: {
                      in: [...new Set(options.sourceBookingIds)],
                    },
                  },
                ],
              },
            ],
          }
        : options.memberId
          ? { memberId: options.memberId }
          : {}),
      ...(options.lodgeId ? { lodgeId: options.lodgeId } : {}),
    },
    orderBy: { enqueuedAt: "asc" },
    take: limit,
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      nights: true,
      cause: true,
      sourceBookingId: true,
      actorMemberId: true,
      reason: true,
      attempts: true,
    },
  });

  const claimed: HostingCoverageReevaluationItem[] = [];
  for (const candidate of candidates) {
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(
      claimedAt.getTime() + HOSTING_COVERAGE_REEVALUATION_LEASE_MS,
    );
    const claim = await db.hostingCoverageReevaluation.updateMany({
      where: {
        id: candidate.id,
        processedAt: null,
        attempts: candidate.attempts,
        OR: [{ claimToken: null }, { claimExpiresAt: { lt: claimedAt } }],
      },
      data: {
        attempts: { increment: 1 },
        claimToken,
        claimExpiresAt,
      },
    });
    if (claim.count !== 1) continue;
    claimed.push({
      ...candidate,
      nights: parseNights(candidate.nights),
      attempts: candidate.attempts + 1,
      claimToken,
    });
  }
  return claimed;
}

/**
 * Re-read one claimed item's authoritative payload inside its reconciliation
 * transaction. Member merge can re-point both live member identities after the
 * claim commits, so the drain uses its snapshot only for the existing-row merge
 * handshake and reconciles exclusively from this exact-token refresh. Ordinary
 * producers use the queue participant proof before storage, while merge fences
 * its exact post-move participants and performs late pointer sweeps. Policy and
 * config-transfer reconciliation remain serialised by the shared policy-set
 * lock.
 */
export async function loadClaimedHostingCoverageReevaluation(
  claim: HostingCoverageReevaluationClaim,
  db: HostingCoverageQueueDb,
): Promise<HostingCoverageReevaluationItem | null> {
  const row = await db.hostingCoverageReevaluation.findFirst({
    where: { id: claim.id, claimToken: claim.claimToken, processedAt: null },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      nights: true,
      cause: true,
      sourceBookingId: true,
      actorMemberId: true,
      reason: true,
      attempts: true,
      claimToken: true,
    },
  });
  if (!row) return null;
  return {
    ...row,
    nights: parseNights(row.nights),
    // The exact-token predicate proves this is non-null; Prisma does not narrow
    // selected nullable columns from a where clause.
    claimToken: claim.claimToken,
  };
}

/**
 * Extend one exact queue claim immediately before an external delivery or final
 * completion. An expired-but-unreplaced owner may renew; a successor replacement
 * and this guarded update contend on the row, and only the token left current can
 * proceed. This is the queue-side fence that prevents a stale worker from calling
 * a provider after its lease was replaced.
 */
export async function renewHostingCoverageReevaluationClaim(
  claim: HostingCoverageReevaluationClaim,
  db: HostingCoverageQueueDb,
  now: Date = new Date(),
): Promise<boolean> {
  const renewed = await db.hostingCoverageReevaluation.updateMany({
    where: { id: claim.id, processedAt: null, claimToken: claim.claimToken },
    data: {
      claimExpiresAt: new Date(
        now.getTime() + HOSTING_COVERAGE_REEVALUATION_LEASE_MS,
      ),
    },
  });
  return renewed.count === 1;
}

/**
 * Park an exact queue claim behind somebody else's in-flight notification.
 *
 * Claiming increments `attempts`, but this worker did not fail the obligation: it
 * found its provider unit already owned. Roll that increment back while retaining
 * the renewed lease, so repeated overlap cannot retire otherwise-valid work at
 * `maxAttempts`. The next sweep may replace the token only after expiry, which is
 * later than the notification lease this worker just observed.
 */
export async function deferHostingCoverageReevaluation(
  claim: HostingCoverageReevaluationClaim,
  db: HostingCoverageQueueDb,
): Promise<boolean> {
  const deferred = await db.hostingCoverageReevaluation.updateMany({
    where: { id: claim.id, processedAt: null, claimToken: claim.claimToken },
    data: { attempts: { decrement: 1 } },
  });
  return deferred.count === 1;
}

/**
 * Release a claim that could not start because the policy-set lock was busy.
 *
 * This differs deliberately from notification deferral above. A live provider
 * sender needs the queue row parked until its lease expires; policy contention
 * has performed no reconciliation or provider work, and member merge runs its own
 * post-commit drain. Clear the exact token immediately so that successor can claim
 * the obligation, while undoing this claim's attempt increment because contention
 * is not a poison-item failure. The drain's `seenIds` prevents a same-invocation
 * hot loop.
 */
export async function releaseHostingCoverageReevaluationContention(
  claim: HostingCoverageReevaluationClaim,
  db: HostingCoverageQueueDb,
): Promise<boolean> {
  const released = await db.hostingCoverageReevaluation.updateMany({
    where: { id: claim.id, processedAt: null, claimToken: claim.claimToken },
    data: {
      attempts: { decrement: 1 },
      claimToken: null,
      claimExpiresAt: null,
    },
  });
  return released.count === 1;
}

/** Mark an item done. Idempotent: a second call matches nothing. */
export async function completeHostingCoverageReevaluation(
  claim: HostingCoverageReevaluationClaim,
  db: HostingCoverageQueueDb,
): Promise<boolean> {
  const completed = await db.hostingCoverageReevaluation.updateMany({
    where: { id: claim.id, processedAt: null, claimToken: claim.claimToken },
    data: {
      processedAt: new Date(),
      lastError: null,
      claimToken: null,
      claimExpiresAt: null,
    },
  });
  return completed.count === 1;
}

/** Record why an item failed, leaving it unprocessed for the next sweep. */
export async function failHostingCoverageReevaluation(
  claim: HostingCoverageReevaluationClaim,
  message: string,
  db: HostingCoverageQueueDb,
): Promise<boolean> {
  const failed = await db.hostingCoverageReevaluation.updateMany({
    where: { id: claim.id, processedAt: null, claimToken: claim.claimToken },
    data: {
      lastError: message.slice(0, 1000),
      claimToken: null,
      claimExpiresAt: null,
    },
  });
  return failed.count === 1;
}

/**
 * Read the stored night list back without trusting it.
 *
 * The column is JSON, so a hand-edited or partially-written value is possible. A
 * value that is not an array of date-only strings yields NO nights, which makes
 * the item a no-op rather than letting a malformed row widen a bounded
 * re-evaluation into something unbounded.
 */
function parseNights(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const nights = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry),
  );
  return [...new Set(nights)].sort();
}
