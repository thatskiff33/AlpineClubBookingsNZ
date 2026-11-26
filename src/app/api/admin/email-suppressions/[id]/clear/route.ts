import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { emailSuppressionClearSchema } from "@/lib/admin-support-api/messages";
import {
  EMAIL_SUPPRESSION_CLEARED_CONNECTION_SHAPE,
  type EmailSuppressionClearedAnswer,
} from "@/lib/connection-shapes/support-messages";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import { clearEmailSuppression } from "@/lib/email-suppression";
import { logAudit } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const jsonBody = await parseOptionalJsonRequestBody(request, { whenAbsent: {} });
  if (!jsonBody.ok) return jsonBody.response;
  const body = jsonBody.body;

  const parsed = emailSuppressionClearSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  const suppression = await clearEmailSuppression({
    id,
    clearedById: session.user.id,
    clearReason: parsed.data.reason,
  });

  logAudit({
    action: "EMAIL_SUPPRESSION_CLEARED",
    category: "communication",
    memberId: session.user.id,
    targetId: suppression.id,
    entityType: "EmailSuppression",
    entityId: suppression.id,
    details: JSON.stringify({
      email: suppression.email,
      reason: parsed.data.reason ?? null,
    }),
  });

  const answer: EmailSuppressionClearedAnswer = {
    success: true,
    suppression: {
      id: suppression.id,
      email: suppression.email,
      clearedAt: suppression.clearedAt?.toISOString() ?? null,
    },
  };
  return connectionJson(request, answer, EMAIL_SUPPRESSION_CLEARED_CONNECTION_SHAPE);
}
