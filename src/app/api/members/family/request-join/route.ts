import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendAdminFamilyGroupRequestAlert, sendJoinRequestConfirmationEmail } from "@/lib/email";

const requestJoinSchema = z.object({
  targetEmail: z.string().email("Invalid email address"),
});

/**
 * POST /api/members/family/request-join
 * Request to join another member's family group.
 * The target must be an existing active adult member who is in at least one family group.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
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

  const parsed = requestJoinSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { targetEmail } = parsed.data;

  // Fetch requester
  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { id: true, firstName: true, lastName: true, active: true, canLogin: true },
  });

  if (!requester || !requester.active) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (!requester.canLogin) {
    return NextResponse.json({ error: "Only members with login accounts can request to join a family group" }, { status: 403 });
  }

  // Check for existing pending request from this requester
  const existingRequest = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      requesterId: session.user.id,
      type: "JOIN_REQUEST",
      status: "PENDING",
    },
  });

  if (existingRequest) {
    return NextResponse.json(
      { error: "You already have a pending join request. Please wait for it to be reviewed." },
      { status: 422 }
    );
  }

  // Find target member by email — must be active and able to login
  const target = await prisma.member.findFirst({
    where: {
      email: targetEmail.toLowerCase(),
      canLogin: true,
      active: true,
    },
    select: {
      id: true, firstName: true, lastName: true,
      familyGroupMemberships: {
        select: { familyGroupId: true, familyGroup: { select: { id: true, name: true } } },
        take: 1,
      },
    },
  });

  if (!target) {
    return NextResponse.json(
      { error: "No active member found with that email address" },
      { status: 404 }
    );
  }

  if (target.id === session.user.id) {
    return NextResponse.json({ error: "You cannot request to join your own group" }, { status: 422 });
  }

  let familyGroupId: string;

  if (target.familyGroupMemberships.length > 0) {
    // Target is in a family group — request to join their first group
    familyGroupId = target.familyGroupMemberships[0].familyGroupId;
  } else {
    // Create a new family group with the target member as lead
    const newGroup = await prisma.$transaction(async (tx) => {
      const group = await tx.familyGroup.create({
        data: { name: `${target.lastName} Family` },
      });
      await tx.familyGroupMember.create({
        data: {
          familyGroupId: group.id,
          memberId: target.id,
          role: "ADMIN",
        },
      });
      return group;
    });
    familyGroupId = newGroup.id;
  }

  const joinRequest = await prisma.familyGroupJoinRequest.create({
    data: {
      familyGroupId,
      requesterId: session.user.id,
      type: "JOIN_REQUEST",
    },
  });

  logAudit({
    action: "FAMILY_GROUP_JOIN_REQUESTED",
    memberId: session.user.id,
    targetId: familyGroupId,
    subjectMemberId: session.user.id,
    entityType: "FamilyGroupJoinRequest",
    entityId: joinRequest.id,
    category: "family",
    outcome: "success",
    summary: "Family group join requested",
    details: JSON.stringify({ targetEmail, targetMemberId: target.id }),
    metadata: {
      familyGroupId,
      targetEmail,
      targetMemberId: target.id,
    },
  });

  logger.info(
    { requestId: joinRequest.id, requesterId: session.user.id, familyGroupId },
    "Family group join request created"
  );

  // Fetch group name for emails
  const groupInfo = await prisma.familyGroup.findUnique({
    where: { id: familyGroupId },
    select: { name: true },
  });
  const groupName = groupInfo?.name ?? "Unnamed Group";

  // Fetch requester email for confirmation
  const requesterEmail = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });

  // Send requester confirmation email (fire-and-forget)
  if (requesterEmail) {
    sendJoinRequestConfirmationEmail(
      requesterEmail.email,
      `${requester.firstName} ${requester.lastName}`,
      groupName
    ).catch((err) => {
      logger.error({ err, requestId: joinRequest.id }, "Failed to send join request confirmation email");
    });
  }

  // Send admin alert (fire-and-forget)
  sendAdminFamilyGroupRequestAlert({
    requestType: "Join Request",
    requesterName: `${requester.firstName} ${requester.lastName}`,
    groupName,
    details: `Wants to join via ${targetEmail}`,
  }).catch((err) => {
    logger.error({ err, requestId: joinRequest.id }, "Failed to send admin family group request alert");
  });

  return NextResponse.json(
    {
      message: "Join request submitted. An admin will review your request.",
      requestId: joinRequest.id,
    },
    { status: 201 }
  );
}
