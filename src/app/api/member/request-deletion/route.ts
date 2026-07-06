/**
 * F-COMP-04: Account Deletion Request
 * POST /api/member/request-deletion
 *
 * Creates a pending deletion request for the authenticated member.
 * Admins cannot self-delete.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimiters, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { hasAdminAccess } from "@/lib/access-roles";
import { sendAdminAccountDeletionRequestedAlert } from "@/lib/email";
import { memberDisplayName } from "@/lib/member-serialization";

const requestSchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // Admins cannot self-delete
  if (hasAdminAccess(session.user)) {
    return NextResponse.json(
      { error: "Admin accounts cannot be self-deleted. Contact another admin." },
      { status: 403 }
    );
  }

  // Rate limit by member ID
  const rl = await checkRateLimit(rateLimiters.deletionRequest, session.user.id);
  if (!rl.success) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      }
    );
  }

  let body: { reason?: string } = {};
  try {
    const raw = await request.json();
    body = requestSchema.parse(raw);
  } catch {
    // reason is optional, treat parse failure as empty
    body = {};
  }

  try {
    // Check if there's already a PENDING request
    const existing = await prisma.deletionRequest.findFirst({
      where: { memberId: session.user.id, status: "PENDING" },
    });

    if (existing) {
      return NextResponse.json(
        { error: "You already have a pending deletion request." },
        { status: 409 }
      );
    }

    const request_ = await prisma.deletionRequest.create({
      data: {
        memberId: session.user.id,
        reason: body.reason ?? null,
        status: "PENDING",
      },
      include: {
        member: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    logAudit({
      action: "member.deletion_requested",
      memberId: session.user.id,
      targetId: request_.id,
      details: body.reason ? `Reason: ${body.reason}` : "No reason provided",
      ipAddress: getClientIp(request),
    });

    const memberName = memberDisplayName(request_.member);
    sendAdminAccountDeletionRequestedAlert({
      requestId: request_.id,
      memberName,
      memberEmail: request_.member.email,
      reason: body.reason ?? null,
    }).catch((alertErr) =>
      logger.error(
        { err: alertErr, memberId: session.user.id, requestId: request_.id },
        "Failed to send admin account deletion request alert"
      )
    );

    return NextResponse.json({
      message: "Deletion request submitted. An admin will review it shortly.",
      requestId: request_.id,
    });
  } catch (err) {
    logger.error({ err, memberId: session.user.id }, "Failed to create deletion request");
    return NextResponse.json({ error: "Failed to submit deletion request" }, { status: 500 });
  }
}
