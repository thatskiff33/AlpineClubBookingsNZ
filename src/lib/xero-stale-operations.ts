import { prisma } from "@/lib/prisma";

// Issue #819: an outbox operation is claimed by flipping it to RUNNING and
// stamping startedAt. If the worker dies (or an unexpected dispatch-level error
// escapes the per-operation failure helper) the row can stay RUNNING forever.
// The outbox worker runs every ~15 minutes, so a RUNNING row older than this
// threshold is almost certainly stuck rather than genuinely in flight, and
// should be surfaced to operators.
export const STALE_RUNNING_XERO_OPERATION_MINUTES = 15;

/**
 * Prisma `where` filter matching XeroSyncOperation rows stuck in RUNNING past
 * the staleness threshold. Rows with a null startedAt are never matched by the
 * `lt` comparison, so only genuinely-claimed-and-stuck rows are counted.
 */
export function staleRunningXeroOperationFilter(now: Date = new Date()) {
  const threshold = new Date(
    now.getTime() - STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000,
  );

  return {
    status: "RUNNING",
    startedAt: { lt: threshold },
  } as const;
}

/**
 * Count outbox operations stuck in RUNNING past the staleness threshold. Pure
 * visibility; it does not reset or mutate the operations.
 */
export async function countStaleRunningXeroOperations(
  now: Date = new Date(),
): Promise<number> {
  return prisma.xeroSyncOperation.count({
    where: staleRunningXeroOperationFilter(now),
  });
}
