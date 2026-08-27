import { Prisma, type PrismaClient } from "@prisma/client";

import { HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES } from "@/lib/booking-status";
import { clubToday, dateOnlyInstantOf, requireCalendarDate } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { eachDateOnlyInRange, formatDateOnly } from "@/lib/date-only";
import {
  resolveAdultMemberHostingPolicy,
  type ResolvedAdultMemberHostingPolicy,
} from "@/lib/policies/adult-member-hosting";

/**
 * The persisted policy columns needed to compare the effective rule before and
 * after a policy-set mutation. Keep this projection independent of revision and
 * capacity: neither changes whether an existing urgent coverage incident is a
 * valid instrument.
 */
export const HOSTING_POLICY_RECONCILIATION_SELECT = {
  id: true,
  scopeKey: true,
  lodgeId: true,
  mode: true,
  capacityMode: true,
  version: true,
  hostScopeSameBooking: true,
  hostScopeSameBookingOwner: true,
} as const;

export type HostingPolicyReconciliationSnapshot = {
  id: string;
  scopeKey: string;
  lodgeId: string | null;
  mode: "INHERIT" | "DISABLED" | "ADMIN_REVIEW_REQUIRED" | "ENFORCED";
  capacityMode: "HOLD" | "NO_HOLD";
  version: number;
  hostScopeSameBooking: boolean | null;
  hostScopeSameBookingOwner: boolean | null;
};

type HostingPolicyReconciliationDb = Pick<
  PrismaClient,
  "adultMemberHostingPolicy" | "booking" | "hostingCoverageReevaluation"
>;

function incidentMaterialPolicy(
  rows: readonly HostingPolicyReconciliationSnapshot[],
  lodgeId: string,
): Pick<ResolvedAdultMemberHostingPolicy, "mode" | "hostScopes"> {
  const resolved = resolveAdultMemberHostingPolicy(rows, lodgeId);
  return { mode: resolved.mode, hostScopes: resolved.hostScopes };
}

function incidentPolicyChanged(
  beforeRows: readonly HostingPolicyReconciliationSnapshot[],
  afterRows: readonly HostingPolicyReconciliationSnapshot[],
  lodgeId: string,
): boolean {
  const before = incidentMaterialPolicy(beforeRows, lodgeId);
  const after = incidentMaterialPolicy(afterRows, lodgeId);
  return (
    before.mode !== after.mode ||
    before.hostScopes.sameBooking !== after.hostScopes.sameBooking ||
    before.hostScopes.sameBookingOwner !== after.hostScopes.sameBookingOwner
  );
}

/**
 * Durably schedule every accepted booking, plus every booking with a currently
 * active incident, whose effective enforcement mode or host-scope set changed
 * in the policy mutation that just ran.
 *
 * This runs INSIDE the authoritative policy transaction, after its writes. Each
 * queue item still names exactly one booking owner, one lodge and that booking's
 * explicit lodge nights; policy administration never introduces a lodge-wide
 * work item. The post-commit drain then re-reads current facts and either opens
 * a newly-required incident, closes one that is no longer applicable, or
 * refreshes it under the new scope set.
 *
 * TWO BOUNDED DATABASE CALLS follow the after-policy read: one candidate booking
 * read and, when at least one lodge was affected, one `createMany`. There is no
 * per-booking query or insert. Each resulting row is still bounded to exactly
 * one owner, lodge and explicit night list; the cardinality of the write is the
 * complete finite candidate result, because truncating a policy-wide repair
 * would silently leave accepted bookings under the old rule.
 *
 * Reading every accepted booking is necessary for a tightening: a compliant
 * confirmed booking has no active incident yet, but the new rule may make it
 * uncovered. Reading active incidents as the other OR branch is necessary for
 * a relaxation: an incident still has to close even if its booking has since
 * left the accepted status set. A club-wide row can affect different lodges
 * through different inheritance paths, so before/after policy is resolved once
 * per candidate lodge rather than inferred from the edited row.
 */
export async function enqueueActiveHostingIncidentPolicyReconciliation(
  params: {
    beforePolicies: readonly HostingPolicyReconciliationSnapshot[];
    /** Test seam for the lodge-night boundary. */
    todayDateOnly?: string;
  },
  db: HostingPolicyReconciliationDb,
): Promise<number> {
  // The club's own lodge-night boundary, from its PERSISTED timezone rather
  // than the container's (#3123, INV-CONFIG-002). The CLI-safe runtime reader:
  // `src/instrumentation.node.ts` reaches this module through
  // `config-transfer/bootstrap-import`, where `server-only` throws at import.
  // Resolved once, before the query below, and only when the test seam has not
  // supplied the day.
  const todayDateOnly = params.todayDateOnly
    ? requireCalendarDate(params.todayDateOnly)
    : clubToday(await readClubTimeZoneOutsideRequest());

  const afterPolicies = (await db.adultMemberHostingPolicy.findMany({
    select: HOSTING_POLICY_RECONCILIATION_SELECT,
  })) as HostingPolicyReconciliationSnapshot[];

  const candidates = await db.booking.findMany({
    where: {
      OR: [
        {
          deletedAt: null,
          status: { in: [...HOSTING_COVERAGE_SOURCE_BOOKING_STATUSES] },
          // `Booking.checkOut` is `@db.Date`, so the bound is the UTC-midnight
          // encoding of a calendar day, not an instant boundary.
          checkOut: { gt: dateOnlyInstantOf(todayDateOnly) },
        },
        { hostingCoverageIncidents: { some: { resolvedAt: null } } },
      ],
    },
    orderBy: [{ checkIn: "asc" }, { id: "asc" }],
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
    },
  });

  const changedByLodge = new Map<string, boolean>();
  const queueRows: Prisma.HostingCoverageReevaluationCreateManyInput[] = [];
  for (const booking of candidates) {
    let affected = changedByLodge.get(booking.lodgeId);
    if (affected === undefined) {
      affected = incidentPolicyChanged(
        params.beforePolicies,
        afterPolicies,
        booking.lodgeId,
      );
      changedByLodge.set(booking.lodgeId, affected);
    }
    if (!affected) continue;

    const nights = eachDateOnlyInRange(booking.checkIn, booking.checkOut).map(
      formatDateOnly,
    );
    if (nights.length === 0) continue;
    queueRows.push({
      memberId: booking.memberId,
      lodgeId: booking.lodgeId,
      nights,
      cause: "SYSTEM_CHANGE",
      sourceBookingId: booking.id,
      // The policy mutation has its own admin audit row. This background
      // consequence is a system transition, not an officer override, and must
      // not retain a stale admin id until the queue eventually drains.
      actorMemberId: null,
      reason: null,
    });
  }
  if (queueRows.length === 0) return 0;

  const created = await db.hostingCoverageReevaluation.createMany({
    data: queueRows,
  });
  return created.count;
}
