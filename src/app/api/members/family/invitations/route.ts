import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendFamilyGroupInviteAcceptedEmail } from "@/lib/email";

/**
 * GET /api/members/family/invitations
 * List pending invitations for the logged-in user.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const invitations = await prisma.familyGroupJoinRequest.findMany({
    where: {
      invitedMemberId: session.user.id,
      type: "ADULT_INVITE",
      status: "PENDING",
    },
    include: {
      familyGroup: { select: { id: true, name: true } },
      requester: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ invitations });
}

const respondSchema = z.object({
  invitationId: z.string().min(1),
  action: z.enum(["accept", "decline"]),
});

/**
 * PUT /api/members/family/invitations
 * Accept or decline a pending invitation.
 */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = respondSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { invitationId, action } = parsed.data;

  const invitation = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      id: invitationId,
      invitedMemberId: session.user.id,
      type: "ADULT_INVITE",
      status: "PENDING",
    },
    include: {
      familyGroup: { select: { id: true, name: true } },
      requester: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  if (!invitation) {
    return NextResponse.json({ error: "Invitation not found or already processed" }, { status: 404 });
  }

  if (action === "accept") {
    // Add the member to the family group and update the invitation
    await prisma.$transaction(async (tx) => {
      await tx.familyGroupMember.upsert({
        where: {
          familyGroupId_memberId: {
            familyGroupId: invitation.familyGroupId,
            memberId: session.user.id,
          },
        },
        create: {
          familyGroupId: invitation.familyGroupId,
          memberId: session.user.id,
          role: "MEMBER",
        },
        update: {},
      });

      await tx.familyGroupJoinRequest.update({
        where: { id: invitationId },
        data: {
          status: "APPROVED",
          reviewedAt: new Date(),
          reviewedBy: session.user.id,
        },
      });
    });

    logAudit({
      action: "FAMILY_GROUP_INVITE_ACCEPTED",
      memberId: session.user.id,
      targetId: invitation.familyGroupId,
      subjectMemberId: session.user.id,
      entityType: "FamilyGroupJoinRequest",
      entityId: invitationId,
      category: "family",
      outcome: "success",
      summary: "Family group invitation accepted",
      details: JSON.stringify({ invitationId }),
      metadata: {
        familyGroupId: invitation.familyGroupId,
        invitationId,
      },
    });

    logger.info(
      { invitationId, memberId: session.user.id, familyGroupId: invitation.familyGroupId },
      "Family group invitation accepted"
    );

    // Notify the inviter (fire-and-forget)
    if (invitation.requester) {
      const invitee = await prisma.member.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true },
      });
      const inviteeName = invitee ? `${invitee.firstName} ${invitee.lastName}` : "A member";
      sendFamilyGroupInviteAcceptedEmail(
        invitation.requester.email,
        inviteeName,
        invitation.familyGroup.name ?? "your family group"
      ).catch((err) => {
        logger.error({ err, invitationId }, "Failed to send invite-accepted email");
      });
    }

    return NextResponse.json({
      message: `You have joined ${invitation.familyGroup.name}.`,
    });
  } else {
    // Decline the invitation
    await prisma.familyGroupJoinRequest.update({
      where: { id: invitationId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: session.user.id,
      },
    });

    logAudit({
      action: "FAMILY_GROUP_INVITE_DECLINED",
      memberId: session.user.id,
      targetId: invitation.familyGroupId,
      subjectMemberId: session.user.id,
      entityType: "FamilyGroupJoinRequest",
      entityId: invitationId,
      category: "family",
      outcome: "success",
      summary: "Family group invitation declined",
      details: JSON.stringify({ invitationId }),
      metadata: {
        familyGroupId: invitation.familyGroupId,
        invitationId,
      },
    });

    logger.info(
      { invitationId, memberId: session.user.id },
      "Family group invitation declined"
    );

    return NextResponse.json({
      message: "Invitation declined.",
    });
  }
}
