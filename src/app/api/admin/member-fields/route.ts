import { NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  MEMBER_FIELDS_SETTINGS_ID,
  buildMemberFieldsSettingsPayload,
  loadMemberFieldsSettings,
  normalizeMemberFieldsSettings,
} from "@/lib/member-fields-settings";
import {
  MEMBER_FIELD_KEYS,
  type MemberFieldsSettingsValues,
} from "@/config/member-fields";
import { prisma } from "@/lib/prisma";
import { memberFieldsUpdateSchema } from "@/lib/admin-membership-api/config-settings";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_FIELDS_SETTINGS_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-config";

/**
 * GET|PUT /api/admin/member-fields — which optional profile fields the club
 * collects. Also the AI app actions `get_member_field_settings` and
 * `update_member_field_settings` (ALP-720), answered through the shape.
 */

function getChanges(
  before: MemberFieldsSettingsValues,
  after: MemberFieldsSettingsValues,
) {
  return MEMBER_FIELD_KEYS.filter((key) => before[key] !== after[key]).map(
    (key) => ({ key, previous: before[key], next: after[key] }),
  );
}

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return connectionJson(request, await loadMemberFieldsSettings(), MEMBER_FIELDS_SETTINGS_CONNECTION_SHAPE);
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = memberFieldsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.memberFieldsSettings.findUnique({
    where: { id: MEMBER_FIELDS_SETTINGS_ID },
  });
  const before = normalizeMemberFieldsSettings(existing);
  const after = parsed.data.settings;
  const changes = getChanges(before, after);
  const write = prisma.memberFieldsSettings.upsert({
    where: { id: MEMBER_FIELDS_SETTINGS_ID },
    create: {
      id: MEMBER_FIELDS_SETTINGS_ID,
      ...after,
      updatedByMemberId: session.user.id,
    },
    update: {
      ...after,
      updatedByMemberId: session.user.id,
    },
  });

  const record =
    changes.length > 0
      ? (
          await prisma.$transaction([
            write,
            prisma.auditLog.create(
              buildStructuredAuditLogCreateArgs({
                action: "MEMBER_FIELDS_SETTINGS_UPDATED",
                actor: { memberId: session.user.id },
                entity: {
                  type: "MemberFieldsSettings",
                  id: MEMBER_FIELDS_SETTINGS_ID,
                },
                category: "admin",
                severity: "important",
                outcome: "success",
                summary: "Optional member field settings updated",
                metadata: {
                  changedKeys: changes.map((change) => change.key),
                  changes,
                  previousSettings: before,
                  newSettings: after,
                },
                request: getAuditRequestContext(request),
              }),
            ),
          ])
        )[0]
      : await write;

  return connectionJson(request, buildMemberFieldsSettingsPayload(record), MEMBER_FIELDS_SETTINGS_CONNECTION_SHAPE);
}
