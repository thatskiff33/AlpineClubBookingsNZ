import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateGuestChoreToken } from "@/lib/guest-chore-token";
import logger from "@/lib/logger";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

const guestChoreMutationSchema = z.object({
  assignmentId: z.string().min(1),
  action: z.enum(["complete", "uncomplete"]),
});

/**
 * GET /api/chores/[token]
 * Public endpoint. Validates guest chore token and returns assignments.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.guestChoreToken, req);
  if (rateLimited) {
    return rateLimited;
  }

  const { token } = await params;

  const result = await validateGuestChoreToken(token);
  if (!result) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    date: result.date.toISOString().split("T")[0],
    guest: result.guest,
    assignments: result.assignments,
  });
}

/**
 * PUT /api/chores/[token]
 * Public endpoint. Marks a chore assignment as completed via guest link.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rateLimited = applyRateLimit(rateLimiters.guestChoreToken, req);
  if (rateLimited) {
    return rateLimited;
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { token } = await params;

  const result = await validateGuestChoreToken(token);
  if (!result) {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 404 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = guestChoreMutationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { assignmentId, action } = parsed.data;

  // Verify this assignment belongs to this guest
  const validIds = result.assignments.map((a) => a.id);
  if (!validIds.includes(assignmentId)) {
    return NextResponse.json(
      { error: "Assignment not found for this guest" },
      { status: 403 }
    );
  }

  try {
    if (action === "complete") {
      await prisma.choreAssignment.update({
        where: { id: assignmentId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          completedVia: "GUEST_LINK",
        },
      });
    } else {
      await prisma.choreAssignment.update({
        where: { id: assignmentId },
        data: {
          status: "CONFIRMED",
          completedAt: null,
          completedVia: null,
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error updating chore via guest link");
    return NextResponse.json(
      { error: "Failed to update assignment" },
      { status: 500 }
    );
  }
}
