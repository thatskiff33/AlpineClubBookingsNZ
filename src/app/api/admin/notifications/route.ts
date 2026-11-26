import { NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { adminNotificationPreferencesUpdateSchema } from "@/lib/admin-support-api/messages";
import {
  ADMIN_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
  type AdminNotificationPreferencesAnswer,
} from "@/lib/connection-shapes/support-messages";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  ADMIN_NOTIFICATION_PREFERENCE_META,
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  canReceiveAdminNotification,
  isAdminNotificationRecipient,
  resolveAdminNotificationPreferences,
  resolveEffectiveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";

// The body schema lives in admin-support-api/messages.ts, which the AI app
// action `update_officer_alerts` offers too (ALP-724).

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseJsonRequestBody(request, {
    error: "Invalid JSON",
  });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = adminNotificationPreferencesUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const targetMember = await prisma.member.findUnique({
    where: { id: parsed.data.memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      canLogin: true,
      // Joined definitions so the area checks below resolve definition-backed
      // (custom or club-edited) access roles, not just the enum bundles.
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  if (!targetMember) {
    return NextResponse.json({ error: "Admin user not found" }, { status: 404 });
  }
  // #2548: any admin-portal user may be a recipient — scoped officers and
  // definition-backed custom roles included — not only Full Admins.
  if (!isAdminNotificationRecipient(targetMember)) {
    return NextResponse.json(
      { error: "Notification preferences can only be managed for admin users" },
      { status: 400 }
    );
  }

  // A category outside the target's areas is not offered on the grid and is
  // masked off at send time, so the API refuses one rather than accept a write
  // the UI can never make and the resolver would ignore.
  //
  // To be clear about what this guard does NOT do: it does not stop out-of-area
  // `true`s being STORED. The fifteen `admin*` columns are NOT NULL with a
  // database default of `true` (prisma/schema.prisma), so every member with a
  // NotificationPreference row already stores fifteen `true`s they never chose,
  // and the upsert's create branch below banks more of them — it writes only the
  // submitted keys, so unticking one booking key for a Booking Officer creates
  // their row with the finance and membership keys defaulted to `true`. Those
  // stored values are harmless because resolveEffectiveAdminNotificationPreferences
  // masks by area on every read and every send.
  //
  // The consequence, recorded deliberately (#2548, review finding 4): because a
  // stored `true` is indistinguishable from "never chosen", there is no way to
  // record an EXPLICIT out-of-area choice without a schema change, so an
  // out-of-area alert cannot be enabled for one named person from this grid.
  // Widening someone's alerts means widening their access role. The guide and
  // the release note say so.
  const unavailableKeys = ADMIN_NOTIFICATION_PREFERENCE_KEYS.filter(
    (key) =>
      parsed.data.preferences[key] !== undefined &&
      !canReceiveAdminNotification(targetMember, key)
  );
  if (unavailableKeys.length > 0) {
    return NextResponse.json(
      {
        error: `This admin's role cannot receive: ${unavailableKeys
          .map((key) => ADMIN_NOTIFICATION_PREFERENCE_META[key].label)
          .join(", ")}. Alerts follow edit access to the area that owns them.`,
      },
      { status: 400 }
    );
  }

  const before = resolveAdminNotificationPreferences(
    targetMember.notificationPreference
  );

  const after = resolveAdminNotificationPreferences({
    ...before,
    ...parsed.data.preferences,
  });
  const changes = ADMIN_NOTIFICATION_PREFERENCE_KEYS.filter(
    (key) =>
      parsed.data.preferences[key] !== undefined && before[key] !== after[key]
  ).map((key) => ({
    key,
    before: before[key],
    after: after[key],
  }));

  const [updated] = await prisma.$transaction([
    prisma.notificationPreference.upsert({
      where: { memberId: targetMember.id },
      create: {
        memberId: targetMember.id,
        ...parsed.data.preferences,
      },
      update: parsed.data.preferences,
      select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
    }),
    prisma.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "ADMIN_NOTIFICATION_PREFERENCES_UPDATED",
        actor: { memberId: session.user.id },
        subject: { memberId: targetMember.id },
        entity: { type: "NotificationPreference", id: targetMember.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Admin notification preferences updated",
        metadata: {
          changedPreferenceKeys: changes.map((change) => change.key),
          changes,
        },
        request: getAuditRequestContext(request),
      })
    ),
  ]);

  const answer: AdminNotificationPreferencesAnswer = {
    memberId: targetMember.id,
    // Effective, area-masked values: what this admin will actually be sent,
    // which is what the grid re-renders from (#2548).
    preferences: resolveEffectiveAdminNotificationPreferences(
      targetMember,
      updated
    ),
  };
  return connectionJson(request, answer, ADMIN_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE);
}
