import { NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { XERO_STALE_RUNNING_RESET_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import {
  STALE_RUNNING_XERO_OPERATION_BULK_RESET_MESSAGE,
  staleRunningXeroOperationFilter,
  writeStaleRunningXeroOperationReset,
} from "@/lib/xero-stale-operations";
import logger from "@/lib/logger";

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  try {
    const now = new Date();
    // #3462: the reset and its audit row commit together or not at all, so a
    // failed audit never leaves an unattributed bulk override behind.
    // `count` names this audit writer in the audit-writer census (#2581).
    const count = await prisma.$transaction(async (tx) => {
      const written = await writeStaleRunningXeroOperationReset(
        staleRunningXeroOperationFilter(now),
        now,
        STALE_RUNNING_XERO_OPERATION_BULK_RESET_MESSAGE,
        tx,
      );
      if (written.failed + written.partial > 0) {
        await createAuditLog(
          {
            action: "XERO_OPERATIONS_RESET_STALE_RUNNING",
            category: "xero",
            memberId: session.user.id,
            details: `Reset ${describeReset(written, "stale RUNNING Xero operation", "FAILED", "PARTIAL")}`,
          },
          tx,
        );
      }
      return written;
    });
    const total = count.failed + count.partial;

    return connectionJson(request, {
      ok: true,
      count: total,
      failed: count.failed,
      partial: count.partial,
      message:
        total > 0
          ? `Reset ${describeReset(count, "stale running operation", "failed", "partly completed")}. Retry or resolve them from the list.`
          : "No stale running operations to reset.",
    }, XERO_STALE_RUNNING_RESET_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error }, "Failed to reset stale running Xero operations");
    return NextResponse.json(
      { error: "Failed to reset stale running Xero operations" },
      { status: 500 }
    );
  }
}

/**
 * #4256: what a reset did, from its two counts - an interrupted PARTIAL repair
 * goes back to PARTIAL, every other stale row to FAILED.
 */
function describeReset(
  reset: { failed: number; partial: number },
  failedNoun: string,
  failedWord: string,
  partialWord: string,
): string {
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return [
    reset.failed > 0 ? `${plural(reset.failed, failedNoun)} to ${failedWord}` : null,
    reset.partial > 0 ? `${plural(reset.partial, "interrupted repair")} back to ${partialWord}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
}
