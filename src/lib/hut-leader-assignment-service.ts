import {
  CustodianOverlapsWholeLodgeHoldError,
  findWholeLodgeHoldAmendments,
  recordWholeLodgeHoldAmendment,
  validateCustodianBedHold,
  wholeLodgeHoldAmendmentNights,
  type WholeLodgeHoldAmendment,
} from "@/lib/custodian-assignment";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { findHutLeaderOverlapRefusal } from "@/lib/hut-leader-overlap-guard";
import { recordHutLeaderAssignmentAudit } from "@/lib/hut-leader-assignment-audit";
import { prisma } from "@/lib/prisma";

/**
 * The two hut-leader assignment writes that decide something under a lock: the
 * officer EDIT and the officer DELETE.
 *
 * They live here rather than inline in `[id]/route.ts` because a Next.js route
 * module may export only route handlers, so the file cannot be split any other
 * way — and both of these are lock topology plus its explanation, which is the
 * part of the change a future reader most needs and most easily undoes. The
 * route keeps what a route is for: authorisation, parsing, deriving the update
 * from the request, and turning a refusal into a response.
 *
 * The CREATE stays in `route.ts`. It is one transaction that also mints a kiosk
 * PIN and sends an email after commit, so pulling only its middle out would
 * split one flow across two files without shortening either meaningfully.
 *
 * ## The lock rules both functions implement
 *
 * - Every edit — bed-holding or not — runs under the target lodge's capacity
 *   key (#2887). #2286 locked only the bed path, reasoning that clearing a bed
 *   moves no capacity; true of capacity, false of the OVERLAP predicate, which
 *   a bedless edit breaks by MOVING DATES.
 * - Everything the locked decision rests on is re-read UNDER the key (#2887
 *   review). The caller's pre-lock read supplies the cheap 404 and the lock key
 *   and nothing else.
 * - The DELETE holds the same key since #2698, because removing a custodian bed
 *   hold WIDENS the represented bed set of every overlapping whole-lodge hold
 *   (`INV-CAP-035`) — a capacity move that ran on the base client outside any
 *   transaction until then. It creates no overlap, so it still runs no overlap
 *   read.
 * - The #2698 AMEND path, and only that path, additionally takes the global
 *   cohort key `pg_advisory_xact_lock(1)` FIRST (`INV-LOCK-002`): the hold
 *   release path is booking cancel's `RELEASE_WHOLE_LODGE_HOLD_UPDATE`, which
 *   serialises on the club-wide key and never on this lodge's. Whether it is
 *   taken is decided by the CALLER, from the request, before this function
 *   opens a transaction — so the order can never invert.
 */
export interface HutLeaderAssignmentRefusal {
  status: number;
  error: string;
}

/** Request provenance for the audit rows; absent when it cannot be read. */
export interface HutLeaderAuditRequest {
  id?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Apply an officer's edit under the lodge capacity key, re-reading the row,
 * the overlap set and the whole-lodge holds beneath it.
 *
 * Returns a refusal to be rendered as a response, or `null` on success. Hard
 * custodian refusals and the #2698 ordering case are THROWN, not returned, so
 * the transaction rolls back and the route maps them through
 * `custodianBedHoldErrorResponse` exactly as it did before this moved.
 */
export async function applyHutLeaderAssignmentEditUnderLocks(input: {
  assignmentId: string;
  /** The lock key, derived by the caller from its pre-lock read. */
  intendedLodgeId: string;
  updateData: {
    startDate?: Date;
    endDate?: Date;
    lodgeId?: string;
    bedId?: string | null;
  };
  /** Was `bedId` present in the request at all? Absent means "leave the bed". */
  bedIdProvided: boolean;
  /** The requested bed when `bedIdProvided`: a string sets it, null clears it. */
  requestedBedId: string | null | undefined;
  confirmOverCapacity?: boolean;
  /** #2698: the officer has explicitly accepted narrowing an existing hold. */
  amendAccepted: boolean;
  actorMemberId: string;
  auditRequest?: HutLeaderAuditRequest | null;
}): Promise<HutLeaderAssignmentRefusal | null> {
  const { assignmentId: id, updateData } = input;

  return prisma.$transaction(async (tx) => {
    if (input.amendAccepted) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    }
    await acquireLodgeCapacityLock(tx, input.intendedLodgeId);

    // The authoritative row. Every fact the decision rests on comes from HERE.
    const locked = await tx.hutLeaderAssignment.findUnique({ where: { id } });
    if (!locked) return { status: 404, error: "Assignment not found" };

    const finalLodgeId = updateData.lodgeId ?? locked.lodgeId;
    if (finalLodgeId !== input.intendedLodgeId) {
      // The row moved lodges between the two reads, so the key we hold is not
      // the key that governs it. Refuse rather than validate one lodge's roster
      // and write to another's.
      return {
        status: 409,
        error:
          "This assignment moved to a different lodge while you were editing it. Reload and try again.",
      };
    }
    const finalStart = updateData.startDate ?? locked.startDate;
    const finalEnd = updateData.endDate ?? locked.endDate;
    if (finalStart > finalEnd) {
      return { status: 400, error: "startDate must be before or equal to endDate" };
    }
    const nextBedId = input.bedIdProvided ? input.requestedBedId : locked.bedId;

    const overlap = await findHutLeaderOverlapRefusal(tx, {
      lodgeId: finalLodgeId,
      startDate: finalStart,
      endDate: finalEnd,
      excludeAssignmentId: id,
      // #2926: a DELIBERATE officer action, so the teacher carve-out applies.
      allowOverlappingSchoolRows: true,
    });
    if (overlap) return { status: 409, error: overlap.error };

    let amendments: WholeLodgeHoldAmendment[] = [];
    if (nextBedId) {
      amendments = await validateCustodianBedHoldAndHoldAmendment(tx, {
        bedId: nextBedId,
        lodgeId: finalLodgeId,
        startDate: finalStart,
        endDate: finalEnd,
        assignmentId: id,
        confirmOverCapacity: input.confirmOverCapacity,
        amendAccepted: input.amendAccepted,
      });
    }
    await tx.hutLeaderAssignment.update({ where: { id }, data: updateData });

    await recordHutLeaderAssignmentAudit(tx, {
      event: "updated",
      actorMemberId: input.actorMemberId,
      subjectMemberId: locked.memberId,
      assignmentId: id,
      lodgeId: finalLodgeId,
      startDate: finalStart,
      endDate: finalEnd,
      bedId: nextBedId ?? null,
      previous: {
        lodgeId: locked.lodgeId,
        startDate: locked.startDate,
        endDate: locked.endDate,
        bedId: locked.bedId,
      },
      requestId: input.auditRequest?.id,
      ipAddress: input.auditRequest?.ipAddress,
      userAgent: input.auditRequest?.userAgent,
    });

    if (nextBedId && amendments.length > 0) {
      // Same transaction as the edit: accept writes both facts or neither.
      await recordWholeLodgeHoldAmendment(tx, {
        actorMemberId: input.actorMemberId,
        assignmentId: id,
        lodgeId: finalLodgeId,
        bedId: nextBedId,
        amendments,
        requestId: input.auditRequest?.id,
        ipAddress: input.auditRequest?.ipAddress,
        userAgent: input.auditRequest?.userAgent,
      });
    }
    return null;
  });
}

