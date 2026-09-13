import { NextResponse } from "next/server";
import { z } from "zod";
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

const AI_ASSISTANT_SETTINGS_ID = "default";

const updateSchema = z
  .object({
    // Integer cents of the club's configured currency (#3354). 0 disables all
    // paid answers (hard-off); 100000c = 1,000.00 upper guard so a fat-finger
    // cannot uncap spend.
    monthlyBudgetCents: z.number().int().min(0).max(100000),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const row = await prisma.aiAssistantSettings.findUnique({
    where: { id: AI_ASSISTANT_SETTINGS_ID },
  });

  return NextResponse.json({
    monthlyBudgetCents: row?.monthlyBudgetCents ?? DEFAULT_MONTHLY_BUDGET_CENTS,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: row?.updatedByMemberId ?? null,
  });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

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

  return NextResponse.json({
    monthlyBudgetCents: row.monthlyBudgetCents,
    updatedAt: row.updatedAt.toISOString(),
    updatedByMemberId: row.updatedByMemberId,
  });
}
