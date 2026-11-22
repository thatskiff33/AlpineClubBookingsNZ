import { NextRequest, NextResponse } from "next/server";
import { FINANCE_SYNC_STATUS_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-reports";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import { connectionJson } from "@/lib/mcp-connection-request";

export async function GET(request: NextRequest) {
  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const diagnostics = await getFinanceSyncDiagnosticsStatus();
    return connectionJson(request, diagnostics, FINANCE_SYNC_STATUS_CONNECTION_SHAPE);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load finance sync diagnostics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
