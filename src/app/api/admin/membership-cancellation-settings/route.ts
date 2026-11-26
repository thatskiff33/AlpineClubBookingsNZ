import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBERSHIP_CANCELLATION_SETTINGS_ID,
  normalizeMembershipCancellationSettings,
} from "@/lib/membership-cancellation-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { membershipCancellationSettingsSchema } from "@/lib/admin-membership-api/config-settings";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBERSHIP_CANCELLATION_SETTINGS_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-config";

/**
 * GET|PUT /api/admin/membership-cancellation-settings. Also the AI app
 * actions `get_membership_cancellation_settings` and
 * `update_membership_cancellation_settings` (ALP-720): a connection is sent
 * the settings, never the stored row with who saved it.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const persisted = await prisma.membershipCancellationSetting.findUnique({
    where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
    include: {
      xeroContactGroups: {
        orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
      },
    },
  });

  return connectionJson(
    request,
    { settings: normalizeMembershipCancellationSettings(persisted), persisted },
    MEMBERSHIP_CANCELLATION_SETTINGS_CONNECTION_SHAPE,
  );
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = membershipCancellationSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const normalized = normalizeMembershipCancellationSettings(parsed.data);
  const before = await prisma.membershipCancellationSetting.findUnique({
    where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
    include: {
      xeroContactGroups: {
        orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
      },
    },
  });

  const record = await prisma.$transaction(async (tx) => {
    await tx.membershipCancellationSetting.upsert({
      where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
      create: {
        id: MEMBERSHIP_CANCELLATION_SETTINGS_ID,
        warningText: normalized.warningText,
        rejoinProcessText: normalized.rejoinProcessText,
        xeroArchiveContactsOnCancellation:
          normalized.xeroArchiveContactsOnCancellation,
        updatedByMemberId: session.user.id,
      },
      update: {
        warningText: normalized.warningText,
        rejoinProcessText: normalized.rejoinProcessText,
        xeroArchiveContactsOnCancellation:
          normalized.xeroArchiveContactsOnCancellation,
        updatedByMemberId: session.user.id,
      },
    });
    await tx.membershipCancellationXeroContactGroup.deleteMany({
      where: { settingId: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
    });
    if (normalized.xeroContactGroups.length > 0) {
      await tx.membershipCancellationXeroContactGroup.createMany({
        data: normalized.xeroContactGroups.map((group) => ({
          settingId: MEMBERSHIP_CANCELLATION_SETTINGS_ID,
          groupId: group.groupId,
          groupName: group.groupName,
        })),
        skipDuplicates: true,
      });
    }

    return tx.membershipCancellationSetting.findUniqueOrThrow({
      where: { id: MEMBERSHIP_CANCELLATION_SETTINGS_ID },
      include: {
        xeroContactGroups: {
          orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        },
      },
    });
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "MEMBERSHIP_CANCELLATION_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "MembershipCancellationSetting",
        id: MEMBERSHIP_CANCELLATION_SETTINGS_ID,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Membership cancellation settings updated",
      metadata: {
        previousSettings: before,
        newSettings: normalizeMembershipCancellationSettings(record),
      },
      request: getAuditRequestContext(request),
    }),
  );

  return connectionJson(
    request,
    { settings: normalizeMembershipCancellationSettings(record), persisted: record },
    MEMBERSHIP_CANCELLATION_SETTINGS_CONNECTION_SHAPE,
  );
}
