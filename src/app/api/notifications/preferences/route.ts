import { NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { arrivesAsMcpConnection, connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import {
  MEMBER_NOTIFICATION_PREFERENCE_KEYS,
  memberNotificationPreferencesConnectionUpdateSchema,
  memberNotificationPreferencesUpdateSchema,
  resolveMemberNotificationPreferences,
} from "@/lib/member-notification-preferences";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // A read never writes (ALP-801): with no saved row the member reads the
  // defaults, and only the PUT creates one. Creating it here let two first
  // reads race on the unique `memberId` and answer 500.
  const prefs = await prisma.notificationPreference.findUnique({
    where: { memberId: session.user.id },
  });

  return connectionJson(
    request,
    resolveMemberNotificationPreferences(prefs),
    MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
  );
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const schema = arrivesAsMcpConnection(request)
    ? memberNotificationPreferencesConnectionUpdateSchema
    : memberNotificationPreferencesUpdateSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = await prisma.notificationPreference.findUnique({
    where: { memberId: session.user.id },
  });
  const before = resolveMemberNotificationPreferences(existing);
  const after = resolveMemberNotificationPreferences({
    ...before,
    ...parsed.data,
  });
  const changes = MEMBER_NOTIFICATION_PREFERENCE_KEYS.filter(
    (key) => parsed.data[key] !== undefined && before[key] !== after[key]
  ).map((key) => ({
    key,
    before: before[key],
    after: after[key],
  }));

  const [prefs] = await prisma.$transaction([
    prisma.notificationPreference.upsert({
      where: { memberId: session.user.id },
      create: {
        memberId: session.user.id,
        ...parsed.data,
      },
      update: parsed.data,
    }),
    prisma.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "member.notification_preferences.updated",
        actor: { memberId: session.user.id },
        subject: { memberId: session.user.id },
        entity: { type: "NotificationPreference", id: session.user.id },
        category: "account",
        severity: "important",
        outcome: "success",
        summary: "Notification preferences updated",
        metadata: {
          changedPreferenceKeys: changes.map((change) => change.key),
          changes,
        },
        request: getAuditRequestContext(request),
      })
    ),
  ]);

  return connectionJson(
    request,
    resolveMemberNotificationPreferences(prefs),
    MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
  );
}
