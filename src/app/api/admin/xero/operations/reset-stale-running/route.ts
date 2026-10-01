import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import {
  STALE_RUNNING_XERO_OPERATION_BULK_RESET_MESSAGE,
  staleRunningXeroOperationFilter,
  writeStaleRunningXeroOperationReset,
} from "@/lib/xero-stale-operations";
import logger from "@/lib/logger";

export async function POST() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  try {
    const now = new Date();
    const count = await writeStaleRunningXeroOperationReset(
      staleRunningXeroOperationFilter(now),
      now,
      STALE_RUNNING_XERO_OPERATION_BULK_RESET_MESSAGE,
    );

    if (count > 0) {
      logAudit({
        action: "XERO_OPERATIONS_RESET_STALE_RUNNING",
        category: "xero",
        memberId: session.user.id,
        details: `Reset ${count} stale RUNNING Xero operation${count === 1 ? "" : "s"} to FAILED`,
      });
    }

    return NextResponse.json({
      ok: true,
      count,
      message:
        count > 0
          ? `Reset ${count} stale running operation${count === 1 ? "" : "s"} to failed. Retry or resolve them from the list.`
          : "No stale running operations to reset.",
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to reset stale running Xero operations");
    return NextResponse.json(
      { error: "Failed to reset stale running Xero operations" },
      { status: 500 }
    );
  }
}
