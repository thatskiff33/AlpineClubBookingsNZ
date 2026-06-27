import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import {
  getFinanceReportMappingsState,
  saveFinanceReportMappings,
} from "@/lib/finance-report-mappings";
import {
  hasFinanceManagerAccess,
  loadFinanceAccessMember,
} from "@/lib/finance-auth";
import { requireAdmin } from "@/lib/session-guards";

const mappingSchema = z.object({
  id: z.string().optional(),
  accountCode: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  sectionLabel: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  lineLabel: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

const categorySchema = z.object({
  id: z.string().optional(),
  kind: z.enum(["REVENUE", "EXPENSE"]),
  name: z.string(),
  sortOrder: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  mappings: z.array(mappingSchema).optional(),
});

const saveSchema = z.object({
  categories: z.array(categorySchema).min(1),
});

async function requireFinanceSetupWriteAccess() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard;
  }

  const member = await loadFinanceAccessMember(guard.session.user.id);
  if (!member || !hasFinanceManagerAccess(member.financeAccessLevel)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Admin finance manager access required" },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true as const,
    session: guard.session,
    member,
  };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const state = await getFinanceReportMappingsState();
  return NextResponse.json(state);
}

export async function PUT(request: NextRequest) {
  const guard = await requireFinanceSetupWriteAccess();
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    await saveFinanceReportMappings(parsed.data);
  } catch (error) {
    const validationErrors = (error as Error & { validationErrors?: string[] })
      .validationErrors;
    if (validationErrors) {
      return NextResponse.json(
        { error: "Invalid finance report mappings", details: validationErrors },
        { status: 400 },
      );
    }
    throw error;
  }

  const auditRequest = getAuditRequestContext(request) ?? {};
  await createAuditLog({
    action: "finance_report_mappings.save",
    memberId: guard.member.id,
    actorMemberId: guard.member.id,
    category: "xero",
    severity: "important",
    outcome: "success",
    summary: "Finance report category mappings saved",
    metadata: {
      categoryCount: parsed.data.categories.length,
      mappingCount: parsed.data.categories.reduce(
        (total, category) => total + (category.mappings?.length ?? 0),
        0,
      ),
    },
    requestId: auditRequest.id ?? null,
    ipAddress: auditRequest.ipAddress ?? null,
    userAgent: auditRequest.userAgent ?? null,
  });

  revalidatePath("/finance");
  revalidatePath("/admin/setup");

  return NextResponse.json(await getFinanceReportMappingsState());
}
