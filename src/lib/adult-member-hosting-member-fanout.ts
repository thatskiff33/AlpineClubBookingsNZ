/**
 * The bounded set ONE person's standing change fans out to, and what happens
 * when its ceiling binds (#5239, `INV-HOST-045`).
 *
 * Split out of `adult-member-hosting-review.ts`, which is past its size
 * ceiling. The standing fan-out (`enqueueHostingCoverageReevaluationForMember`)
 * and the member merge's plan both read through
 * `loadHostingCoverageMemberFanoutCandidates`, which applies the `where` and the
 * ceiling below; both call `invalidateMemberGroupTripCover` when it binds.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import logger from "@/lib/logger";

/**
 * A ceiling on the bookings ONE person's lifecycle change fans out to.
 *
 * Higher than the per-account ceilings because the set is a different shape — every
 * current-or-future booking this person ATTENDS, across lodges — and still small:
 * fifty live stays for one member is already far beyond a club member's real
 * footprint. When it binds the bookings past it are not re-evaluated, so
 * `invalidateMemberGroupTripCover` withholds the sibling cover they could carry.
 */
export const HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT = 50;

/**
 * The live, current-or-future bookings this person attends — the fan-out's
 * candidate set, before its ceiling. A checkout on or after `today` (the club's
 * day, `INV-DATE-026`) still has nights the rule can judge.
 */
export function hostingCoverageMemberAttendanceWhere(
  memberId: string,
  today: Date,
): Prisma.BookingWhereInput {
  return {
    deletedAt: null,
    status: { in: [...ACTIVE_BOOKING_STATUSES] },
    checkOut: { gte: today },
    guests: { some: { memberId } },
  };
}

/** Did a read of this many RAW rows (before any narrowing) fill the ceiling? */
export function hostingCoverageMemberFanoutCeilingBinds(readCount: number): boolean {
  return readCount >= HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT;
}

/**
 * The fan-out could not reach every booking this person attends, so move the
 * `coverageInvalidationRevision` of EVERY trip they attend, in one set-based
 * update, and log it.
 *
 * WHY EVERY TRIP AND NOT THE ONES PAST THE CEILING. The rows past it were never
 * read, so there is no list of them to name; the set-based `where` reaches them
 * without reading them. A trip inside the ceiling was fanned out to as well, and
 * the re-evaluations queued in this same transaction restamp its snapshots under
 * the new revision once they drain, so moving it too costs a "needs re-checking"
 * until then, never a wrong answer. Every snapshot left behind stays unverified
 * until something re-evaluates it: the kiosk never shows cover from an adult whose
 * standing changed and whose dependents nobody re-checked.
 *
 * TRIP IDENTITY IS THE FAN-OUT'S: the canonical organiser and join relations,
 * plus the #738 split-pair carve-out (`INV-HOST-043`) as "a booking whose linked
 * child this person attends". That clause does not check that the two halves share
 * an owner, so it can move a trip the carve-out would not; that over-reach only
 * withholds.
 *
 * THE CALLER'S LAST WRITE. It takes `GroupBooking` row locks, and
 * `docs/CONCURRENCY_AND_LOCKING.md` (the cover-invalidation revision) states why
 * no wait follows them and how a cycle with a concurrent bump resolves.
 */
export async function invalidateMemberGroupTripCover(
  memberId: string,
  today: Date,
  db: Pick<PrismaClient, "groupBooking">,
  read: "member-standing-fanout" | "member-merge",
): Promise<number> {
  const attended = hostingCoverageMemberAttendanceWhere(memberId, today);
  const attendedOrSplitParent: Prisma.BookingWhereInput = {
    OR: [attended, { linkedBookings: { some: attended } }],
  };
  const { count } = await db.groupBooking.updateMany({
    where: {
      OR: [
        { organiserBooking: { is: attendedOrSplitParent } },
        { joins: { some: { booking: { is: attendedOrSplitParent } } } },
      ],
    },
    data: { coverageInvalidationRevision: { increment: 1 } },
  });
  logger.warn(
    { memberId, limit: HOSTING_COVERAGE_MEMBER_FANOUT_LIMIT, read, invalidatedTrips: count },
    "Hosting coverage member fan-out hit its ceiling; a booking this member attends may not have been re-evaluated, so sibling cover in their trips is withheld until re-checked",
  );
  return count;
}
