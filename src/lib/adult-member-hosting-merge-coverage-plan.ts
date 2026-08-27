/**
 * The member-merge hosting-coverage fan-out plan.
 *
 * Split verbatim out of `adult-member-hosting-review.ts` (#3128). Merge is the
 * only caller: it builds this plan, acquires participant locks, REBUILDS it and
 * compares the two fingerprints before enqueueing anything. The engine never
 * calls back into here, so the import runs one way only.
 */
import {
  loadAdultMemberHostingPolicy,
  loadHostingCoverageMemberFanoutCandidates,
  sourceParticipant,
  type AdultMemberHostingReviewDb,
  type CoverageOwnerFacts,
} from "@/lib/adult-member-hosting-review";
import {
  enqueueHostingCoverageReevaluation,
  type HostingCoverageReevaluationInput,
} from "@/lib/adult-member-hosting-coverage-queue";
import {
  assertHostingCoverageQueueParticipantsLocked,
  type HostingCoverageQueueParticipantProof,
  type HostingCoverageSourceParticipant,
} from "@/lib/adult-member-hosting-queue-participants";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";
import type { ResolvedAdultMemberHostingPolicy } from "@/lib/policies/adult-member-hosting";

export type MemberMergeHostingCoveragePlan = Readonly<{
  items: readonly HostingCoverageReevaluationInput[];
  sources: readonly HostingCoverageSourceParticipant[];
  coverageOwnerIds: readonly string[];
}>;

/**
 * Plan the merge's exact actorless SYSTEM_CHANGE fan-out after relation moves.
 * The policy-set lock held by merge keeps the ENFORCED decisions stable while
 * the Member participant rows are acquired and this plan is re-read.
 */
export async function buildMemberMergeHostingCoveragePlan(
  params: {
    masterId: string;
    capturedLoserOwnedBookingIds: readonly string[];
    /**
     * The club's today (#3123), resolved by merge BEFORE it opened its
     * transaction (`INV-LOCK-004`). Merge builds this plan and then REBUILDS
     * it after acquiring participant locks, comparing the two; both passes
     * must be judged against the same club day.
     */
    today: Date;
  },
  db: AdultMemberHostingReviewDb,
): Promise<MemberMergeHostingCoveragePlan> {
  const [attended, movedOwnerBookings] = await Promise.all([
    loadHostingCoverageMemberFanoutCandidates(params.masterId, db, params.today),
    params.capturedLoserOwnedBookingIds.length > 0
      ? (db.booking.findMany({
          where: { id: { in: [...params.capturedLoserOwnedBookingIds] } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            memberId: true,
            lodgeId: true,
            checkIn: true,
            checkOut: true,
          },
        }) as Promise<CoverageOwnerFacts[]>)
      : Promise.resolve([]),
  ]);
  const candidatesById = new Map<string, CoverageOwnerFacts>();
  for (const booking of [...attended, ...movedOwnerBookings]) {
    candidatesById.set(booking.id, booking);
  }
  const candidates = [...candidatesById.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const policyByLodge = new Map<string, ResolvedAdultMemberHostingPolicy>();
  for (const booking of candidates) {
    if (!policyByLodge.has(booking.lodgeId)) {
      const policy = await loadAdultMemberHostingPolicy(booking.lodgeId, db);
      policyByLodge.set(booking.lodgeId, policy);
    }
  }
  const included = candidates.filter(
    (booking) => policyByLodge.get(booking.lodgeId)?.mode === "ENFORCED",
  );
  const items = included.map((booking) => ({
    memberId: booking.memberId,
    lodgeId: booking.lodgeId,
    nights: eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
      formatDateOnly,
    ),
    cause: "SYSTEM_CHANGE" as const,
    sourceBookingId: booking.id,
    actorMemberId: null,
    reason: null,
  }));
  const sourcesByBooking = new Map<string, HostingCoverageSourceParticipant>();
  for (const booking of included) {
    sourcesByBooking.set(booking.id, sourceParticipant(booking));
  }
  return Object.freeze({
    items: Object.freeze(items.map((item) => Object.freeze(item))),
    sources: Object.freeze(
      [...sourcesByBooking.values()].sort((a, b) =>
        a.bookingId.localeCompare(b.bookingId),
      ),
    ),
    coverageOwnerIds: Object.freeze(
      [...new Set(
        included
          .filter(
            (booking) =>
              policyByLodge.get(booking.lodgeId)?.hostScopes.sameBookingOwner ===
              true,
          )
          .map((booking) => booking.memberId),
      )].sort(),
    ),
  });
}

export function memberMergeHostingCoveragePlanFingerprint(
  plan: MemberMergeHostingCoveragePlan,
): string {
  return JSON.stringify(
    plan.items.map((item) => ({
      memberId: item.memberId,
      lodgeId: item.lodgeId,
      nights: [...item.nights],
      cause: item.cause,
      sourceBookingId: item.sourceBookingId ?? null,
    })),
  ) + JSON.stringify(plan.coverageOwnerIds);
}

export async function enqueueMemberMergeHostingCoveragePlan(
  plan: MemberMergeHostingCoveragePlan,
  proof: HostingCoverageQueueParticipantProof,
  db: AdultMemberHostingReviewDb,
): Promise<number> {
  let queued = 0;
  for (const item of plan.items) {
    assertHostingCoverageQueueParticipantsLocked(proof, item);
    if (await enqueueHostingCoverageReevaluation(item, proof, db)) queued += 1;
  }
  return queued;
}
