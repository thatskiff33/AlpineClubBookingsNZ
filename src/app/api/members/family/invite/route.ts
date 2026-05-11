import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendFamilyGroupInvitationEmail } from "@/lib/email";

const inviteSchema = z.object({
  email: z.string().email("Invalid email address"),
  familyGroupId: z.string().min(1, "Family group ID required"),
});

/**
 * POST /api/members/family/invite
 * Any adult in a family group can invite another existing adult member by email.
 * Self-service: invitee accepts/declines directly, no admin approval needed.
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

  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { email, familyGroupId } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Verify requester is an active adult member in the specified group
  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true, firstName: true, lastName: true, active: true, ageTier: true, canLogin: true,
      familyGroupMemberships: {
        where: { familyGroupId },
        select: { familyGroupId: true },
      },
    },
  });

  if (!requester || !requester.active) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (requester.ageTier !== "ADULT") {
    return NextResponse.json({ error: "Only adults can invite members to a family group" }, { status: 403 });
  }

  if (requester.familyGroupMemberships.length === 0) {
    return NextResponse.json({ error: "You are not a member of this family group" }, { status: 403 });
  }

  // Find the target member by email — must be an existing, active, canLogin adult
  const target = await prisma.member.findFirst({
    where: {
      email: normalizedEmail,
      canLogin: true,
      active: true,
    },
    select: {
      id: true, firstName: true, lastName: true, ageTier: true,
      familyGroupMemberships: {
        where: { familyGroupId },
        select: { familyGroupId: true },
      },
    },
  });

  if (!target) {
    return NextResponse.json(
      {
        error: "This person is not a registered member. They need to join through the membership process first. Contact admin if you believe they should be a member.",
      },
      { status: 404 }
    );
  }

  if (target.id === session.user.id) {
    return NextResponse.json({ error: "You cannot invite yourself" }, { status: 422 });
  }

  if (target.ageTier !== "ADULT") {
    return NextResponse.json(
      { error: "Only adults can be invited directly. For children or youth, use the 'Request to Add Child/Youth' option instead." },
      { status: 422 }
    );
  }

  // Check if target is already in this group
  if (target.familyGroupMemberships.length > 0) {
    return NextResponse.json({ error: "This member is already in this family group" }, { status: 422 });
  }

  // Check for existing pending invitation
  const existingInvite = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      familyGroupId,
      invitedMemberId: target.id,
      type: "ADULT_INVITE",
      status: "PENDING",
    },
  });

  if (existingInvite) {
    return NextResponse.json({ error: "An invitation is already pending for this member" }, { status: 422 });
  }

  // Create the invitation
  const invitation = await prisma.familyGroupJoinRequest.create({
    data: {
      familyGroupId,
      requesterId: session.user.id,
      type: "ADULT_INVITE",
      invitedMemberId: target.id,
    },
  });

  logAudit({
    action: "FAMILY_GROUP_INVITE_SENT",
    memberId: session.user.id,
    targetId: familyGroupId,
    subjectMemberId: target.id,
    entityType: "FamilyGroupJoinRequest",
    entityId: invitation.id,
    category: "family",
    outcome: "success",
    summary: "Family group invitation sent",
    details: JSON.stringify({ invitedEmail: normalizedEmail, invitedMemberId: target.id }),
    metadata: {
      familyGroupId,
      invitedEmail: normalizedEmail,
      invitedMemberId: target.id,
    },
  });

  logger.info(
    { invitationId: invitation.id, inviterId: session.user.id, invitedId: target.id, familyGroupId },
    "Family group invitation sent"
  );

  // Send email notification to invited member (fire-and-forget)
  const groupInfo = await prisma.familyGroup.findUnique({
    where: { id: familyGroupId },
    select: { name: true },
  });
  sendFamilyGroupInvitationEmail(
    normalizedEmail,
    `${requester.firstName} ${requester.lastName}`,
    groupInfo?.name ?? "your family group"
  ).catch((err) => {
    logger.error({ err, invitationId: invitation.id }, "Failed to send family group invitation email");
  });

  return NextResponse.json(
    {
      message: `Invitation sent to ${target.firstName} ${target.lastName}. They can accept or decline from their profile.`,
      invitationId: invitation.id,
    },
    { status: 201 }
  );
}
