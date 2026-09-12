import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import logger from "@/lib/logger";
import { formatDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { sendHutLeaderAssignmentEmail } from "@/lib/email";
import {
  generateHutLeaderPin,
  hashHutLeaderPin,
} from "@/lib/lodge-pin-session";
import { hasAccessRole } from "@/lib/access-roles";
import {
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getAuditRequestContext } from "@/lib/audit";
import { recordHutLeaderAssignmentAudit } from "@/lib/hut-leader-assignment-audit";
import { findHutLeaderOverlapRefusal } from "@/lib/hut-leader-overlap-guard";
import {
  recordWholeLodgeHoldAmendment,
  type WholeLodgeHoldAmendment,
} from "@/lib/custodian-assignment";
import { validateCustodianBedHoldAndHoldAmendment } from "@/lib/hut-leader-assignment-service";
import { custodianBedHoldErrorResponse } from "@/lib/custodian-assignment-routes";
import { isMinorAgeTier } from "@/lib/custodian-occupancy";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { HutLeaderAssignmentSource } from "@prisma/client";

const createSchema = z.object({
  memberId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lodgeId: z.string().min(1),
  // Custodian bed hold (#2286). Optional AND nullable: absent or null is the
  // default "No bed — role only", which behaves exactly as it did before this
  // feature and has zero capacity effect.
  bedId: z.string().min(1).nullable().optional(),
  // #1668-style explicit override of the over-capacity warning.
  confirmOverCapacity: z.boolean().optional(),
  // #2698 ordering case: the officer's EXPLICIT acceptance that holding this
  // bed narrows an existing whole-lodge hold's represented bed set. Absent is
  // decline-by-default — the request is refused with 409
  // CUSTODIAN_OVERLAPS_WHOLE_LODGE_HOLD and nothing is written.
  amendOverlappingHolds: z.boolean().optional(),
}).refine((data) => data.startDate <= data.endDate, {
  message: "startDate must be before or equal to endDate",
});

class HutLeaderOverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HutLeaderOverlapError";
  }
}

