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

// Issue #819/#815: an inbound webhook event is claimed by flipping it from
// RECEIVED/FAILED to PROCESSING (which restamps @updatedAt). If the worker dies
// mid-reconciliation the row stays PROCESSING forever, manual replay refuses it
// ("already being processed"), and no sweep resets it. The inbound
// reconciliation cycle runs on roughly the same cadence as the outbox worker, so
// a PROCESSING row whose updatedAt is older than this threshold is almost
// certainly orphaned rather than genuinely in flight.
export const STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES = 15;

/**
 * Prisma `where` filter matching XeroInboundEvent rows stuck in PROCESSING past
 * the staleness threshold. updatedAt is restamped when the row is claimed, so
 * only rows that have been PROCESSING longer than the threshold are matched.
 */
export function staleProcessingXeroInboundEventFilter(now: Date = new Date()) {
  const threshold = new Date(
    now.getTime() - STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES * 60_000,
  );

  return {
    status: "PROCESSING",
    updatedAt: { lt: threshold },
  } as const;
}

/**
 * Count inbound events stuck in PROCESSING past the staleness threshold. Pure
 * visibility; it does not reset or mutate the events. Recovery happens via the
 * guarded manual replay takeover in `replayStoredXeroInboundEvent`.
 */
export async function countStaleProcessingXeroInboundEvents(
  now: Date = new Date(),
): Promise<number> {
  return prisma.xeroInboundEvent.count({
    where: staleProcessingXeroInboundEventFilter(now),
  });
}

/**
 * True when a PROCESSING inbound event's last update is older than the staleness
 * threshold, i.e. it is safe for an operator to take over and replay it. A null
 * updatedAt is treated as not-stale so a genuinely fresh claim is never stolen.
 */
export function isStaleProcessingXeroInboundEvent(
  updatedAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!updatedAt) {
    return false;
  }

  const threshold = new Date(
    now.getTime() - STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES * 60_000,
  );

  return updatedAt.getTime() < threshold.getTime();
}
