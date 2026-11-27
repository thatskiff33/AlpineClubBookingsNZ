import { FinanceSyncRunStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { parseOptionalJsonRequestBody } from "@/lib/api-json";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import {
  FINANCE_BACKFILL_MONTHLY_FACTS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/finance-reports";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import { financeBackfillMonthlyFactsBodySchema } from "@/lib/finance-backfill-request";
import { backfillFinanceMonthlyFacts } from "@/lib/finance-monthly-fact-backfill";
import { getLatestFinanceSyncRun } from "@/lib/finance-sync-storage";
import logger from "@/lib/logger";
import { connectionJson } from "@/lib/mcp-connection-request";

export async function POST(request: NextRequest) {
  const authResult = await requireFinanceManagerApiAccess();
  if (!authResult.ok) {
    return authResult.response;
  }

  // The body is optional and read only when it says it is JSON; any other
  // content type runs with the defaults, as before (#5407).
  let body: unknown;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const jsonBody = await parseOptionalJsonRequestBody(request, { whenAbsent: {}, objectOnly: true });
    if (!jsonBody.ok) return jsonBody.response;
    body = jsonBody.body;
  }

  const parsed = financeBackfillMonthlyFactsBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" }, { status: 400 });
  }
  const options = parsed.data;

  // One finance sync at a time: replacing fact months while the daily sync is
  // also writing them serves no one.
  const latestRun = await getLatestFinanceSyncRun();
  if (latestRun?.status === FinanceSyncRunStatus.RUNNING) {
    return NextResponse.json(
      {
        error: "A finance sync run is already in progress",
        runId: latestRun.id,
        workflow: latestRun.workflow,
        startedAt: latestRun.startedAt.toISOString(),
      },
      { status: 409 }
    );
  }

  try {
    const execution = await backfillFinanceMonthlyFacts({
      requestedByMemberId: authResult.member.id,
      fromMonth: options.fromMonth,
      maxChunks: options.maxChunks,
      metadata: { initiatedFrom: "/api/finance/sync/backfill-monthly-facts" },
    });

    const auditRequest = getAuditRequestContext(request) ?? {};
    await createAuditLog({
      action: "finance_monthly_facts.backfill",
      memberId: authResult.member.id,
      actorMemberId: authResult.member.id,
      category: "xero",
      severity: "important",
      outcome:
        execution.status === FinanceSyncRunStatus.SUCCEEDED
          ? "success"
          : "blocked",
      summary: "Finance monthly fact table backfill run",
      metadata: {
        runId: execution.runId,
        status: execution.status,
        snapshotCount: execution.snapshotCount,
        totalRowCount: execution.totalRowCount,
        fromMonth: options.fromMonth,
        maxChunks: options.maxChunks,
      },
      requestId: auditRequest.id ?? null,
      ipAddress: auditRequest.ipAddress ?? null,
      userAgent: auditRequest.userAgent ?? null,
    });

    return connectionJson(request, {
      runId: execution.runId,
      status: execution.status,
      snapshotCount: execution.snapshotCount,
      totalRowCount: execution.totalRowCount,
      datasetResults: execution.datasetResults,
    }, FINANCE_BACKFILL_MONTHLY_FACTS_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Finance monthly fact backfill failed");

    return NextResponse.json(
      { error: "Finance monthly fact backfill failed" },
      { status: 500 }
    );
  }
}
