import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { parseDateOnly } from "@/lib/date-only";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { sendChildRequestSubmittedEmail, sendAdminFamilyGroupRequestAlert } from "@/lib/email";
import { nameField } from "@/lib/zod-helpers";

const requestChildSchema = z.object({
  familyGroupId: z.string().min(1, "Family group ID required"),
  firstName: nameField({ required: "First name required" }),
  lastName: nameField({ required: "Last name required" }),
  dateOfBirth: z
    .string({ error: "Date of birth is required" })
    .min(1, "Date of birth is required")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD format"),
});

/**
 * POST /api/members/family/request-child
 * Parent requests adding an infant/child/youth to their family group.
 * Goes to admin queue for approval.
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

  const rateLimited = await applyRateLimit(rateLimiters.familyGroupJoinRequest, req);
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
  const childDob = parseDateOnly(dateOfBirth);
  if (Number.isNaN(childDob.getTime())) {
    return NextResponse.json(
      { error: "Date of birth must be a real calendar date" },
      { status: 422 }
    );
  }
  // CT-4 (#2870): "in the future" means a later CLUB calendar day, taken from
  // the persisted ClubTimeSettings zone and not the container's TZ
  // (INV-CONFIG-002, INV-DATE-019). The date of birth takes no zone at all
  // (INV-DATE-010), and both sides stay UTC-midnight date-only values.
  const today = dateOnlyInstantOf((await clubTime()).today());
  if (childDob > today) {
    return NextResponse.json(
      { error: "Date of birth cannot be in the future" },
      { status: 422 }
    );
  }

  const ageTier = await computeAgeTier(
    childDob,
    getSeasonStartDate(clubSeasonYear(await clubTimeZone())),
  );
  if (ageTier === "ADULT") {
    return NextResponse.json(
      { error: "Use the same-email adult request flow for adult members" },
      { status: 422 }
    );
  }

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
    return NextResponse.json({ error: "Only adults can request to add infants, children, or youth" }, { status: 403 });
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
      childDateOfBirth: childDob,
    },
  });

  if (existingRequest) {
    return NextResponse.json({ error: "A request for this child is already pending review" }, { status: 422 });
  }

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

  // INV-PRIV-011 (#2683): this is a MINOR's full name on an ordinary
  // member-facing self-service route, so it fires on normal use rather than on
  // an error path. The request id identifies the row, and the child's name is on
  // the audit row written just above, where reading it needs the permission.
  logger.info(
    { requestId: request.id, requesterId: session.user.id, familyGroupId },
    "Infant/child/youth family group request submitted"
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
    requestType: "Infant/Child/Youth Request",
    requesterName: `${requester.firstName} ${requester.lastName}`,
    groupName: groupInfo?.name ?? "Unnamed Group",
    details: `Wants to add ${firstName} ${lastName}${dateOfBirth ? ` (DOB: ${dateOfBirth})` : ""}`,
  }).catch((err) => {
    logger.error({ err, requestId: request.id }, "Failed to send admin family group request alert");
  });

  return NextResponse.json(
    {
      message: "Request submitted. An admin will review the infant/child/youth member for your family group.",
      requestId: request.id,
    },
    { status: 201 }
  );
}
