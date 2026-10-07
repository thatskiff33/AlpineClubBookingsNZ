import { NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
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
    // #3462: the reset and its audit row commit together or not at all, so a
    // failed audit never leaves an unattributed bulk override behind.
    const count = await prisma.$transaction(async (tx) => {
      const reset = await writeStaleRunningXeroOperationReset(
        staleRunningXeroOperationFilter(now),
        now,
        STALE_RUNNING_XERO_OPERATION_BULK_RESET_MESSAGE,
        tx,
      );
      if (reset > 0) {
        await createAuditLog(
          {
            action: "XERO_OPERATIONS_RESET_STALE_RUNNING",
            category: "xero",
            memberId: session.user.id,
            details: `Reset ${reset} stale RUNNING Xero operation${reset === 1 ? "" : "s"} to FAILED`,
          },
          tx,
        );
      }
      return reset;
    });

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
