import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";

const requestJoinSchema = z.object({
  targetEmail: z.string().email("Invalid email address"),
});

/**
 * POST /api/members/family/request-join
 * Request to join another member's family group.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Rate limit: 3 per hour
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
    select: { id: true, firstName: true, lastName: true, parentMemberId: true, familyGroupId: true, active: true },
  });

  if (!requester || !requester.active) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (requester.parentMemberId) {
    return NextResponse.json(
      { error: "Dependents cannot request to join a family group" },
      { status: 403 }
    );
  }

  if (requester.familyGroupId) {
    return NextResponse.json(
      { error: "You are already in a family group. Leave your current group first or contact an admin." },
      { status: 422 }
    );
  }

  // Find target member by email (must be primary and active)
  const target = await prisma.member.findFirst({
    where: {
      email: targetEmail.toLowerCase(),
      parentMemberId: null,
      active: true,
    },
    select: { id: true, firstName: true, lastName: true, familyGroupId: true },
  });

  if (!target) {
    return NextResponse.json(
      { error: "No active primary member found with that email address" },
      { status: 404 }
    );
  }

  if (target.id === session.user.id) {
    return NextResponse.json({ error: "You cannot request to join your own group" }, { status: 422 });
  }

  // Check for existing pending request from this requester
  const existingRequest = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      requesterId: session.user.id,
      status: "PENDING",
    },
  });

  if (existingRequest) {
    return NextResponse.json(
      { error: "You already have a pending join request. Please wait for it to be reviewed." },
      { status: 422 }
    );
  }

  let familyGroupId: string;

  if (target.familyGroupId) {
    // Target already has a family group - request to join it
    familyGroupId = target.familyGroupId;
  } else {
    // Create a new family group with the target member
    const newGroup = await prisma.$transaction(async (tx) => {
      const group = await tx.familyGroup.create({
        data: { name: `${target.lastName} Family` },
      });
      await tx.member.update({
        where: { id: target.id },
        data: { familyGroupId: group.id },
      });
      return group;
    });
    familyGroupId = newGroup.id;
  }

  const joinRequest = await prisma.familyGroupJoinRequest.create({
    data: {
      familyGroupId,
      requesterId: session.user.id,
    },
  });

  logAudit({
    action: "FAMILY_GROUP_JOIN_REQUESTED",
    memberId: session.user.id,
    targetId: familyGroupId,
    details: JSON.stringify({ targetEmail, targetMemberId: target.id }),
  });

  logger.info(
    { requestId: joinRequest.id, requesterId: session.user.id, familyGroupId },
    "Family group join request created"
  );

  return NextResponse.json(
    {
      message: "Join request submitted. An admin will review your request.",
      requestId: joinRequest.id,
    },
    { status: 201 }
  );
}
