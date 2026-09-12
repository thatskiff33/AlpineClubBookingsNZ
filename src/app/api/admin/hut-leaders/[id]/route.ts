import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { findHutLeaderOverlapRefusal } from "@/lib/hut-leader-overlap-guard";
import {
  CustodianOverlapsWholeLodgeHoldError,
  findWholeLodgeHoldAmendments,
  recordWholeLodgeHoldAmendment,
  validateCustodianBedHold,
  wholeLodgeHoldAmendmentNights,
} from "@/lib/custodian-assignment";
import { custodianBedHoldErrorResponse } from "@/lib/custodian-assignment-routes";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";

const updateSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lodgeId: z.string().min(1).optional(),
  // Custodian bed hold (#2286), THREE-state and deliberately so:
  //   absent          -> leave the bed exactly as it is
  //   null            -> CLEAR the bed (back to role only; the bed is bookable
  //                      again from the moment this commits)
  //   a bed id string -> set/replace the bed
  // `.nullable()` as well as `.optional()` is what makes "clear" expressible at
  // all — without it there would be no way to undo a hold except deleting the
  // whole assignment.
  bedId: z.string().min(1).nullable().optional(),
  // #1668-style explicit override of the over-capacity warning.
  confirmOverCapacity: z.boolean().optional(),
  // #2698 ordering case: the officer's EXPLICIT acceptance that holding this
  // bed narrows an existing whole-lodge hold's represented bed set. Absent is
  // decline-by-default — 409 CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD, nothing
  // written on either side.
  amendOverlappingHolds: z.boolean().optional(),
});

