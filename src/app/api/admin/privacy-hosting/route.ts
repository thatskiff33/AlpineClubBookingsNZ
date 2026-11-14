import { NextResponse } from "next/server";
import { buildStructuredAuditLogCreateArgs, getAuditRequestContext } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { privacyHostingSchema, PRIVACY_HOSTING_DEFAULTS, PRIVACY_HOSTING_TEXT_REFUSAL } from "@/lib/privacy-hosting";
import { getPrivacyHostingSettings, PRIVACY_HOSTING_SELECT } from "@/lib/privacy-hosting-settings";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "content", level: "view" } });
  if (!guard.ok) return guard.response;
  return NextResponse.json({ settings: await getPrivacyHostingSettings() });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: { area: "content", level: "edit" } });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = privacyHostingSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: `${PRIVACY_HOSTING_TEXT_REFUSAL} in each field.` }, { status: 400 });
  const settings = await prisma.$transaction(async tx => {
    const before = await tx.privacyHostingSettings.findUnique({ where: { id: "default" }, select: PRIVACY_HOSTING_SELECT });
    const saved = await tx.privacyHostingSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...parsed.data, updatedByMemberId: guard.session.user.id },
      update: { ...parsed.data, updatedByMemberId: guard.session.user.id },
      select: PRIVACY_HOSTING_SELECT,
    });
    await tx.auditLog.create(buildStructuredAuditLogCreateArgs({
      action: "PRIVACY_HOSTING_SETTINGS_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: { type: "PrivacyHostingSettings", id: "default" },
      category: "admin", severity: "important", outcome: "success",
      summary: "Privacy hosting disclosure updated",
      metadata: { before: before ?? PRIVACY_HOSTING_DEFAULTS, after: parsed.data },
      request: getAuditRequestContext(request),
    }));
    return saved;
  });
  revalidatePublicPageContent();
  return NextResponse.json({ settings });
}
