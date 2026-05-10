import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(12, "Password must be at least 12 characters").max(128, "Password must be at most 128 characters"),
});

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
    select: { passwordHash: true, forcePasswordChange: true },
  });

  if (!member) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const isValid = await bcrypt.compare(currentPassword, member.passwordHash);
  if (!isValid) {
    return NextResponse.json(
      { error: "Current password is incorrect" },
      { status: 400 }
    );
  }

  const newHash = await bcrypt.hash(newPassword, 13);

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
