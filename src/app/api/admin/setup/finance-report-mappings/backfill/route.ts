import { FinanceSyncRunStatus, FinanceSyncRunTrigger } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import {
  hasFinanceManagerAccess,
  loadFinanceAccessMember,
} from "@/lib/finance-auth";
import { getFinanceSyncDatasets } from "@/lib/finance-sync-datasets";
import {
  DEFAULT_FINANCE_SYNC_WORKFLOW,
  runFinanceSync,
} from "@/lib/finance-sync-service";
import { getLatestFinanceSyncRun } from "@/lib/finance-sync-storage";
import { requireAdmin } from "@/lib/session-guards";

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

export async function POST(request: NextRequest) {
  const guard = await requireFinanceSetupWriteAccess();
  if (!guard.ok) {
    return guard.response;
  }

  const latestRun = await getLatestFinanceSyncRun(DEFAULT_FINANCE_SYNC_WORKFLOW);
  if (latestRun?.status === FinanceSyncRunStatus.RUNNING) {
    return NextResponse.json(
      {
        error: "Finance sync already running",
        runId: latestRun.id,
        startedAt: latestRun.startedAt.toISOString(),
      },
      { status: 409 },
    );
  }

  const execution = await runFinanceSync({
    workflow: DEFAULT_FINANCE_SYNC_WORKFLOW,
    trigger: FinanceSyncRunTrigger.BACKFILL,
    requestedByMemberId: guard.member.id,
    datasets: getFinanceSyncDatasets(),
    metadata: {
      source: "admin-setup",
      initiatedFrom: "/admin/setup",
      reason:
        "Backfill stored finance snapshots for dashboard historical coverage.",
    },
  });

  const auditRequest = getAuditRequestContext(request) ?? {};
  await createAuditLog({
    action: "finance_report_mappings.backfill",
    memberId: guard.member.id,
    actorMemberId: guard.member.id,
    category: "xero",
    severity: "important",
    outcome:
      execution.status === FinanceSyncRunStatus.SUCCEEDED
        ? "success"
        : "blocked",
    summary: "Finance history backfill run from Admin Setup",
    metadata: {
      runId: execution.runId,
      status: execution.status,
      snapshotCount: execution.snapshotCount,
      totalRowCount: execution.totalRowCount,
    },
    requestId: auditRequest.id ?? null,
    ipAddress: auditRequest.ipAddress ?? null,
    userAgent: auditRequest.userAgent ?? null,
  });

  return NextResponse.json({
    runId: execution.runId,
    status: execution.status,
    snapshotCount: execution.snapshotCount,
    totalRowCount: execution.totalRowCount,
  });
}
