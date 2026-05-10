import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { sendEmailChangeVerification, sendEmailChangeNotification } from "@/lib/email";
import { EMAIL_CHANGE_TTL_MS } from "@/lib/verification-tokens";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import {
  createStructuredAuditLog,
  getAuditEmailDomain,
  getAuditRequestContext,
} from "@/lib/audit";
import logger from "@/lib/logger";
import { issueActionToken } from "@/lib/action-tokens";

const requestSchema = z.object({
  newEmail: z.string().email("Invalid email address"),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.requestEmailChange, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const newEmail = parsed.data.newEmail.toLowerCase();

    const member = await prisma.member.findUnique({
      where: { id: session.user.id },
      select: { id: true, email: true, firstName: true },
    });

    if (!member) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    if (newEmail === member.email) {
      return NextResponse.json({ error: "New email is the same as your current email" }, { status: 400 });
    }

    // Check if new email is already taken (among login-eligible accounts)
    const existing = await prisma.member.findFirst({
      where: { email: newEmail, canLogin: true },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json({ error: "This email is already in use" }, { status: 409 });
    }

    const { token, tokenHash } = issueActionToken();
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);

    await prisma.$transaction(async (tx) => {
      await tx.emailChangeToken.deleteMany({ where: { memberId: member.id } });
      await tx.emailChangeToken.create({
        data: { memberId: member.id, newEmail, tokenHash, expiresAt },
      });
      await createStructuredAuditLog(
        {
          action: "EMAIL_CHANGE_REQUESTED",
          actor: { memberId: member.id },
          subject: { memberId: member.id },
          entity: { type: "Member", id: member.id },
          category: "security",
          severity: "critical",
          outcome: "success",
          summary: "Email change requested",
          metadata: {
            emailChange: {
              requested: true,
              currentDomain: getAuditEmailDomain(member.email),
              newDomain: getAuditEmailDomain(newEmail),
            },
          },
          request: getAuditRequestContext(request),
        },
        tx
      );
    });

    // Send verification to new email and notification to old email
    await Promise.all([
      sendEmailChangeVerification(newEmail, token),
      sendEmailChangeNotification(member.email, newEmail),
    ]);

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error requesting email change");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
