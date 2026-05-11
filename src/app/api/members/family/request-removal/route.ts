import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendAdminFamilyGroupRequestAlert } from "@/lib/email";

const requestRemovalSchema = z.object({
  familyGroupId: z.string().min(1, "Family group ID required"),
  memberId: z.string().min(1, "Member ID required"),
  notes: z.string().max(500).optional(),
});

/**
 * POST /api/members/family/request-removal
 * Request admin approval to remove an incorrect member from one family group.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const rateLimited = applyRateLimit(rateLimiters.familyGroupJoinRequest, req);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = requestRemovalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const notes = parsed.data.notes?.trim() || null;

  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      active: true,
      ageTier: true,
      canLogin: true,
      familyGroupMemberships: {
        where: { familyGroupId: parsed.data.familyGroupId },
        select: { familyGroupId: true },
      },
    },
  });

  if (!requester || !requester.active) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (!requester.canLogin || requester.ageTier !== "ADULT") {
    return NextResponse.json(
      { error: "Only adult members with login accounts can request family member removals" },
      { status: 403 }
    );
  }
  if (requester.familyGroupMemberships.length === 0) {
    return NextResponse.json(
      { error: "You are not a member of this family group" },
      { status: 403 }
    );
  }

  const targetMembership = await prisma.familyGroupMember.findUnique({
    where: {
      familyGroupId_memberId: {
        familyGroupId: parsed.data.familyGroupId,
        memberId: parsed.data.memberId,
      },
    },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          active: true,
        },
      },
      familyGroup: { select: { id: true, name: true } },
    },
  });

  if (!targetMembership) {
    return NextResponse.json(
      { error: "That member is not in this family group" },
      { status: 404 }
    );
  }

  const existingRequest = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      familyGroupId: parsed.data.familyGroupId,
      requesterId: requester.id,
      type: "REMOVAL_REQUEST",
      status: "PENDING",
      subjectMemberId: parsed.data.memberId,
    },
  });

  if (existingRequest) {
    return NextResponse.json(
      { error: "A removal request for this member is already pending review" },
      { status: 422 }
    );
  }

  const request = await prisma.familyGroupJoinRequest.create({
    data: {
      familyGroupId: parsed.data.familyGroupId,
      requesterId: requester.id,
      type: "REMOVAL_REQUEST",
      subjectMemberId: parsed.data.memberId,
      requestNotes: notes,
    },
  });

  logAudit({
    action: "FAMILY_GROUP_REMOVAL_REQUEST",
    memberId: requester.id,
    targetId: parsed.data.memberId,
    subjectMemberId: parsed.data.memberId,
    entityType: "FamilyGroupJoinRequest",
    entityId: request.id,
    category: "family",
    outcome: "success",
    summary: "Family group removal requested",
    details: JSON.stringify({
      requestId: request.id,
      familyGroupId: parsed.data.familyGroupId,
      notes: notes || undefined,
    }),
    metadata: {
      familyGroupId: parsed.data.familyGroupId,
      notes: notes || null,
    },
  });

  const targetName = `${targetMembership.member.firstName} ${targetMembership.member.lastName}`;
  sendAdminFamilyGroupRequestAlert({
    requestType: "Removal Request",
    requesterName: `${requester.firstName} ${requester.lastName}`,
    groupName: targetMembership.familyGroup.name ?? "Unnamed Group",
    details: `Wants to remove ${targetName} from this family group${notes ? `: ${notes}` : ""}`,
  }).catch((err) => {
    logger.error({ err, requestId: request.id }, "Failed to send admin removal-request alert");
  });

  logger.info(
    {
      requestId: request.id,
      requesterId: requester.id,
      subjectMemberId: parsed.data.memberId,
      familyGroupId: parsed.data.familyGroupId,
    },
    "Family group removal request submitted"
  );

  return NextResponse.json(
    {
      message: "Removal request submitted. An admin will review it.",
      requestId: request.id,
    },
    { status: 201 }
  );
}
