import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { hashActionToken, isActionTokenFormat } from "@/lib/action-tokens";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { loadLoginSecuritySettings } from "@/lib/login-security-settings";
import { buildPasswordSchema } from "@/lib/password-policy";
import { clearPasswordAttempts } from "@/lib/login-throttle";

// The password field is validated against the club's configured login-security
// policy (min length + optional character classes; hard 128 ceiling always).
// With no configured row this is byte-identical to the historical
// min(12).max(128). Built per-request from the loaded policy.
const tokenSchema = z
  .string()
  .trim()
  .refine(isActionTokenFormat, "Reset token is invalid");

export async function POST(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.resetPassword, req);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  try {
    const { policy } = await loadLoginSecuritySettings();
    const resetPasswordSchema = z.object({
      token: tokenSchema,
      password: buildPasswordSchema(policy),
    });
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

    // #4609 (owner decision): a completed reset proves the mailbox, so the
    // account's sign-in throttle starts again from zero. Never throws.
    await clearPasswordAttempts(resetToken.member.email);

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Unexpected error in reset-password");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
