import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  LOGIN_SECURITY_SETTINGS_ID,
  loadLoginSecuritySettings,
} from "@/lib/login-security-settings";
import {
  MAGIC_LINK_TTL_MAX_MINUTES,
  MAGIC_LINK_TTL_MIN_MINUTES,
} from "@/lib/magic-link";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { requireRecentAuth } from "@/lib/require-recent-auth";

// Admin API for the magic-link sign-in expiry (epic #2030, child #2103). The
// Login & Security page's magic-link card writes PUT to persist
// `magicLinkTtlMinutes` on the shared LoginSecuritySetting singleton; the
// sign-in issuance route reads it back (re-clamped) at
// src/app/api/auth/magic-link/route.ts. The password-policy route deliberately
// never touches this column — this endpoint owns it.
//
// The guard names the area explicitly — support:edit to write — rather than
// relying on path inference: inference needs the middleware-set request-path
// header, and when that header is absent the fallback is full-ADMIN, which
// would silently exclude support-area admins. Matches
// /api/admin/security/password-policy and /api/admin/modules. Every write is
// audited under the `security` category (mirroring the password-policy route).

const AREA = "support" as const;

const ttlInputSchema = z
  .object({
    magicLinkTtlMinutes: z
      .number()
      .int()
      .min(MAGIC_LINK_TTL_MIN_MINUTES)
      .max(MAGIC_LINK_TTL_MAX_MINUTES),
  })
  .strict();

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: { area: AREA, level: "edit" } });
  if (!guard.ok) return guard.response;

  let body: unknown;
  const recent = await requireRecentAuth();
  if (!recent.ok) return recent.response;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ttlInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { magicLinkTtlMinutes } = parsed.data;
  const memberId = guard.session.user.id;

  await prisma.$transaction(async (tx) => {
    const before = await tx.loginSecuritySetting.findUnique({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      select: { magicLinkTtlMinutes: true },
    });
    await tx.loginSecuritySetting.upsert({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      update: { magicLinkTtlMinutes, updatedByMemberId: memberId },
      create: {
        id: LOGIN_SECURITY_SETTINGS_ID,
        magicLinkTtlMinutes,
        updatedByMemberId: memberId,
      },
    });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "LOGIN_SECURITY_MAGIC_LINK_TTL_UPDATED",
        actor: { memberId },
        entity: { type: "LoginSecuritySetting", id: LOGIN_SECURITY_SETTINGS_ID },
        category: "security",
        severity: "important",
        outcome: "success",
        summary: "Login & Security magic-link expiry updated",
        metadata: {
          before: { magicLinkTtlMinutes: before?.magicLinkTtlMinutes ?? null },
          after: { magicLinkTtlMinutes },
        },
        request: getAuditRequestContext(request),
      }),
    );
  });

  return NextResponse.json(await loadLoginSecuritySettings());
}
