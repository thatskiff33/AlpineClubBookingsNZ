import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  ADMIN_NOTIFICATION_PREFERENCE_KEYS,
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  resolveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";

const preferenceUpdateSchema = z
  .object({
    adminNewBooking: z.boolean().optional(),
    adminPaymentFailure: z.boolean().optional(),
    adminPendingDeadline: z.boolean().optional(),
    adminBookingBumped: z.boolean().optional(),
    adminXeroSyncError: z.boolean().optional(),
    adminCapacityWarning: z.boolean().optional(),
    adminDailyDigest: z.boolean().optional(),
    adminWaitlistOffer: z.boolean().optional(),
    adminFamilyGroupRequest: z.boolean().optional(),
    adminBookingChangeRequest: z.boolean().optional(),
    adminRefundRequest: z.boolean().optional(),
    adminIssueReport: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    "At least one preference update is required"
  );

const updateSchema = z.object({
  memberId: z.string().min(1),
  preferences: preferenceUpdateSchema,
});

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
      { status: 400 }
    );
  }

  const targetMember = await prisma.member.findUnique({
    where: { id: parsed.data.memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      role: true,
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  if (!targetMember) {
    return NextResponse.json({ error: "Admin user not found" }, { status: 404 });
  }
  if (targetMember.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Notification preferences can only be managed for admin users" },
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

  return NextResponse.json({
    memberId: targetMember.id,
    preferences: resolveAdminNotificationPreferences(updated),
  });
}
