import { NextResponse } from "next/server";
import { z } from "zod";

import { isFullAdmin } from "@/lib/access-roles";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  LOGIN_SECURITY_SETTINGS_ID,
  loadLoginSecurityRefresh,
} from "@/lib/login-security-settings";
import { OFFICER_SIGN_IN_RELEASE_ENABLED } from "@/lib/officer-sign-in-release";
import {
  OFFICER_TWO_FACTOR_GRACE_MAX_DAYS,
  OFFICER_TWO_FACTOR_GRACE_MIN_DAYS,
} from "@/lib/officer-two-factor-grace";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const AREA = "support" as const;

const bodySchema = z
  .object({
    officerTwoFactorPolicy: z.boolean(),
    officerTwoFactorGraceDays: z
      .number()
      .int()
      .min(OFFICER_TWO_FACTOR_GRACE_MIN_DAYS)
      .max(OFFICER_TWO_FACTOR_GRACE_MAX_DAYS),
  })
  .strict();

function hidden() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET() {
  if (!OFFICER_SIGN_IN_RELEASE_ENABLED) return hidden();
  const guard = await requireAdmin({ permission: { area: AREA, level: "view" } });
  if (!guard.ok) return guard.response;
  const policy = await loadLoginSecurityRefresh();
  return NextResponse.json({
    officerTwoFactorPolicy: policy.officerTwoFactorPolicy,
    officerTwoFactorGraceDays: policy.officerTwoFactorGraceDays,
  });
}

export async function PUT(request: Request) {
  if (!OFFICER_SIGN_IN_RELEASE_ENABLED) return hidden();
  const guard = await requireAdmin({ permission: { area: AREA, level: "edit" } });
  if (!guard.ok) return guard.response;
  if (!isFullAdmin(guard.session.user)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const memberId = guard.session.user.id;
  const data = parsed.data;
  await prisma.$transaction(async (tx) => {
    const before = await tx.loginSecuritySetting.findUnique({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      select: {
        officerTwoFactorPolicy: true,
        officerTwoFactorGraceDays: true,
      },
    });
    await tx.loginSecuritySetting.upsert({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      update: { ...data, updatedByMemberId: memberId },
      create: {
        id: LOGIN_SECURITY_SETTINGS_ID,
        ...data,
        updatedByMemberId: memberId,
      },
    });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "LOGIN_SECURITY_OFFICER_TWO_FACTOR_UPDATED",
        actor: { memberId },
        entity: { type: "LoginSecuritySetting", id: LOGIN_SECURITY_SETTINGS_ID },
        category: "security",
        severity: "important",
        outcome: "success",
        summary: "Officer two-factor policy updated",
        metadata: { before, after: data },
        request: getAuditRequestContext(request),
      }),
    );
  });

  return NextResponse.json(data);
}
