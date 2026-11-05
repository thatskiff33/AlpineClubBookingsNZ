import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { PASSWORD_BCRYPT_COST } from "@/lib/password-hashing";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { loadLoginSecuritySettings } from "@/lib/login-security-settings";
import { buildPasswordSchema } from "@/lib/password-policy";
import { breachedPasswordRefusal, screenChosenPassword } from "@/lib/breached-password";
import { claimPasswordAttempt, clearPasswordAttempts } from "@/lib/login-throttle";
import { LOGIN_THROTTLED_CODE } from "@/lib/login-throttle-policy";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id, {
    allowForcePasswordChange: true,
  });
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const body = await req.json();
  // Validate the new password against the club's configured login-security
  // policy (min length + optional character classes; hard 128 ceiling always).
  // No configured row is byte-identical to the historical min(12).max(128).
  const { policy } = await loadLoginSecuritySettings();
  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: buildPasswordSchema(policy),
  });
  const parsed = changePasswordSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const { currentPassword, newPassword } = parsed.data;

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { email: true, passwordHash: true, forcePasswordChange: true },
  });

  if (!member) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Use the stored email, not session or request input, so sign-in and this
  // password check share one account budget (INV-AUTH-003).
  if (!(await claimPasswordAttempt(member.email)).allowed) {
    return NextResponse.json(
      {
        error: "Too many password attempts. Please wait a few minutes and try again.",
        code: LOGIN_THROTTLED_CODE,
      },
      { status: 429 }
    );
  }

  const isValid = await bcrypt.compare(currentPassword, member.passwordHash);
  if (!isValid) {
    return NextResponse.json(
      { error: "Current password is incorrect" },
      { status: 400 }
    );
  }
  await clearPasswordAttempts(member.email);

  // #4610 (INV-AUTH-005): refuse a password on the public breach list. Only a
  // 5-character hash prefix leaves the server; a slow or failed lookup accepts.
  const screen = await screenChosenPassword(newPassword, policy);
  if (!screen.ok) return breachedPasswordRefusal(screen);

  const newHash = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_COST);

  await prisma.$transaction([
    prisma.member.update({
      where: { id: session.user.id },
      data: {
        passwordHash: newHash,
        forcePasswordChange: false,
        passwordChangedAt: new Date(),
      },
    }),
    prisma.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "member.password.changed",
        actor: { memberId: session.user.id },
        subject: { memberId: session.user.id },
        entity: { type: "Member", id: session.user.id },
        category: "security",
        severity: "critical",
        outcome: "success",
        summary: "Password changed",
        metadata: {
          method: "authenticated_change",
          forcePasswordChangeCleared: member.forcePasswordChange,
        },
        request: getAuditRequestContext(req),
      })
    ),
  ]);

  return NextResponse.json({ success: true });
}
