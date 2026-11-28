import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  emailMessageSettingsConnectionUpdateSchema,
  emailMessageSettingsUpdateSchema,
} from "@/lib/admin-support-api/messages";
import { EMAIL_SETTINGS_CONNECTION_SHAPE } from "@/lib/connection-shapes/support-messages";
import {
  arrivesAsMcpConnection,
  connectionJson,
  websiteOnlyForConnection,
} from "@/lib/mcp-connection-request";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  EMAIL_MESSAGE_SETTINGS_ID,
  loadEmailMessageSettingsForLodge,
  loadPersistedEmailMessageSettings,
} from "@/lib/email-message-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// The body schema lives in admin-support-api/messages.ts, which the AI app
// action `update_email_settings` offers too (ALP-724).

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const persisted = await loadPersistedEmailMessageSettings();
  return connectionJson(
    request,
    {
      // Lodge identity in `settings` resolves from the default lodge (Lodge table),
      // not from `persisted`, so the admin preview shows real default-lodge values.
      settings: await loadEmailMessageSettingsForLodge(null),
      persisted,
    },
    EMAIL_SETTINGS_CONNECTION_SHAPE,
  );
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

  // ALP-724: every email's links, sign-in and password-reset links among them,
  // point at `publicUrl` (`applyEmailMessageSettingsToHtml`). That is
  // `sign-in-access`, so an AI app connection may not set it, even to null.
  const viaConnection = arrivesAsMcpConnection(request);
  if (viaConnection && typeof body === "object" && body !== null && "publicUrl" in body) {
    return websiteOnlyForConnection(
      "The public address that every email's links, sign-in and password-reset links among them, point to is changed on the club website.",
    );
  }
  const parsed = viaConnection
    ? emailMessageSettingsConnectionUpdateSchema.safeParse(body)
    : emailMessageSettingsUpdateSchema.safeParse(body);
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

  return connectionJson(
    request,
    {
      // Re-resolve from the default lodge so the response reflects real lodge
      // identity, not just the club fields written above.
      settings: await loadEmailMessageSettingsForLodge(null),
      persisted: record,
    },
    EMAIL_SETTINGS_CONNECTION_SHAPE,
  );
}
