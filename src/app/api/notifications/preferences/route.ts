import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";

const updateSchema = z.object({
  bookingConfirmation: z.boolean().optional(),
  bookingReminder: z.boolean().optional(),
  bookingBumped: z.boolean().optional(),
  bookingCancelled: z.boolean().optional(),
  choreRoster: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
});

const MEMBER_NOTIFICATION_PREFERENCE_KEYS = [
  "bookingConfirmation",
  "bookingReminder",
  "bookingBumped",
  "bookingCancelled",
  "choreRoster",
  "marketingEmails",
] as const;

type MemberNotificationPreferenceKey =
  (typeof MEMBER_NOTIFICATION_PREFERENCE_KEYS)[number];

type MemberNotificationPreferences = Record<
  MemberNotificationPreferenceKey,
  boolean
>;

function resolveMemberNotificationPreferences(
  preferences?: Partial<MemberNotificationPreferences> | null
): MemberNotificationPreferences {
  return {
    bookingConfirmation: preferences?.bookingConfirmation ?? true,
    bookingReminder: preferences?.bookingReminder ?? true,
    bookingBumped: preferences?.bookingBumped ?? true,
    bookingCancelled: preferences?.bookingCancelled ?? true,
    choreRoster: preferences?.choreRoster ?? true,
    marketingEmails: preferences?.marketingEmails ?? false,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  // Get or create default preferences
  let prefs = await prisma.notificationPreference.findUnique({
    where: { memberId: session.user.id },
  });

  if (!prefs) {
    prefs = await prisma.notificationPreference.create({
      data: { memberId: session.user.id },
    });
  }

  return NextResponse.json({
    bookingConfirmation: prefs.bookingConfirmation,
    bookingReminder: prefs.bookingReminder,
    bookingBumped: prefs.bookingBumped,
    bookingCancelled: prefs.bookingCancelled,
    choreRoster: prefs.choreRoster,
    marketingEmails: prefs.marketingEmails,
  });
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

  let body;
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

  return NextResponse.json({
    bookingConfirmation: prefs.bookingConfirmation,
    bookingReminder: prefs.bookingReminder,
    bookingBumped: prefs.bookingBumped,
    bookingCancelled: prefs.bookingCancelled,
    choreRoster: prefs.choreRoster,
    marketingEmails: prefs.marketingEmails,
  });
}
