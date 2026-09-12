import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { getAuditRequestContext } from "@/lib/audit";
import {
  applyHutLeaderAssignmentEditUnderLocks,
  deleteHutLeaderAssignmentUnderLodgeLock,
} from "@/lib/hut-leader-assignment-service";
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
  //
  // AND a bed has to be involved (#2698 review A-3): an edit that ends with no
  // bed held can narrow no hold, so it must not hold the club-wide key that
  // serialises cancel, capture, settle, refund and credit-restore. The bed is
  // already derived above for the module gate, so this costs no read.
  //
  // `requestedBedId` comes from the pre-lock row, which a concurrent write can
  // make stale. That is safe in the only direction it can go: if the locked row
  // turns out to hold a bed this request did not know about, `amendAccepted` is
  // false, the ordering check THROWS, and the transaction rolls back with
  // nothing written on either side. A stale read here costs the officer a
  // retry, never a write taken under the wrong keys.
  const amendRequested =
    parsed.data.amendOverlappingHolds === true && Boolean(requestedBedId);

  try {
    // Everything from here runs under the lodge capacity key, and the #2698
    // amend path additionally under the global cohort key ahead of it
    // (INV-LOCK-002). Both the locks and the reads that decide the edit live in
    // `hut-leader-assignment-service.ts`; see its module note for why.
    const refusal = await applyHutLeaderAssignmentEditUnderLocks({
      assignmentId: id,
      intendedLodgeId,
      updateData,
      bedIdProvided,
      requestedBedId: parsed.data.bedId,
      confirmOverCapacity: parsed.data.confirmOverCapacity,
      amendAccepted: amendRequested,
      actorMemberId: session.user.id,
      auditRequest,
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
 * Under the lodge capacity key since #2698 — removing a custodian bed hold
 * widens the represented bed set of every overlapping whole-lodge hold
 * (`INV-CAP-035`), which is a capacity move. The key, the locked re-read and
 * the audited delete live in `hut-leader-assignment-service.ts`; the response
 * contract here is unchanged.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const { id } = await params;

  // The cheap 404 and the lock KEY. Every fact the delete records comes from
  // the re-read under the key (#2887's rule, applied here too).
  const existing = await prisma.hutLeaderAssignment.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  try {
    const refusal = await deleteHutLeaderAssignmentUnderLodgeLock({
      assignmentId: id,
      lodgeId: existing.lodgeId,
      actorMemberId: guard.session.user.id,
      auditRequest: getAuditRequestContext(req),
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
