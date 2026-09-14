import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  staleRunningXeroOperationFilter,
  XERO_ORPHANED_STALE_RUNNING_ERROR_CODE,
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
    const result = await prisma.xeroSyncOperation.updateMany({
      where: staleRunningXeroOperationFilter(now),
      data: {
        status: "FAILED",
        lastErrorCode: XERO_ORPHANED_STALE_RUNNING_ERROR_CODE,
        lastErrorMessage:
          "Operation was stuck RUNNING past the staleness threshold and was reset to FAILED by an operator.",
        completedAt: now,
      },
    });

    if (result.count > 0) {
      logAudit({
        action: "XERO_OPERATIONS_RESET_STALE_RUNNING",
        category: "xero",
        memberId: session.user.id,
        details: `Reset ${result.count} stale RUNNING Xero operation${result.count === 1 ? "" : "s"} to FAILED`,
      });
    }

    return NextResponse.json({
      ok: true,
      count: result.count,
      message:
        result.count > 0
          ? `Reset ${result.count} stale running operation${result.count === 1 ? "" : "s"} to failed. Retry or resolve them from the list.`
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
