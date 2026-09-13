import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS,
  DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS,
  DIAGNOSTICS_SETTINGS_ID,
  getDiagnosticsUsageSummary,
} from "@/lib/ai-diagnostics-usage";
import { prisma } from "@/lib/prisma";

// GET/PUT /api/admin/ai-diagnostics/settings — the AI Diagnostics monthly spend
// budget (AID-2, #2371). A SEPARATE surface from the page-help AI assistant
// settings; the two budgets are unrelated. This route hard-gates on the
// aiDiagnostics module flag (feature-routes.ts), so it 404s while the module is
// off — the setup-first surface that stays reachable module-off is the readiness
// endpoint. The budget is a deployment-specific operational control; it does NOT
// travel in a config bundle (see config-transfer club-settings.ts).

const updateSchema = z
  .object({
    // Integer cents of the club's configured currency (#3354). 0 disables all
    // paid diagnostics calls (hard-off, the ship default);
    // DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS is the fat-finger guard.
    monthlyBudgetCents: z
      .number()
      .int()
      .min(0)
      .max(DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const [row, usage] = await Promise.all([
    prisma.diagnosticsSettings.findUnique({
      where: { id: DIAGNOSTICS_SETTINGS_ID },
    }),
    getDiagnosticsUsageSummary(),
  ]);

  return NextResponse.json({
    monthlyBudgetCents:
      row?.monthlyBudgetCents ?? DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS,
    maxMonthlyBudgetCents: DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: row?.updatedByMemberId ?? null,
    usage,
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
  // same stale previousMonthlyBudgetCents).
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.diagnosticsSettings.findUnique({
      where: { id: DIAGNOSTICS_SETTINGS_ID },
    });
    const previousCents =
      existing?.monthlyBudgetCents ?? DIAGNOSTICS_DEFAULT_MONTHLY_BUDGET_CENTS;

    const updated = await tx.diagnosticsSettings.upsert({
      where: { id: DIAGNOSTICS_SETTINGS_ID },
      create: {
        id: DIAGNOSTICS_SETTINGS_ID,
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
        action: "AI_DIAGNOSTICS_SETTINGS_UPDATED",
        actor: { memberId: session.user.id },
        entity: { type: "DiagnosticsSettings", id: DIAGNOSTICS_SETTINGS_ID },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "AI Diagnostics monthly spend budget updated",
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
