import { NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { getPrivacyRetentionPreview } from "@/lib/privacy-retention";
import {
  getPrivacyRetentionSettings,
  savePrivacyRetentionSettings,
} from "@/lib/privacy-retention-settings";
import { privacyRetentionSettingsSchema } from "@/lib/privacy-retention-shared";
import { requireAdmin } from "@/lib/session-guards";

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
  if (!Number.isSafeInteger(page) || page < 1) {
    return NextResponse.json({ error: "Page must be a positive whole number." }, { status: 400 });
  }
  const canViewMembership = hasAdminAreaAccess(guard.session.user, {
    area: "membership", level: "view",
  });
  const pageSize = 25;
  const [settings, preview] = await Promise.all([
    getPrivacyRetentionSettings(),
    getPrivacyRetentionPreview({ page, pageSize, includeMembers: canViewMembership }),
  ]);
  return NextResponse.json({
    settings,
    preview: {
      emailLogs: preview.emailLogs,
      ...(canViewMembership ? {
        rejectedApplications: preview.rejectedApplications,
        formerMembers: preview.formerMembers,
        blockedMembers: preview.blockedMembers,
        undatedMembers: preview.undatedMembers,
      } : {}),
    },
    page,
    pageSize,
    canViewMembership,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = privacyRetentionSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid retention settings", details: parsed.error.flatten() }, { status: 400 });
  }
  const settings = await savePrivacyRetentionSettings(parsed.data, guard.session.user.id);
  return NextResponse.json({ settings });
}
