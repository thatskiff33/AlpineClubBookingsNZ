import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { notificationDeliveryPolicyUpdateSchema } from "@/lib/admin-support-api/messages";
import {
  NOTIFICATION_DELIVERY_POLICY_LIST_CONNECTION_SHAPE,
  NOTIFICATION_DELIVERY_POLICY_SAVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/support-messages";
import { connectionJson } from "@/lib/mcp-connection-request";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  getEmailTemplateDefinition,
  isAdminSystemTemplate,
} from "@/lib/email-message-registry";
import {
  listNotificationDeliveryPolicySettings,
  modeToDb,
} from "@/lib/notification-delivery-policies";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// The body schema lives in admin-support-api/messages.ts, which the AI app
// action `set_notification_delivery_policy` offers too (ALP-724).

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  return connectionJson(
    request,
    await listNotificationDeliveryPolicySettings(),
    NOTIFICATION_DELIVERY_POLICY_LIST_CONNECTION_SHAPE,
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

  const parsed = notificationDeliveryPolicyUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const definition = getEmailTemplateDefinition(parsed.data.templateName);
  if (!definition || !isAdminSystemTemplate(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown admin/system template" }, { status: 400 });
  }
  if (!definition.deliveryEditable) {
    return NextResponse.json(
      { error: "Delivery policy for this template is locked" },
      { status: 400 },
    );
  }

  const before = await prisma.notificationDeliveryPolicy.findUnique({
    where: { templateName: parsed.data.templateName },
  });
  const mode = modeToDb(parsed.data.mode);

  const record = await prisma.notificationDeliveryPolicy.upsert({
    where: { templateName: parsed.data.templateName },
    create: {
      templateName: parsed.data.templateName,
      mode,
      updatedByMemberId: session.user.id,
    },
    update: {
      mode,
      updatedByMemberId: session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "NOTIFICATION_DELIVERY_POLICY_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "NotificationDeliveryPolicy",
        id: parsed.data.templateName,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Notification delivery policy updated",
      metadata: {
        templateName: parsed.data.templateName,
        previousPolicy: before,
        mode: parsed.data.mode,
      },
      request: getAuditRequestContext(request),
    }),
  );

  // Answer the mode as the list and the request spell it, not the stored enum.
  return connectionJson(
    request,
    { policy: { ...record, mode: parsed.data.mode } },
    NOTIFICATION_DELIVERY_POLICY_SAVED_CONNECTION_SHAPE,
  );
}
