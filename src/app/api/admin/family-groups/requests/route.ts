import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { AgeTier } from "@prisma/client";
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import {
  sendChildRequestApprovedEmail,
  sendChildRequestRejectedEmail,
} from "@/lib/email";

const REVIEWED_REQUEST_TYPES = [
  "JOIN_REQUEST",
  "CHILD_REQUEST",
  "ADULT_REQUEST",
  "REMOVAL_REQUEST",
] as const;

const CHILD_REQUEST_AGE_TIERS: AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

const reviewRequestSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  linkedMemberId: z.string().min(1).optional(),
  createNewMember: z.boolean().optional(),
  rejectionReason: z.string().max(500).optional(),
});

function getSameDayRange(date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { gte: start, lt: end };
}

function getRequestName(request: {
  type: string;
  childFirstName?: string | null;
  childLastName?: string | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
}) {
  if (request.type === "CHILD_REQUEST") {
    return [request.childFirstName, request.childLastName].filter(Boolean).join(" ").trim();
  }
  return [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ").trim();
}

async function findPotentialMemberMatches(request: {
  type: string;
  familyGroupId: string;
  childFirstName?: string | null;
  childLastName?: string | null;
  childDateOfBirth?: Date | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
  requestedDateOfBirth?: Date | null;
  requestedEmail?: string | null;
}) {
  if (request.type !== "CHILD_REQUEST" && request.type !== "ADULT_REQUEST") {
    return [];
  }

  const firstName =
    request.type === "CHILD_REQUEST"
      ? request.childFirstName
      : request.requestedFirstName;
  const lastName =
    request.type === "CHILD_REQUEST"
      ? request.childLastName
      : request.requestedLastName;
  const dateOfBirth =
    request.type === "CHILD_REQUEST"
      ? request.childDateOfBirth
      : request.requestedDateOfBirth;

  if (!firstName || !lastName) {
    return [];
  }

  const members = await prisma.member.findMany({
    where: {
      AND: [
        { firstName: { contains: firstName.trim(), mode: "insensitive" as const } },
        { lastName: { contains: lastName.trim(), mode: "insensitive" as const } },
        ...(dateOfBirth ? [{ dateOfBirth: getSameDayRange(dateOfBirth) }] : []),
        ...(request.type === "ADULT_REQUEST"
          ? [{ ageTier: "ADULT" as AgeTier }]
          : []),
        ...(request.type === "CHILD_REQUEST"
          ? [
              { ageTier: { in: CHILD_REQUEST_AGE_TIERS } },
              { active: true },
            ]
          : []),
        ...(request.type === "ADULT_REQUEST" && request.requestedEmail
          ? [{ email: { equals: request.requestedEmail, mode: "insensitive" as const } }]
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
      canLogin: true,
      dateOfBirth: true,
      familyGroupMemberships: {
        where: { familyGroupId: request.familyGroupId },
        select: { familyGroupId: true },
      },
    },
    orderBy: [{ active: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
    take: 10,
  });

  return members.map((member) => ({
    id: member.id,
    firstName: member.firstName,
    lastName: member.lastName,
    email: member.email,
    ageTier: member.ageTier,
    active: member.active,
    canLogin: member.canLogin,
    dateOfBirth: member.dateOfBirth,
    alreadyInGroup: member.familyGroupMemberships.length > 0,
  }));
}

/**
 * GET /api/admin/family-groups/requests
 * List pending family group change requests.
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
      type: { in: [...REVIEWED_REQUEST_TYPES] },
    },
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      subjectMember: {
        select: { id: true, firstName: true, lastName: true, email: true, ageTier: true, active: true },
      },
      familyGroup: {
        select: {
          id: true,
          name: true,
          memberships: {
            where: { member: { active: true } },
            select: {
              member: {
                select: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const mapped = await Promise.all(
    requests.map(async (request) => ({
      ...request,
      familyGroup: {
        ...request.familyGroup,
        members: request.familyGroup.memberships.map((membership) => membership.member),
        memberships: undefined,
      },
      matchingMembers: await findPotentialMemberMatches(request),
    }))
  );

  return NextResponse.json({ requests: mapped });
}

async function validateLinkedMemberForRequest(params: {
  linkedMemberId: string;
  requestType: string;
}) {
  const linkedMember = await prisma.member.findUnique({
    where: { id: params.linkedMemberId },
    select: { id: true, ageTier: true, active: true, canLogin: true },
  });

  if (!linkedMember) {
    return { error: "Selected member record not found", status: 404 as const };
  }
  if (params.requestType === "CHILD_REQUEST") {
    if (!linkedMember.active || !CHILD_REQUEST_AGE_TIERS.includes(linkedMember.ageTier)) {
      return {
        error: "Selected member must be an active infant, child, or youth",
        status: 422 as const,
      };
    }
  }
  if (params.requestType === "ADULT_REQUEST") {
    if (!linkedMember.active || linkedMember.ageTier !== "ADULT") {
      return { error: "Selected member must be an active adult", status: 422 as const };
    }
    if (linkedMember.canLogin) {
      return {
        error: "Same-email adult requests must link to a non-login adult member",
        status: 422 as const,
      };
    }
  }

  return { memberId: linkedMember.id };
}

/**
 * PUT /api/admin/family-groups/requests
 * Approve or reject a family group change request.
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
      subjectMember: { select: { id: true, firstName: true, lastName: true } },
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
    let affectedMemberId = request.requesterId;
    let adultMemberCreateData: {
      email: string;
      firstName: string;
      lastName: string;
      dateOfBirth: Date;
      ageTier: AgeTier;
      active: true;
      canLogin: false;
      passwordHash: string;
      emailVerified: true;
    } | null = null;

    if (request.type === "CHILD_REQUEST") {
      if (!linkedMemberId) {
        return NextResponse.json(
          { error: "Select the member record to link before approving this infant/child/youth request." },
          { status: 422 }
        );
      }
      const linked = await validateLinkedMemberForRequest({
        linkedMemberId,
        requestType: request.type,
      });
      if ("error" in linked) {
        return NextResponse.json({ error: linked.error }, { status: linked.status });
      }
      affectedMemberId = linked.memberId;
    }

    if (request.type === "ADULT_REQUEST") {
      if (linkedMemberId && parsed.data.createNewMember) {
        return NextResponse.json(
          { error: "Choose an existing member or create a new member, not both." },
          { status: 422 }
        );
      }

      if (linkedMemberId) {
        const linked = await validateLinkedMemberForRequest({
          linkedMemberId,
          requestType: request.type,
        });
        if ("error" in linked) {
          return NextResponse.json({ error: linked.error }, { status: linked.status });
        }
        affectedMemberId = linked.memberId;
      } else if (parsed.data.createNewMember) {
        if (
          !request.requestedFirstName ||
          !request.requestedLastName ||
          !request.requestedDateOfBirth ||
          !request.requestedEmail
        ) {
          return NextResponse.json(
            { error: "Adult request is missing required member details." },
            { status: 422 }
          );
        }

        const ageTier = await computeAgeTier(
          request.requestedDateOfBirth,
          getSeasonStartDate(getSeasonYear())
        );
        if (ageTier !== "ADULT") {
          return NextResponse.json(
            { error: "Requested member is not an adult for the current season." },
            { status: 422 }
          );
        }

        adultMemberCreateData = {
          email: request.requestedEmail.toLowerCase().trim(),
          firstName: request.requestedFirstName.trim(),
          lastName: request.requestedLastName.trim(),
          dateOfBirth: request.requestedDateOfBirth,
          ageTier,
          active: true,
          canLogin: false,
          passwordHash: await hash(randomBytes(32).toString("hex"), 13),
          emailVerified: true,
        };
      } else {
        return NextResponse.json(
          { error: "Select an existing adult member or choose to create a new non-login adult." },
          { status: 422 }
        );
      }
    }

    if (request.type === "REMOVAL_REQUEST") {
      if (!request.subjectMemberId) {
        return NextResponse.json(
          { error: "Removal request is missing the member to remove." },
          { status: 422 }
        );
      }
      affectedMemberId = request.subjectMemberId;
    }

    await prisma.$transaction(async (tx) => {
      if (adultMemberCreateData) {
        const created = await tx.member.create({
          data: adultMemberCreateData,
          select: { id: true },
        });
        affectedMemberId = created.id;
      }

      if (request.type === "REMOVAL_REQUEST") {
        await tx.familyGroupMember.deleteMany({
          where: {
            familyGroupId: request.familyGroupId,
            memberId: affectedMemberId,
          },
        });
      } else {
        await tx.familyGroupMember.upsert({
          where: {
            familyGroupId_memberId: {
              familyGroupId: request.familyGroupId,
              memberId: affectedMemberId,
            },
          },
          create: {
            familyGroupId: request.familyGroupId,
            memberId: affectedMemberId,
            role: "MEMBER",
          },
          update: {},
        });
      }

      await tx.familyGroupJoinRequest.update({
        where: { id: requestId },
        data: {
          status: "APPROVED",
          reviewedAt: new Date(),
          reviewedBy: session.user.id,
          ...(request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
            ? { linkedMemberId: affectedMemberId }
            : {}),
        },
      });
    });

    const auditAction =
      request.type === "CHILD_REQUEST"
        ? "FAMILY_GROUP_CHILD_REQUEST_APPROVED"
        : request.type === "ADULT_REQUEST"
          ? "FAMILY_GROUP_ADULT_REQUEST_APPROVED"
          : request.type === "REMOVAL_REQUEST"
            ? "FAMILY_GROUP_REMOVAL_REQUEST_APPROVED"
            : "FAMILY_GROUP_JOIN_APPROVED";

    logAudit({
      action: auditAction,
      memberId: session.user.id,
      targetId: affectedMemberId,
      subjectMemberId: affectedMemberId,
      entityType: "FamilyGroupJoinRequest",
      entityId: requestId,
      category: "family",
      outcome: "success",
      summary: "Family group request approved",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        linkedMemberId:
          request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
            ? affectedMemberId
            : undefined,
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        linkedMemberId:
          request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST"
            ? affectedMemberId
            : null,
      },
    });

    logger.info(
      {
        requestId,
        requesterId: request.requesterId,
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        affectedMemberId,
      },
      "Family group request approved"
    );

    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = getRequestName(request);
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

    const auditAction =
      request.type === "CHILD_REQUEST"
        ? "FAMILY_GROUP_CHILD_REQUEST_REJECTED"
        : request.type === "ADULT_REQUEST"
          ? "FAMILY_GROUP_ADULT_REQUEST_REJECTED"
          : request.type === "REMOVAL_REQUEST"
            ? "FAMILY_GROUP_REMOVAL_REQUEST_REJECTED"
            : "FAMILY_GROUP_JOIN_REJECTED";

    logAudit({
      action: auditAction,
      memberId: session.user.id,
      targetId: request.subjectMemberId ?? request.requesterId,
      subjectMemberId: request.subjectMemberId ?? request.requesterId,
      entityType: "FamilyGroupJoinRequest",
      entityId: requestId,
      category: "family",
      outcome: "success",
      summary: "Family group request rejected",
      details: JSON.stringify({
        familyGroupId: request.familyGroupId,
        requestId,
        requestType: request.type,
        rejectionReason: rejectionReason || undefined,
      }),
      metadata: {
        familyGroupId: request.familyGroupId,
        requestType: request.type,
        rejectionReason: rejectionReason || null,
      },
    });

    logger.info(
      { requestId, requesterId: request.requesterId, requestType: request.type },
      "Family group request rejected"
    );

    if (request.type === "CHILD_REQUEST" && request.requester) {
      const childName = getRequestName(request);
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
