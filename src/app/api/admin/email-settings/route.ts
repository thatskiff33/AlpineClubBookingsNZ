import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  EMAIL_MESSAGE_SETTINGS_ID,
  loadPersistedEmailMessageSettings,
  normalizeEmailMessagePublicUrl,
  normalizeEmailMessageSettings,
} from "@/lib/email-message-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    clubName: z.string().trim().min(1).max(200).nullable().optional(),
    bookingsName: z.string().trim().min(1).max(200).nullable().optional(),
    lodgeName: z.string().trim().min(1).max(200).nullable().optional(),
    emailFromName: z.string().trim().min(1).max(200).nullable().optional(),
    supportEmail: z.string().trim().email().max(320).nullable().optional(),
    contactEmail: z.string().trim().email().max(320).nullable().optional(),
    publicUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((value) => normalizeEmailMessagePublicUrl(value) !== null, {
        message: "Public URL must use http or https",
      })
      .transform((value) => normalizeEmailMessagePublicUrl(value)!)
      .nullable()
      .optional(),
    lodgeTravelNote: z.string().trim().min(1).max(2000).nullable().optional(),
    doorCode: z
      .string()
      .trim()
      .max(80)
      .transform((value) => value || null)
      .nullable()
      .optional(),
  })
  .strict();

function redactDoorCodeForAudit<T extends Record<string, unknown> | null>(
  settings: T,
): T {
  if (!settings || !("doorCode" in settings)) return settings;
  return {
    ...settings,
    doorCode: settings.doorCode ? "[set]" : null,
  } as T;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const persisted = await loadPersistedEmailMessageSettings();
  return NextResponse.json({
    settings: normalizeEmailMessageSettings(persisted),
    persisted,
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const before = await prisma.emailMessageSetting.findUnique({
    where: { id: EMAIL_MESSAGE_SETTINGS_ID },
  });
  const data = {
    ...parsed.data,
    updatedByMemberId: session.user.id,
  };

  const record = await prisma.emailMessageSetting.upsert({
    where: { id: EMAIL_MESSAGE_SETTINGS_ID },
    create: {
      id: EMAIL_MESSAGE_SETTINGS_ID,
      ...data,
    },
    update: data,
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_MESSAGE_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: { type: "EmailMessageSetting", id: EMAIL_MESSAGE_SETTINGS_ID },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email message settings updated",
      metadata: {
        changedKeys: Object.keys(parsed.data),
        previousSettings: redactDoorCodeForAudit(before),
        newSettings: redactDoorCodeForAudit(parsed.data),
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    settings: normalizeEmailMessageSettings(record),
    persisted: record,
  });
}
