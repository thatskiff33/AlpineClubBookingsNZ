import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const reviewRequestSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
});

/**
 * GET /api/admin/family-groups/requests
 * List pending family group join requests.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const requests = await prisma.familyGroupJoinRequest.findMany({
    where: { status: "PENDING" },
    include: {
      requester: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      familyGroup: {
        select: {
          id: true,
          name: true,
          members: {
            where: { active: true },
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ requests });
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

  const request = await prisma.familyGroupJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      requester: { select: { id: true, firstName: true, lastName: true, familyGroupId: true } },
    },
  });

  if (!request) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  if (request.status !== "PENDING") {
    return NextResponse.json({ error: "Request has already been reviewed" }, { status: 422 });
  }

  if (action === "approve") {
    // Check requester isn't already in a group (may have joined another since requesting)
    if (request.requester.familyGroupId) {
      return NextResponse.json(
        { error: "Requester is already in a family group. Rejecting automatically." },
        { status: 422 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.member.update({
        where: { id: request.requesterId },
        data: { familyGroupId: request.familyGroupId },
      });
      await tx.familyGroupJoinRequest.update({
        where: { id: requestId },
        data: {
          status: "APPROVED",
          reviewedAt: new Date(),
          reviewedBy: session.user.id,
        },
      });
    });

    logAudit({
      action: "FAMILY_GROUP_JOIN_APPROVED",
      memberId: session.user.id,
      targetId: request.requesterId,
      details: JSON.stringify({ familyGroupId: request.familyGroupId }),
    });

    logger.info(
      { requestId, requesterId: request.requesterId, familyGroupId: request.familyGroupId },
      "Family group join request approved"
    );
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
      action: "FAMILY_GROUP_JOIN_REJECTED",
      memberId: session.user.id,
      targetId: request.requesterId,
      details: JSON.stringify({ familyGroupId: request.familyGroupId }),
    });

    logger.info({ requestId, requesterId: request.requesterId }, "Family group join request rejected");
  }

  return NextResponse.json({ success: true, action });
}
