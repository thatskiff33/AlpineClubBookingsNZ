import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { hashActionToken } from "@/lib/action-tokens";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(12, "Password must be at least 12 characters").max(128, "Password must be at most 128 characters"),
});

export async function POST(req: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.resetPassword, req);
  if (rateLimited) return rateLimited;

  try {
    const body = await req.json();
    const parsed = resetPasswordSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { token, password } = parsed.data;

    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashActionToken(token) },
      include: { member: true },
    });

    if (!resetToken) {
      return NextResponse.json(
        { error: "Invalid or expired reset token" },
        { status: 400 }
      );
    }

    if (resetToken.used) {
      return NextResponse.json(
        { error: "This reset link has already been used" },
        { status: 400 }
      );
    }

    if (resetToken.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "This reset link has expired. Please request a new one." },
        { status: 400 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 13);
    const passwordChangedAt = new Date();

    await prisma.$transaction([
      prisma.member.update({
        where: { id: resetToken.memberId },
        data: {
          passwordHash,
          forcePasswordChange: false,
          passwordChangedAt,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true },
      }),
      prisma.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "member.password_reset.completed",
          actor: { memberId: resetToken.memberId },
          subject: { memberId: resetToken.memberId },
          entity: { type: "Member", id: resetToken.memberId },
          category: "security",
          severity: "critical",
          outcome: "success",
          summary: "Password reset completed",
          metadata: {
            method: "reset_token",
          },
          request: getAuditRequestContext(req),
        })
      ),
    ]);

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Unexpected error in reset-password");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
