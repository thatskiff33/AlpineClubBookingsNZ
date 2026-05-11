import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendChildRequestSubmittedEmail, sendAdminFamilyGroupRequestAlert } from "@/lib/email";
import { nameField } from "@/lib/zod-helpers";

const requestChildSchema = z.object({
  familyGroupId: z.string().min(1, "Family group ID required"),
  firstName: nameField({ required: "First name required" }),
  lastName: nameField({ required: "Last name required" }),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD format").optional(),
});

/**
 * POST /api/members/family/request-child
 * Parent requests adding a child/youth to their family group.
 * Goes to admin queue for approval — admin must link to existing member.
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

  const parsed = requestChildSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { familyGroupId, firstName, lastName, dateOfBirth } = parsed.data;

  // Verify requester is an active adult member in the specified group
  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true, firstName: true, lastName: true, active: true, ageTier: true,
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
    return NextResponse.json({ error: "Only adults can request to add children or youth" }, { status: 403 });
  }

  if (requester.familyGroupMemberships.length === 0) {
    return NextResponse.json({ error: "You are not a member of this family group" }, { status: 403 });
  }

  // Check for duplicate pending request with same child details
  const existingRequest = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      familyGroupId,
      requesterId: session.user.id,
      type: "CHILD_REQUEST",
      status: "PENDING",
      childFirstName: firstName.trim(),
      childLastName: lastName.trim(),
    },
  });

  if (existingRequest) {
    return NextResponse.json({ error: "A request for this child is already pending review" }, { status: 422 });
  }

  const childDob = dateOfBirth ? new Date(dateOfBirth) : null;

  const request = await prisma.familyGroupJoinRequest.create({
    data: {
      familyGroupId,
      requesterId: session.user.id,
      type: "CHILD_REQUEST",
      childFirstName: firstName.trim(),
      childLastName: lastName.trim(),
      childDateOfBirth: childDob,
    },
  });

  logAudit({
    action: "FAMILY_GROUP_CHILD_REQUEST",
    memberId: session.user.id,
    targetId: familyGroupId,
    subjectMemberId: session.user.id,
    entityType: "FamilyGroupJoinRequest",
    entityId: request.id,
    category: "family",
    outcome: "success",
    summary: "Child family group request submitted",
    details: JSON.stringify({ childName: `${firstName} ${lastName}`, dateOfBirth }),
    metadata: {
      familyGroupId,
      childName: `${firstName} ${lastName}`,
      dateOfBirth: dateOfBirth ?? null,
    },
  });

  logger.info(
    { requestId: request.id, requesterId: session.user.id, familyGroupId, childName: `${firstName} ${lastName}` },
    "Child/youth family group request submitted"
  );

  // Send confirmation email to parent (fire-and-forget)
  const groupInfo = await prisma.familyGroup.findUnique({
    where: { id: familyGroupId },
    select: { name: true },
  });
  const parentEmail = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (parentEmail) {
    sendChildRequestSubmittedEmail(
      parentEmail.email,
      requester.firstName,
      `${firstName} ${lastName}`,
      groupInfo?.name ?? "your family group"
    ).catch((err) => {
      logger.error({ err, requestId: request.id }, "Failed to send child request confirmation email");
    });
  }

  // Send admin alert (fire-and-forget)
  sendAdminFamilyGroupRequestAlert({
    requestType: "Child/Youth Request",
    requesterName: `${requester.firstName} ${requester.lastName}`,
    groupName: groupInfo?.name ?? "Unnamed Group",
    details: `Wants to add ${firstName} ${lastName}${dateOfBirth ? ` (DOB: ${dateOfBirth})` : ""}`,
  }).catch((err) => {
    logger.error({ err, requestId: request.id }, "Failed to send admin family group request alert");
  });

  return NextResponse.json(
    {
      message: "Request submitted. An admin will review and link the child/youth member to your family group.",
      requestId: request.id,
    },
    { status: 201 }
  );
}
