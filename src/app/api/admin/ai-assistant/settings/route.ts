import { NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import { helpAssistantBudgetUpdateSchema } from "@/lib/admin-support-api/ai-settings";
import {
  HELP_ASSISTANT_SETTINGS_CONNECTION_SHAPE,
  type HelpAssistantSettingsAnswer,
} from "@/lib/connection-shapes/support-ai";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { DEFAULT_MONTHLY_BUDGET_CENTS } from "@/lib/ai-assistant-usage";
import { prisma } from "@/lib/prisma";

// GET/PUT /api/admin/ai-assistant/settings — the AI help assistant monthly spend
// cap (#2211, C3). The cap is a deployment-specific operational control; it does
// NOT travel in a config bundle (see config-transfer club-settings.ts).

// The update schema (integer cents of the club's currency, #3354; 0 is
// hard-off; capped so a fat-finger cannot uncap spend) lives in
// admin-support-api/ai-settings.ts, which the AI app action
// `update_help_assistant_budget` offers too (ALP-724).

const AI_ASSISTANT_SETTINGS_ID = "default";

export async function GET(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const row = await prisma.aiAssistantSettings.findUnique({
    where: { id: AI_ASSISTANT_SETTINGS_ID },
  });

  const answer: HelpAssistantSettingsAnswer = {
    monthlyBudgetCents: row?.monthlyBudgetCents ?? DEFAULT_MONTHLY_BUDGET_CENTS,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: row?.updatedByMemberId ?? null,
  };
  return connectionJson(request, answer, HELP_ASSISTANT_SETTINGS_CONNECTION_SHAPE);
}

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

  const parsed = helpAssistantBudgetUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { monthlyBudgetCents } = parsed.data;

  // Read the previous value, upsert, and write the audit log inside ONE
  // transaction so concurrent PUTs record accurate previous values (reading the
  // old row before the transaction would let two racing writers both capture the
  // same stale `previousMonthlyBudgetCents`).
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.aiAssistantSettings.findUnique({
      where: { id: AI_ASSISTANT_SETTINGS_ID },
    });
    const previousCents =
      existing?.monthlyBudgetCents ?? DEFAULT_MONTHLY_BUDGET_CENTS;

    const updated = await tx.aiAssistantSettings.upsert({
      where: { id: AI_ASSISTANT_SETTINGS_ID },
      create: {
        id: AI_ASSISTANT_SETTINGS_ID,
        monthlyBudgetCents,
        updatedByMemberId: session.user.id,
      },
      update: {
        monthlyBudgetCents,
        updatedByMemberId: session.user.id,
      },
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "AI_ASSISTANT_SETTINGS_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "AiAssistantSettings", id: AI_ASSISTANT_SETTINGS_ID },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "AI assistant monthly spend cap updated",
        metadata: {
          previousMonthlyBudgetCents: previousCents,
          newMonthlyBudgetCents: monthlyBudgetCents,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return updated;
  });

  const answer: HelpAssistantSettingsAnswer = {
    monthlyBudgetCents: row.monthlyBudgetCents,
    updatedAt: row.updatedAt.toISOString(),
    updatedByMemberId: row.updatedByMemberId,
  };
  return connectionJson(request, answer, HELP_ASSISTANT_SETTINGS_CONNECTION_SHAPE);
}