/**
 * Delete an assignment under the lodge capacity key (#2698).
 *
 * Returns a refusal or `null`. The caller's pre-lock read supplies the 404 and
 * the key; the row is re-read here, and a row that moved lodges in between is
 * refused rather than deleted under a key that does not govern it.
 */
export async function deleteHutLeaderAssignmentUnderLodgeLock(input: {
  assignmentId: string;
  /** The lock key, from the caller's pre-lock read. */
  lodgeId: string;
  actorMemberId: string;
  auditRequest?: HutLeaderAuditRequest | null;
}): Promise<HutLeaderAssignmentRefusal | null> {
  const { assignmentId: id } = input;

  return prisma.$transaction(async (tx) => {
    await acquireLodgeCapacityLock(tx, input.lodgeId);
    const locked = await tx.hutLeaderAssignment.findUnique({ where: { id } });
    if (!locked) return { status: 404, error: "Assignment not found" };
    if (locked.lodgeId !== input.lodgeId) {
      return {
        status: 409,
        error:
          "This assignment moved to a different lodge while you were deleting it. Reload and try again.",
      };
    }

    await tx.hutLeaderAssignment.delete({ where: { id } });
    await recordHutLeaderAssignmentAudit(tx, {
      event: "deleted",
      actorMemberId: input.actorMemberId,
      subjectMemberId: locked.memberId,
      assignmentId: id,
      lodgeId: locked.lodgeId,
      startDate: locked.startDate,
      endDate: locked.endDate,
      bedId: locked.bedId,
      requestId: input.auditRequest?.id,
      ipAddress: input.auditRequest?.ipAddress,
      userAgent: input.auditRequest?.userAgent,
    });
    return null;
  });
}

/**
 * The bed-hold half of a create or an edit, in the order it has to happen:
 * every HARD refusal first, then the #2698 ordering question.
 *
 * Shared by the create route and the edit above so the two cannot drift on the
 * one thing that matters here — that a hold which is going to be refused
 * outright never raises an amendment question the officer would then have to
 * un-answer, and that a declined amendment throws rather than returns, so the
 * caller's transaction rolls back and NOTHING is written on either side.
 *
 * Returns the amendments the caller must record after its own write. An empty
 * array is the ordinary case.
 */
export async function validateCustodianBedHoldAndHoldAmendment(
  tx: Parameters<typeof findWholeLodgeHoldAmendments>[0]["db"],
  input: {
    bedId: string;
    lodgeId: string;
    startDate: Date;
    endDate: Date;
    /** Present when editing, so the assignment does not re-prompt on its own nights. */
    assignmentId?: string;
    confirmOverCapacity?: boolean;
    amendAccepted: boolean;
  },
): Promise<WholeLodgeHoldAmendment[]> {
  await validateCustodianBedHold({
    bedId: input.bedId,
    lodgeId: input.lodgeId,
    startDate: input.startDate,
    endDate: input.endDate,
    assignmentId: input.assignmentId,
    confirmOverCapacity: input.confirmOverCapacity,
    db: tx,
  });

  const amendments = await findWholeLodgeHoldAmendments({
    bedId: input.bedId,
    lodgeId: input.lodgeId,
    startDate: input.startDate,
    endDate: input.endDate,
    assignmentId: input.assignmentId,
    db: tx,
  });
  if (amendments.length > 0 && !input.amendAccepted) {
    throw new CustodianOverlapsWholeLodgeHoldError(
      amendments,
      wholeLodgeHoldAmendmentNights(amendments),
    );
  }
  return amendments;
}
