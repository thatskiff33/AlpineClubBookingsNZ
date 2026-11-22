import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  getEmailTemplateDefinition,
  isAdminSystemTemplate,
  type NotificationDeliveryModeValue,
} from "@/lib/email-message-registry";
import {
  listNotificationDeliveryPolicySettings,
  modeToDb,
} from "@/lib/notification-delivery-policies";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const updateSchema = z
  .object({
    templateName: z.string().trim().min(1),
    mode: z.enum(["always", "content_only", "disabled"]),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  return NextResponse.json(await listNotificationDeliveryPolicySettings());
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

  const parsed = updateSchema.safeParse(body);
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
  const mode = modeToDb(parsed.data.mode as NotificationDeliveryModeValue);

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

  return NextResponse.json({ policy: record });
}
