import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import {
  canReadLodgeInstructions,
  getSanitizedLodgeInstructions,
} from "@/lib/lodge-instructions";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { getDefaultLodgeId } from "@/lib/lodges";
import { hasAdminAccess } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";

/**
 * The distinct lodge ids the member is a hut leader for (current or upcoming
 * assignments, club date-only semantics). Assignments with a null lodgeId count
 * as the club's default lodge, matching resolveKioskLodgeId's hut-leader
 * semantics. This is both the set the member may read documents for (M4) and
 * the basis for the no-lodgeId default below.
 */
async function getMemberInstructionLodgeIds(
  memberId: string,
): Promise<Set<string>> {
  /*
    CT-4 (#2870): "today" is the CLUB's day, from the persisted ClubTimeSettings
    zone and not the container's TZ (INV-CONFIG-002, INV-DATE-019).
    `HutLeaderAssignment.endDate` is `@db.Date`, so the bound must be that day at
    UTC MIDNIGHT: a club-local midnight bound narrows to the PREVIOUS day and
    silently drops an assignment that ends today (INV-DATE-026).
  */
  const today = await clubTodayDateOnlyInstant();
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: { memberId, endDate: { gte: today } },
    select: { lodgeId: true },
  });

  const lodgeIds = new Set<string>();
  let defaultLodgeId: string | null = null;
  for (const assignment of assignments) {
    if (assignment.lodgeId) {
      lodgeIds.add(assignment.lodgeId);
    } else {
      defaultLodgeId ??= await getDefaultLodgeId(prisma);
      lodgeIds.add(defaultLodgeId);
    }
  }
  return lodgeIds;
}

/**
 * Resolve which lodge's instructions the member should see when the request
 * does not name one: the lodge of their current or upcoming hut leader
 * assignments when those cover exactly one distinct lodge, else null (the
 * club-wide documents).
 */
async function resolveMemberInstructionLodgeId(
  memberId: string,
): Promise<string | null> {
  const lodgeIds = await getMemberInstructionLodgeIds(memberId);
  return lodgeIds.size === 1 ? [...lodgeIds][0] : null;
}

/**
 * GET /api/lodge-instructions?lodgeId=<id>
 * Reader endpoint for the member-facing lodge instructions page.
 * Admins always qualify; members qualify only while they hold a current
 * or upcoming hut leader assignment. Everyone else gets a 403 the page
 * turns into the "you're not currently assigned" state.
 *
 * The optional lodgeId selects which lodge's override documents replace
 * the club-wide ones; when omitted, the member's assignment lodge is used
 * if unambiguous, otherwise the club-wide documents are returned.
 */
export async function GET(request: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }

  const allowed = await canReadLodgeInstructions(
    guard.session.user.id,
    guard.session.user,
  );

  if (!allowed) {
    return NextResponse.json(
      { error: "You are not currently assigned as a hut leader" },
      { status: 403 },
    );
  }

  const requestedLodgeId = request.nextUrl.searchParams.get("lodgeId");

  let lodgeId: string | null;
  if (requestedLodgeId) {
    // M4: a hut leader may only read their OWN assignment lodges' documents
    // (which may carry door codes / emergency access details); admins may
    // request any lodge. Without this a hut leader for lodge A could read
    // lodge B's operational instructions.
    if (!hasAdminAccess(guard.session.user)) {
      const allowedLodgeIds = await getMemberInstructionLodgeIds(
        guard.session.user.id,
      );
      if (!allowedLodgeIds.has(requestedLodgeId)) {
        return NextResponse.json(
          { error: "You are not assigned as a hut leader for that lodge" },
          { status: 403 },
        );
      }
    }
    lodgeId = requestedLodgeId;
  } else {
    lodgeId = await resolveMemberInstructionLodgeId(guard.session.user.id);
  }

  // Reader surface: the member's lodge documents (club-wide fallback) with
  // text tokens ({{club-name}} etc.) resolved for display.
  const documents = await getSanitizedLodgeInstructions({
    lodgeId,
    resolveTokens: true,
  });
  return NextResponse.json({ documents });
}
