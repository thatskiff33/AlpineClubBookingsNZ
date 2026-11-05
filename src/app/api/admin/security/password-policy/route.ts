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
  MIN_PASSWORD_LENGTH_CEILING,
  MIN_PASSWORD_LENGTH_FLOOR,
} from "@/lib/password-policy";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  SESSION_MAX_AGE_MAX_HOURS,
  SESSION_MAX_AGE_MIN_HOURS,
} from "@/lib/session-max-age";

// Admin API for the club password-complexity policy (epic #2030, child #2033).
// The Login & Security page's password-policy card reads GET and writes PUT.
// Pinned to the `support` admin area (mirroring /api/admin/modules — verified via
// the admin-route-area-matrix pin): support:view to read, support:edit to write.
// Every write is audited under the `security` category. This endpoint governs the
// password rules ONLY; magicLinkTtlMinutes is owned by the sibling magic-link
// route (PUT /api/admin/security/magic-link, wired in #2103) and is deliberately
// not writable here — the strict schema below rejects it.
//
// #4610: the breached-password check switch (INV-AUTH-006) is written here too,
// beside the rules it extends. It is optional in the body so a page loaded
// before the upgrade (which never sends it) still saves and leaves it as it was.
//
// #4611: so is the maximum session age in hours (INV-AUTH-007), on the same
// terms: optional for an older page, and a whole number from 8 to 720 hours or
// the save is refused with no write.

const AREA = "support" as const;

const policyInputSchema = z
  .object({
    minPasswordLength: z
      .number()
      .int()
      .min(MIN_PASSWORD_LENGTH_FLOOR)
      .max(MIN_PASSWORD_LENGTH_CEILING),
    requireUppercase: z.boolean(),
    requireLowercase: z.boolean(),
    requireDigit: z.boolean(),
    requireSymbol: z.boolean(),
    breachedPasswordCheck: z.boolean().optional(),
    sessionMaxAgeHours: z
      .number()
      .int()
      .min(SESSION_MAX_AGE_MIN_HOURS)
      .max(SESSION_MAX_AGE_MAX_HOURS)
      .optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({ permission: { area: AREA, level: "view" } });
  if (!guard.ok) return guard.response;

  return NextResponse.json(await loadLoginSecuritySettings());
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: { area: AREA, level: "edit" } });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = policyInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const memberId = guard.session.user.id;

  await prisma.$transaction(async (tx) => {
    const before = await tx.loginSecuritySetting.findUnique({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      select: {
        minPasswordLength: true,
        requireUppercase: true,
        requireLowercase: true,
        requireDigit: true,
        requireSymbol: true,
        breachedPasswordCheck: true,
        sessionMaxAgeHours: true,
      },
    });
    await tx.loginSecuritySetting.upsert({
      where: { id: LOGIN_SECURITY_SETTINGS_ID },
      update: { ...data, updatedByMemberId: memberId },
      create: { id: LOGIN_SECURITY_SETTINGS_ID, ...data, updatedByMemberId: memberId },
    });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "LOGIN_SECURITY_PASSWORD_POLICY_UPDATED",
        actor: { memberId },
        entity: { type: "LoginSecuritySetting", id: LOGIN_SECURITY_SETTINGS_ID },
        category: "security",
        severity: "important",
        outcome: "success",
        summary: "Login & Security password policy updated",
        metadata: { before, after: data },
        request: getAuditRequestContext(request),
      }),
    );
  });

  return NextResponse.json(await loadLoginSecuritySettings());
}
