import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  EMAIL_MESSAGE_SETTINGS_ID,
  loadEmailMessageSettingsForLodge,
  loadPersistedEmailMessageSettings,
  normalizeEmailMessagePublicUrl,
} from "@/lib/email-message-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    clubName: z.string().trim().min(1).max(200).nullable().optional(),
    bookingsName: z.string().trim().min(1).max(200).nullable().optional(),
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
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const persisted = await loadPersistedEmailMessageSettings();
  return NextResponse.json({
    // Lodge identity in `settings` resolves from the default lodge (Lodge table),
    // not from `persisted`, so the admin preview shows real default-lodge values.
    settings: await loadEmailMessageSettingsForLodge(null),
    persisted,
  });
}

export async function PUT(request: NextRequest) {
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
        previousSettings: before,
        newSettings: parsed.data,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    // Re-resolve from the default lodge so the response reflects real lodge
    // identity, not just the club fields written above.
    settings: await loadEmailMessageSettingsForLodge(null),
    persisted: record,
  });
}
