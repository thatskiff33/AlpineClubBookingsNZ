import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmailChangeVerification, sendEmailChangeNotification } from "@/lib/email";
import { createEmailChangeToken } from "@/lib/verification-tokens";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";

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

    // Check if new email is already taken
    const existing = await prisma.member.findUnique({
      where: { email: newEmail },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json({ error: "This email is already in use" }, { status: 409 });
    }

    const token = await createEmailChangeToken(member.id, newEmail);

    // Send verification to new email and notification to old email
    await Promise.all([
      sendEmailChangeVerification(newEmail, token),
      sendEmailChangeNotification(member.email, newEmail),
    ]);

    logAudit({
      action: "EMAIL_CHANGE_REQUESTED",
      memberId: member.id,
      details: JSON.stringify({ newEmail }),
      ipAddress: getClientIp(request),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Error requesting email change");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
