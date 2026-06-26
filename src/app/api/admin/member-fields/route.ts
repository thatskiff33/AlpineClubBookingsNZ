import { NextResponse } from "next/server";
import { z } from "zod";
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
  type MemberFieldKey,
  type MemberFieldsSettingsValues,
} from "@/config/member-fields";
import { prisma } from "@/lib/prisma";

const fieldSettingsSchema = z
  .object(
    Object.fromEntries(
      MEMBER_FIELD_KEYS.map((key) => [key, z.boolean()]),
    ) as Record<MemberFieldKey, z.ZodBoolean>,
  )
  .strict();

const updateSchema = z
  .object({
    settings: fieldSettingsSchema,
  })
  .strict();

function getChanges(
  before: MemberFieldsSettingsValues,
  after: MemberFieldsSettingsValues,
) {
  return MEMBER_FIELD_KEYS.filter((key) => before[key] !== after[key]).map(
    (key) => ({ key, previous: before[key], next: after[key] }),
  );
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json(await loadMemberFieldsSettings());
}

export async function PUT(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
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

  return NextResponse.json(buildMemberFieldsSettingsPayload(record));
}
