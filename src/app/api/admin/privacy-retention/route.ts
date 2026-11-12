import { NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { getPrivacyRetentionPreview } from "@/lib/privacy-retention";
import {
  getPrivacyRetentionSettings, savePrivacyRetentionSettings,
} from "@/lib/privacy-retention-settings";
import { BOOKING_RETENTION_FIELDS, MEMBERSHIP_RETENTION_FIELDS, privacyRetentionSettingsSchema, type PrivacyRetentionSettingsValues } from "@/lib/privacy-retention-shared";
import { requireAdmin } from "@/lib/session-guards";

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const params = new URL(request.url).searchParams;
  const page = Number(params.get("page") ?? 1);
  const memberAfter = params.get("memberAfter") ?? undefined;
  if (memberAfter !== undefined && (memberAfter.length === 0 || memberAfter.length > 200)) {
    return NextResponse.json({ error: "Invalid member cursor." }, { status: 400 });
  }
  if (!Number.isSafeInteger(page) || page < 1) {
    return NextResponse.json({ error: "Page must be a positive whole number." }, { status: 400 });
  }
  const canViewMembership = hasAdminAreaAccess(guard.session.user, {
    area: "membership", level: "view",
  });
  const pageSize = 25;
  const { settings, ...preview } = await getPrivacyRetentionPreview({
    page, pageSize, memberAfter, includeMembers: canViewMembership,
  });
  return NextResponse.json({
    settings,
    clearedBookingDietary: preview.clearedBookingDietary,
    preview: {
      emailLogs: preview.emailLogs,
      ...(canViewMembership ? {
        rejectedApplications: preview.rejectedApplications,
        formerMembers: preview.formerMembers,
        blockedMembers: preview.blockedMembers,
        undatedMembers: preview.undatedMembers,
      } : {}),
    },
    ...(canViewMembership ? {
      formerMemberCandidateCount: preview.formerMemberCandidateCount,
      memberHasMore: preview.memberHasMore,
      memberNextCursor: preview.memberNextCursor,
    } : {}),
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
  let current: PrivacyRetentionSettingsValues | undefined;
  for (const [area, fields, error] of [
    ["membership", MEMBERSHIP_RETENTION_FIELDS, "Membership edit access is required to change member or application retention."],
    ["bookings", BOOKING_RETENTION_FIELDS, "Bookings edit access is required to change stay dietary retention."],
  ] as const) {
    if (hasAdminAreaAccess(guard.session.user, { area, level: "edit" })) continue;
    const saved = current ??= await getPrivacyRetentionSettings();
    if ([...fields].some(field => parsed.data[field] !== saved[field])) {
      return NextResponse.json({ error }, { status: 403 });
    }
  }
  const settings = await savePrivacyRetentionSettings(parsed.data, guard.session.user.id);
  return NextResponse.json({ settings });
}