/**
 * PUT /api/admin/hut-leaders/[id]
 * Update a hut leader assignment.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.hutLeaderAssignment.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  const updateData: {
    startDate?: Date;
    endDate?: Date;
    lodgeId?: string;
    bedId?: string | null;
  } = {};
  if (parsed.data.startDate) {
    if (!isDateOnlyString(parsed.data.startDate)) {
      return NextResponse.json({ error: "Invalid startDate" }, { status: 400 });
    }
    updateData.startDate = parseDateOnly(parsed.data.startDate);
  }
  if (parsed.data.endDate) {
    if (!isDateOnlyString(parsed.data.endDate)) {
      return NextResponse.json({ error: "Invalid endDate" }, { status: 400 });
    }
    updateData.endDate = parseDateOnly(parsed.data.endDate);
  }
  if (parsed.data.lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: parsed.data.lodgeId },
      select: { id: true, active: true },
    });
    if (!lodge || !lodge.active) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 }
      );
    }
    updateData.lodgeId = lodge.id;
  }

  /*
    Everything the locked decision rests on is re-derived from the row read
    UNDER the lock, not from the pre-lock `existing` (#2887 review).

    The pre-lock read stays for the cheap 404 and to supply the lock KEY. But
    deriving the dates, the lodge and the surviving bed hold out here and only
    re-reading the overlap set inside looked locked and was not — three
    interleavings, each now a named case in
    `custodian-hut-leaders-route.test.ts`: a bed hold that only exists in the
    locked row skipping validation, two requests locking DIFFERENT keys because
    one derived its key from a stale lodge, and two partial-field edits
    composing into a span neither validated.
  */
  // Validate start <= end against the pre-lock row, so an obviously inverted
  // range is refused without paying for a lock. Re-checked under it.
  if ((updateData.startDate ?? existing.startDate) > (updateData.endDate ?? existing.endDate)) {
    return NextResponse.json(
      { error: "startDate must be before or equal to endDate" },
      { status: 400 }
    );
  }

  // The lock KEY. A concurrent move can make this stale; the locked re-read
  // below detects that and refuses rather than acting under the wrong key.
  const intendedLodgeId = updateData.lodgeId ?? existing.lodgeId;

  // Custodian bed hold (#2286). Three-state: absent leaves the hold alone,
  // explicit null clears it, a string sets it. `bedIdProvided` is the only way
  // to tell "not sent" from "sent as null", which is exactly the distinction
  // between "don't touch the bed" and "release the bed".
  // JSON has no `undefined`, so zod's three parsed values map one-to-one onto
  // the three intents: undefined = key absent, null = explicit clear, string =
  // set. No separate "was the key present" probe is needed or wanted.
  const bedIdProvided = parsed.data.bedId !== undefined;
  if (bedIdProvided) {
    updateData.bedId = parsed.data.bedId ?? null;
  }
  // Module gate on the pre-lock view: this is a feature-availability refusal
  // aimed at what the operator ASKED for, not a capacity decision.
  const requestedBedId = bedIdProvided ? parsed.data.bedId : existing.bedId;
  if (requestedBedId && !(await isEffectiveModuleEnabled("bedAllocation"))) {
    return NextResponse.json(
      {
        error:
          "Bed allocation is turned off for this club, so a bed cannot be held for a hut leader.",
        code: "MODULE_DISABLED",
      },
      { status: 400 },
    );
  }

  const auditRequest = getAuditRequestContext(req);
  // #2698: decided BEFORE any lock, because it decides WHICH locks are taken
  // (INV-LOCK-002: global then lodge, never the other order).
  const amendRequested = parsed.data.amendOverlappingHolds === true;

  try {
    /*
      EVERY edit runs under the target lodge's capacity key (#2887), not just a
      bed-holding one. #2286 locked only the bed path, reasoning that clearing a
      bed moves no capacity — true of capacity, false of the OVERLAP predicate
      this route also decides, which a bedless edit breaks by MOVING DATES.
    */
    const refusal = await prisma.$transaction(async (tx) => {
      // #2698 amend path only: the global cohort key first, because the hold
      // RELEASE path (booking cancel) serialises on the club-wide key and not
      // on this lodge's, so the lodge key alone cannot exclude it. The
      // detect-and-refuse path writes nothing and keeps the narrower topology.
      if (amendRequested) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      }
      await acquireLodgeCapacityLock(tx, intendedLodgeId);

      // The authoritative row. Everything the decision rests on comes from
      // HERE, under the key, not from the pre-lock read.
      const locked = await tx.hutLeaderAssignment.findUnique({ where: { id } });
      if (!locked) return { status: 404, error: "Assignment not found" };

      const finalLodgeId = updateData.lodgeId ?? locked.lodgeId;
      if (finalLodgeId !== intendedLodgeId) {
        // The row moved lodges between the two reads, so the key we hold is
        // not the key that governs it. Refuse rather than validate one lodge's
        // roster and write to another's.
        return {
          status: 409,
          error:
            "This assignment moved to a different lodge while you were editing it. Reload and try again.",
        };
      }
      const finalStart = updateData.startDate ?? locked.startDate;
      const finalEnd = updateData.endDate ?? locked.endDate;
      if (finalStart > finalEnd) {
        return {
          status: 400,
          error: "startDate must be before or equal to endDate",
        };
      }
      const nextBedId = bedIdProvided ? parsed.data.bedId : locked.bedId;

      const overlap = await findHutLeaderOverlapRefusal(tx, {
        lodgeId: finalLodgeId,
        startDate: finalStart,
        endDate: finalEnd,
        excludeAssignmentId: id,
        // #2926: a DELIBERATE officer action, so the teacher carve-out applies.
        allowOverlappingSchoolRows: true,
      });
      if (overlap) return { status: 409, error: overlap.error };

      let amendments: Awaited<
        ReturnType<typeof findWholeLodgeHoldAmendments>
      > = [];
      if (nextBedId) {
        await validateCustodianBedHold({
          bedId: nextBedId,
          lodgeId: finalLodgeId,
          startDate: finalStart,
          endDate: finalEnd,
          assignmentId: id,
          confirmOverCapacity: parsed.data.confirmOverCapacity,
          db: tx,
        });
        // #2698 ordering case, re-read UNDER the locks against the LOCKED row's
        // final bed and dates. `assignmentId` is what keeps "new and amended
        // holds only" true: nights this assignment already holds on this bed
        // are already outside the overlapping hold's set, so an unrelated edit
        // does not re-ask a question the officer has already answered.
        amendments = await findWholeLodgeHoldAmendments({
          bedId: nextBedId,
          lodgeId: finalLodgeId,
          startDate: finalStart,
          endDate: finalEnd,
          assignmentId: id,
          db: tx,
        });
        if (amendments.length > 0 && !amendRequested) {
          // Throwing rolls the transaction back, so neither the assignment
          // edit nor any amendment record exists.
          throw new CustodianOverlapsWholeLodgeHoldError(
            amendments,
            wholeLodgeHoldAmendmentNights(amendments),
          );
        }
      }
      await tx.hutLeaderAssignment.update({ where: { id }, data: updateData });

      await createAuditLog(
        {
          action: "lodge.hut-leader-assignment.updated",
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: locked.memberId,
          targetId: id,
          entityType: "HutLeaderAssignment",
          entityId: id,
          // docs/guides/audit-log.md, the `lodge` row: rosters and all bed
          // allocation. A hut-leader assignment is the lodge roster, and the
          // bed it holds is a bed-allocation fact.
          category: "lodge",
          severity: nextBedId || locked.bedId ? "important" : "info",
          outcome: "success",
          summary: "Hut leader assignment updated",
          details:
            "An officer changed a hut-leader assignment's dates, lodge or held bed. A bed that was released is bookable again from the moment this committed.",
          metadata: {
            lodgeId: finalLodgeId,
            previousLodgeId: locked.lodgeId,
            startDate: formatDateOnly(finalStart),
            endDate: formatDateOnly(finalEnd),
            previousStartDate: formatDateOnly(locked.startDate),
            previousEndDate: formatDateOnly(locked.endDate),
            bedId: nextBedId ?? null,
            previousBedId: locked.bedId,
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        },
        tx,
      );

      if (nextBedId && amendments.length > 0) {
        // Same transaction as the edit: accept writes both facts or neither.
        await recordWholeLodgeHoldAmendment(tx, {
          actorMemberId: session.user.id,
          assignmentId: id,
          lodgeId: finalLodgeId,
          bedId: nextBedId,
          amendments,
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        });
      }
      return null;
    });

    if (refusal) {
      return NextResponse.json(
        { error: refusal.error },
        { status: refusal.status },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const custodianResponse = custodianBedHoldErrorResponse(err);
    if (custodianResponse) return custodianResponse;
    logger.error({ err }, "Error updating hut leader assignment");
    return NextResponse.json({ error: "Failed to update assignment" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/hut-leaders/[id]
 * Delete a hut leader assignment.
 *
 * Under the lodge capacity key since #2698, and the reason is the mirror of the
 * rest of this issue: removing a custodian bed hold WIDENS the represented bed
 * set of every whole-lodge hold that overlaps it (`INV-CAP-035`), because the
 * exclusion is derived from the live holds at read time. That is a capacity
 * move — the same one the create and the edit take the key for — and it ran
 * here on the base client outside any transaction, so a delete could commit
 * between a planner's read and its write. It creates no overlap, so it still
 * runs no overlap read; it takes the key, re-reads the row under it, and
 * deletes and audits in one transaction. The response contract is unchanged.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  // The cheap 404 and the lock KEY. Every fact the delete records comes from
  // the re-read under the key (#2887's rule, applied here too).
  const existing = await prisma.hutLeaderAssignment.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }
  const auditRequest = getAuditRequestContext(req);

  try {
    const refusal = await prisma.$transaction(async (tx) => {
      await acquireLodgeCapacityLock(tx, existing.lodgeId);
      const locked = await tx.hutLeaderAssignment.findUnique({ where: { id } });
      // Already gone, or moved to another lodge while we waited — in either
      // case the key we hold does not govern it. 404 rather than delete a row
      // whose lodge was never serialised against this transaction.
      if (!locked) return { status: 404, error: "Assignment not found" };
      if (locked.lodgeId !== existing.lodgeId) {
        return {
          status: 409,
          error:
            "This assignment moved to a different lodge while you were deleting it. Reload and try again.",
        };
      }

      await tx.hutLeaderAssignment.delete({ where: { id } });
      await createAuditLog(
        {
          action: "lodge.hut-leader-assignment.deleted",
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: locked.memberId,
          targetId: id,
          entityType: "HutLeaderAssignment",
          entityId: id,
          // docs/guides/audit-log.md, the `lodge` row: rosters and all bed
          // allocation.
          category: "lodge",
          severity: locked.bedId ? "important" : "info",
          outcome: "success",
          summary: "Hut leader assignment deleted",
          details: locked.bedId
            ? "An officer deleted a hut-leader assignment that was holding a bed; that bed is bookable again, and any overlapping whole-lodge hold covers it again from the moment this committed."
            : "An officer deleted a hut-leader assignment that held no bed (a role only, with no capacity effect).",
          metadata: {
            lodgeId: locked.lodgeId,
            startDate: formatDateOnly(locked.startDate),
            endDate: formatDateOnly(locked.endDate),
            bedId: locked.bedId,
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        },
        tx,
      );
      return null;
    });

    if (refusal) {
      return NextResponse.json(
        { error: refusal.error },
        { status: refusal.status },
      );
    }
    logger.info({ assignmentId: id }, "Hut leader assignment deleted");
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error deleting hut leader assignment");
    return NextResponse.json({ error: "Failed to delete assignment" }, { status: 500 });
  }
}
