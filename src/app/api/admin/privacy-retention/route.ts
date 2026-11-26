import { NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { privacyRetentionPreviewQuerySchema } from "@/lib/admin-support-api/system";
import {
  PRIVACY_RETENTION_CONNECTION_SHAPE,
  PRIVACY_RETENTION_SAVED_CONNECTION_SHAPE,
  type PrivacyRetentionAnswer,
} from "@/lib/connection-shapes/support-system";
import { connectionJson } from "@/lib/mcp-connection-request";
import { parseJsonRequestBody } from "@/lib/api-json";
import { getPrivacyRetentionPreview } from "@/lib/privacy-retention";
import {
  getPrivacyRetentionSettings, savePrivacyRetentionSettings,
} from "@/lib/privacy-retention-settings";
import { BOOKING_RETENTION_FIELDS, MEMBERSHIP_RETENTION_FIELDS, privacyRetentionSettingsSchema, type PrivacyRetentionSettingsValues } from "@/lib/privacy-retention-shared";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import { requireAdmin } from "@/lib/session-guards";

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  // The query schema lives in admin-support-api/system.ts, which the AI app
  // action `get_privacy_retention` offers too (ALP-724).
  const params = new URL(request.url).searchParams;
  const query = privacyRetentionPreviewQuerySchema.safeParse({
    page: params.get("page") ?? undefined,
    memberAfter: params.get("memberAfter") ?? undefined,
  });
  if (!query.success) {
    const pageInvalid = query.error.issues.some((issue) => issue.path[0] === "page");
    return NextResponse.json(
      { error: pageInvalid ? "Page must be a positive whole number." : "Invalid member cursor." },
      { status: 400 },
    );
  }
  const page = query.data.page ?? 1;
  const memberAfter = query.data.memberAfter;
  const canViewMembership = hasAdminAreaAccess(guard.session.user, {
    area: "membership", level: "view",
  });
  const pageSize = 25;
  const { settings, ...preview } = await getPrivacyRetentionPreview({
    page, pageSize, memberAfter, includeMembers: canViewMembership,
  });
  const answer: PrivacyRetentionAnswer = {
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
  };
  return connectionJson(request, answer, PRIVACY_RETENTION_CONNECTION_SHAPE);
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;
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
  // #4914: stored CMS pages render {{email-log-retention}} from these settings.
  revalidatePublicSite();
  return connectionJson(request, { settings }, PRIVACY_RETENTION_SAVED_CONNECTION_SHAPE);
}
