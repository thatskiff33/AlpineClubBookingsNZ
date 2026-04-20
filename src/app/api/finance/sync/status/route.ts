import { NextResponse } from "next/server";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";

export async function GET() {
  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const diagnostics = await getFinanceSyncDiagnosticsStatus();
    return NextResponse.json(diagnostics);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load finance sync diagnostics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
