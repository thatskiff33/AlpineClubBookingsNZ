import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { getSeasonYear } from "@/lib/utils";
import { parseDateOnly } from "@/lib/date-only";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendAdminFamilyGroupRequestAlert } from "@/lib/email";
import { nameField } from "@/lib/zod-helpers";

const requestAdultSchema = z.object({
  familyGroupId: z.string().min(1, "Family group ID required"),
  firstName: nameField({ required: "First name required" }),
  lastName: nameField({ required: "Last name required" }),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD format"),
  notes: z.string().max(500).optional(),
});

/**
 * POST /api/members/family/request-adult
 * Request admin approval to add a same-email non-login adult to a family group.
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

  const parsed = requestAdultSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const firstName = parsed.data.firstName.trim();
  const lastName = parsed.data.lastName.trim();
  const notes = parsed.data.notes?.trim() || null;
  const dateOfBirth = parseDateOnly(parsed.data.dateOfBirth);
  if (Number.isNaN(dateOfBirth.getTime())) {
    return NextResponse.json({ error: "Invalid date of birth" }, { status: 422 });
  }
  if (dateOfBirth > new Date()) {
    return NextResponse.json(
      { error: "Date of birth cannot be in the future" },
      { status: 422 }
    );
  }

  const ageTier = await computeAgeTier(dateOfBirth, getSeasonStartDate(getSeasonYear()));
  if (ageTier !== "ADULT") {
    return NextResponse.json(
      { error: "Use the infant/child/youth request flow for members under 18" },
      { status: 422 }
    );
  }

  const requester = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
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
      { error: "Only adult members with login accounts can request same-email adult additions" },
      { status: 403 }
    );
  }
  if (requester.familyGroupMemberships.length === 0) {
    return NextResponse.json(
      { error: "You are not a member of this family group" },
      { status: 403 }
    );
  }

  const existingRequest = await prisma.familyGroupJoinRequest.findFirst({
    where: {
      familyGroupId: parsed.data.familyGroupId,
      requesterId: requester.id,
      type: "ADULT_REQUEST",
      status: "PENDING",
      requestedFirstName: { equals: firstName, mode: "insensitive" },
      requestedLastName: { equals: lastName, mode: "insensitive" },
      requestedDateOfBirth: dateOfBirth,
    },
  });

  if (existingRequest) {
    return NextResponse.json(
      { error: "A request for this adult is already pending review" },
      { status: 422 }
    );
  }

  const request = await prisma.familyGroupJoinRequest.create({
    data: {
      familyGroupId: parsed.data.familyGroupId,
      requesterId: requester.id,
      type: "ADULT_REQUEST",
      requestedFirstName: firstName,
      requestedLastName: lastName,
      requestedDateOfBirth: dateOfBirth,
      requestedEmail: requester.email.toLowerCase().trim(),
      requestNotes: notes,
    },
  });

  logAudit({
    action: "FAMILY_GROUP_ADULT_REQUEST",
    memberId: requester.id,
    targetId: parsed.data.familyGroupId,
    subjectMemberId: requester.id,
    entityType: "FamilyGroupJoinRequest",
    entityId: request.id,
    category: "family",
    outcome: "success",
    summary: "Adult family group request submitted",
    details: JSON.stringify({
      requestId: request.id,
      requestedName: `${firstName} ${lastName}`,
      requestedDateOfBirth: parsed.data.dateOfBirth,
    }),
    metadata: {
      familyGroupId: parsed.data.familyGroupId,
      requestedName: `${firstName} ${lastName}`,
      requestedDateOfBirth: parsed.data.dateOfBirth,
    },
  });

  const groupInfo = await prisma.familyGroup.findUnique({
    where: { id: parsed.data.familyGroupId },
    select: { name: true },
  });

  sendAdminFamilyGroupRequestAlert({
    requestType: "Same-email Adult Request",
    requesterName: `${requester.firstName} ${requester.lastName}`,
    groupName: groupInfo?.name ?? "Unnamed Group",
    details: `Wants to add ${firstName} ${lastName} as a non-login adult sharing ${requester.email}`,
  }).catch((err) => {
    logger.error({ err, requestId: request.id }, "Failed to send admin adult-request alert");
  });

  logger.info(
    { requestId: request.id, requesterId: requester.id, familyGroupId: parsed.data.familyGroupId },
    "Same-email adult family group request submitted"
  );

  return NextResponse.json(
    {
      message: "Request submitted. An admin will review the adult addition.",
      requestId: request.id,
    },
    { status: 201 }
  );
}
