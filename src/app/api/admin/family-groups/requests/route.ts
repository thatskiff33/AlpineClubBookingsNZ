import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendChildRequestApprovedEmail, sendChildRequestRejectedEmail } from "@/lib/email";

const reviewRequestSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  linkedMemberId: z.string().min(1).optional(),
  rejectionReason: z.string().max(500).optional(),
});

function getSameDayRange(date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { gte: start, lt: end };
}

/**
 * GET /api/admin/family-groups/requests
 * List pending family group join requests.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const requests = await prisma.familyGroupJoinRequest.findMany({
    where: {
      status: "PENDING",
      type: { in: ["JOIN_REQUEST", "CHILD_REQUEST"] },
    },
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      familyGroup: {
        select: {
          id: true,
          name: true,
          memberships: {
            where: { member: { active: true } },
            select: { member: { select: { id: true, firstName: true, lastName: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const mapped = await Promise.all(
    requests.map(async (request) => {
      let matchingMembers: Array<{
        id: string;
        firstName: string;
        lastName: string;
        email: string;
        ageTier: string;
        active: boolean;
        dateOfBirth: Date | null;
        alreadyInGroup: boolean;
      }> = [];

      if (request.type === "CHILD_REQUEST" && request.childFirstName && request.childLastName) {
        const nameFilters = [
          {
            firstName: {
              contains: request.childFirstName.trim(),
              mode: "insensitive" as const,
            },
          },
          {
            lastName: {
              contains: request.childLastName.trim(),
              mode: "insensitive" as const,
            },
          },
        ];

        const childMatches = await prisma.member.findMany({
          where: {
            AND: [
              ...nameFilters,
              ...(request.childDateOfBirth
                ? [{ dateOfBirth: getSameDayRange(request.childDateOfBirth) }]
                : []),
            ],
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            ageTier: true,
            active: true,
            dateOfBirth: true,
            familyGroupMemberships: {
              where: { familyGroupId: request.familyGroupId },
              select: { familyGroupId: true },
            },
          },
          orderBy: [{ active: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
          take: 10,
        });

        matchingMembers = childMatches.map((member) => ({
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
          ageTier: member.ageTier,
          active: member.active,
          dateOfBirth: member.dateOfBirth,
          alreadyInGroup: member.familyGroupMemberships.length > 0,
        }));
      }

      return {
        ...request,
        familyGroup: {
          ...request.familyGroup,
          members: request.familyGroup.memberships.map((membership) => membership.member),
          memberships: undefined,
        },
        matchingMembers,
      };
    })
  );

  return NextResponse.json({ requests: mapped });
}

/**
 * PUT /api/admin/family-groups/requests
 * Approve or reject a join request.
 */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
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

  const parsed = reviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { requestId, action } = parsed.data;
  const linkedMemberId = parsed.data.linkedMemberId?.trim();
  const rejectionReason = parsed.data.rejectionReason?.trim();

  const request = await prisma.familyGroupJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      requester: { select: { id: true, firstName: true, lastName: true, email: true } },
      familyGroup: { select: { id: true, name: true } },
    },
  });

  if (!request) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  if (request.status !== "PENDING") {
    return NextResponse.json({ error: "Request has already been reviewed" }, { status: 422 });
  }

  if (request.type === "ADULT_INVITE") {
    return NextResponse.json(
      { error: "Adult invitations are managed by the invited member, not admin review." },
      { status: 422 }
    );
  }

  if (action === "approve") {
    let memberIdToLink = request.requesterId;

    if (request.type === "CHILD_REQUEST") {
      if (!linkedMemberId) {
        return NextResponse.json(
          { error: "Select the member record to link before approving this child/youth request." },
          { status: 422 }
        );
      }

      const linkedMember = await prisma.member.findUnique({
        where: { id: linkedMemberId },
        select: { id: true },
      });

      if (!linkedMember) {
        return NextResponse.json({ error: "Selected member record not found" }, { status: 404 });
      }

      memberIdToLink = linkedMemberId;
    }

    await prisma.$transaction(async (tx) => {
      // Add to join table (multi-group: no restriction on existing memberships)
      await tx.familyGroupMember.upsert({
        where: { familyGroupId_memberId: { familyGroupId: request.familyGroupId, memberId: memberIdToLink } },
        create: { familyGroupId: request.familyGroupId, memberId: memberIdToLink, role: "MEMBER" },
        update: {},
      });
      await tx.familyGroupJoinRequest.update({
        where: { id: requestId },
        data: {
          status: "APPROVED",
          reviewedAt: new Date(),
          reviewedBy: session.user.id,
          ...(request.type === "CHILD_REQUEST" ? { linkedMemberId: memberIdToLink } : {}),
        },
      });
    });

    logAudit({
      action:
        request.type === "CHILD_REQUEST"
          ? "FAMILY_GROUP_CHILD_REQUEST_APPROVED"
          : "FAMILY_GROUP_JOIN_APPROVED",
      memberId: session.user.id,
      targetId: memberIdToLink,
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        ...(request.type === "CHILD_REQUEST" ? { linkedMemberId: memberIdToLink } : {}),
      }),
    });

    logger.info(
      {
        requestId,
        requesterId: request.requesterId,
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        linkedMemberId: request.type === "CHILD_REQUEST" ? memberIdToLink : undefined,
      },
      "Family group join request approved"
    );

    // Send approval notification for child requests
    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = `${request.childFirstName ?? ""} ${request.childLastName ?? ""}`.trim();
      sendChildRequestApprovedEmail(
        request.requester.email,
        request.requester.firstName,
        childName || "your child",
        request.familyGroup?.name ?? "your family group"
      ).catch((err) => {
        logger.error({ err, requestId }, "Failed to send child request approved email");
      });
    }
  } else {
    await prisma.familyGroupJoinRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: session.user.id,
      },
    });

    logAudit({
      action:
        request.type === "CHILD_REQUEST"
          ? "FAMILY_GROUP_CHILD_REQUEST_REJECTED"
          : "FAMILY_GROUP_JOIN_REJECTED",
      memberId: session.user.id,
      targetId: request.requesterId,
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        rejectionReason: rejectionReason || undefined,
      }),
    });

    logger.info(
      { requestId, requesterId: request.requesterId, requestType: request.type },
      "Family group join request rejected"
    );

    // Send rejection notification for child requests
    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = `${request.childFirstName ?? ""} ${request.childLastName ?? ""}`.trim();
      sendChildRequestRejectedEmail(
        request.requester.email,
        request.requester.firstName,
        childName || "your child",
        rejectionReason || undefined
      ).catch((err) => {
        logger.error({ err, requestId }, "Failed to send child request rejected email");
      });
    }
  }

  return NextResponse.json({ success: true, action });
}