/**
 * GET /api/admin/hut-leaders
 * List hut leader assignments for one required active lodge.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const requestedLodgeId = new URL(req.url).searchParams.get("lodgeId");
  const lodgeId = requestedLodgeId
    ? await resolveOptionalActiveLodgeId(prisma, requestedLodgeId)
    : null;
  if (!lodgeId) {
    return NextResponse.json({ error: "A valid lodgeId is required." }, { status: 400 });
  }
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: { lodgeId },
    include: {
      member: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      lodge: {
        select: { id: true, name: true },
      },
      // Custodian bed hold (#2286): which bed (if any) this assignment holds,
      // so the admin table can show it next to the dates.
      bed: {
        select: { id: true, name: true, room: { select: { name: true } } },
      },
    },
    orderBy: { startDate: "desc" },
  });

  return NextResponse.json({
    assignments: assignments.map((a) => ({
      id: a.id,
      memberId: a.memberId,
      memberName: `${a.member.firstName} ${a.member.lastName}`,
      memberEmail: a.member.email,
      startDate: formatDateOnly(a.startDate),
      endDate: formatDateOnly(a.endDate),
      createdAt: a.createdAt.toISOString(),
      lodgeId: a.lodgeId,
      lodgeName: a.lodge?.name ?? null,
      // #2286: null = role only, with no capacity effect at all.
      bedId: a.bedId,
      bedName: a.bed?.name ?? null,
      bedRoomName: a.bed?.room.name ?? null,
    })),
  });
}

/**
 * POST /api/admin/hut-leaders
 * Create a new hut leader assignment.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "lodge", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // The assignment is a lodge-scoped operational writer. Resolve that scope
  // before even looking up the member so an omitted/invalid lodge cannot fall
  // through to the club default or perform unrelated downstream work.
  const lodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    parsed.data.lodgeId,
  );
  if (!lodgeId) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    );
  }

  const member = await prisma.member.findUnique({
    where: { id: parsed.data.memberId },
    select: {
      id: true,
      active: true,
      email: true,
      firstName: true,
      // #2286: a minor custodian is never individually named on the lobby TV,
      // so the admin is warned at assignment time.
      ageTier: true,
      accessRoles: { select: { role: true } },
    },
  });

  if (!member || !member.active || !hasAccessRole(member, "USER")) {
    return NextResponse.json(
      { error: "Member not found or not eligible for hut leader assignment" },
      { status: 404 }
    );
  }

  // Check for overlapping assignments — 1 day overlap allowed for handover, 2+ rejected
  if (!isDateOnlyString(parsed.data.startDate) || !isDateOnlyString(parsed.data.endDate)) {
    return NextResponse.json({ error: "Invalid startDate or endDate" }, { status: 400 });
  }
  const newStart = parseDateOnly(parsed.data.startDate);
  const newEnd = parseDateOnly(parsed.data.endDate);

  // The cheap pre-lock ask, through the SAME predicate the locked re-read
  // below uses, so the two can never disagree about what an overlap is.
  const earlyOverlap = await findHutLeaderOverlapRefusal(prisma, {
    lodgeId,
    startDate: newStart,
    endDate: newEnd,
    // #2926: a DELIBERATE officer action, so the teacher carve-out applies.
    allowOverlappingSchoolRows: true,
  });
  if (earlyOverlap) {
    return NextResponse.json({ error: earlyOverlap.error }, { status: 409 });
  }

  // Custodian bed hold (#2286): a bed can only mean anything while the
  // bed-allocation module is on — rooms and beds exist only under it.
  const bedId = parsed.data.bedId ?? null;
  if (bedId && !(await isEffectiveModuleEnabled("bedAllocation"))) {
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
  // #2698: the officer has already been shown the 409 and accepted, so this
  // request will narrow somebody else's whole-lodge hold. Decided BEFORE any
  // lock is taken, because it decides WHICH locks are taken (INV-LOCK-002:
  // global then lodge, never the other order).
  const amendRequested = parsed.data.amendOverlappingHolds === true;

  try {
    const pin = generateHutLeaderPin();
    const hutLeaderPin = await hashHutLeaderPin(pin);

    // Bed-holding and role-only assignments share the lodge key: both must
    // serialize the overlap predicate, while the bed path additionally repeats
    // capacity validation after that same lock (INV-LOCK-001/002).
    //
    // The PIN email deliberately stays OUTSIDE the transaction (AGENTS.md: no
    // external provider call inside a DB transaction), with its existing
    // failure-tolerant `emailSent` handling untouched.
    const created = await prisma.$transaction(async (tx) => {
      // #2698 amend path only: the global cohort key, taken FIRST and only
      // when the officer has accepted (INV-LOCK-001/002). Narrowing a hold's
      // represented set has to be decided against a hold that cannot be
      // released underneath it, and the release path — booking cancel's
      // RELEASE_WHOLE_LODGE_HOLD_UPDATE — serialises on the club-wide key and
      // never on this lodge's, so the lodge key alone would not exclude it.
      // The detect-and-refuse path writes nothing, so it keeps the narrower
      // pre-#2698 topology: a hold cancelled under it costs the officer a
      // retry, never a wrong write.
      if (amendRequested) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      }
      await acquireLodgeCapacityLock(tx, parsed.data.lodgeId);
      const lockedLodgeId = await resolveOptionalActiveLodgeId(
        tx,
        parsed.data.lodgeId,
      );
      if (!lockedLodgeId) throw new Error("LOCKED_LODGE_NOT_ACTIVE");

      const lockedMember = await tx.member.findUnique({
        where: { id: parsed.data.memberId },
        select: {
          id: true,
          active: true,
          email: true,
          firstName: true,
          ageTier: true,
          accessRoles: { select: { role: true } },
        },
      });
      if (
        !lockedMember ||
        !lockedMember.active ||
        !hasAccessRole(lockedMember, "USER")
      ) {
        throw new Error("LOCKED_MEMBER_NOT_ELIGIBLE");
      }

      const lockedOverlap = await findHutLeaderOverlapRefusal(tx, {
        lodgeId: lockedLodgeId,
        startDate: newStart,
        endDate: newEnd,
        // #2926: a DELIBERATE officer action, so the teacher carve-out applies.
        allowOverlappingSchoolRows: true,
      });
      if (lockedOverlap) throw new HutLeaderOverlapError(lockedOverlap.error);

      // The hard bed refusals, then the #2698 ordering question — in that
      // order, and shared with the edit so the two cannot drift. Declining
      // throws, which rolls this whole transaction back: "no partial durable
      // state" is the transaction, not a cleanup path.
      let amendments: WholeLodgeHoldAmendment[] = [];
      if (bedId) {
        amendments = await validateCustodianBedHoldAndHoldAmendment(tx, {
          bedId,
          lodgeId: lockedLodgeId,
          startDate: newStart,
          endDate: newEnd,
          confirmOverCapacity: parsed.data.confirmOverCapacity,
          amendAccepted: amendRequested,
        });
      }
      const assignment = await tx.hutLeaderAssignment.create({
        data: {
          memberId: parsed.data.memberId,
          startDate: newStart,
          endDate: newEnd,
          hutLeaderPin,
          lodgeId: lockedLodgeId,
          // #2926: an officer put this leader here. Stamped rather than left
          // to the column default so the census reads it off the call site.
          source: HutLeaderAssignmentSource.MANUAL,
          ...(bedId ? { bedId } : {}),
        },
      });

      await recordHutLeaderAssignmentAudit(tx, {
        event: "created",
        actorMemberId: session.user.id,
        subjectMemberId: parsed.data.memberId,
        assignmentId: assignment.id,
        lodgeId: lockedLodgeId,
        startDate: newStart,
        endDate: newEnd,
        bedId,
        requestId: auditRequest?.id,
        ipAddress: auditRequest?.ipAddress,
        userAgent: auditRequest?.userAgent,
      });

      if (bedId && amendments.length > 0) {
        // Same transaction as the create above: accept writes both facts or
        // neither (#2698, "one logical atomic audited action").
        await recordWholeLodgeHoldAmendment(tx, {
          actorMemberId: session.user.id,
          assignmentId: assignment.id,
          lodgeId: lockedLodgeId,
          bedId,
          amendments,
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        });
      }
      return { assignment, member: lockedMember, amendments };
    });
    const { assignment } = created;

    let emailSent = true;
    try {
      await sendHutLeaderAssignmentEmail({
        email: created.member.email,
        firstName: created.member.firstName,
        startDate: newStart,
        endDate: newEnd,
        pin,
        assignmentId: assignment.id,
      });
    } catch (err) {
      emailSent = false;
      logger.error(
        { err, assignmentId: assignment.id, memberId: created.member.id },
        "Failed to send hut leader assignment email"
      );
    }

    logger.info(
      { assignmentId: assignment.id, memberId: parsed.data.memberId },
      "Hut leader assignment created"
    );

    return NextResponse.json(
      {
        id: assignment.id,
        emailSent,
        // #2286 privacy guard: a minor holding a bed is never individually
        // named on the lobby TV (the display contract forbids it at every
        // granularity), so the screen shows the role word alone. Tell the admin
        // now rather than letting them expect a name that will never appear.
        minorCustodianWarning:
          bedId && isMinorAgeTier(created.member.ageTier)
            ? "This member is a minor, so the lodge screen will show the custodian role only and never their name."
            : null,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof HutLeaderOverlapError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof Error && err.message === "LOCKED_LODGE_NOT_ACTIVE") {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      );
    }
    if (err instanceof Error && err.message === "LOCKED_MEMBER_NOT_ELIGIBLE") {
      return NextResponse.json(
        { error: "Member not found or not eligible for hut leader assignment" },
        { status: 404 },
      );
    }
    const custodianResponse = custodianBedHoldErrorResponse(err);
    if (custodianResponse) return custodianResponse;
    logger.error({ err }, "Error creating hut leader assignment");
    return NextResponse.json({ error: "Failed to create assignment" }, { status: 500 });
  }
}
