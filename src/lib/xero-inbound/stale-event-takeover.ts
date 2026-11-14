/**
 * The takeover of a stored Xero inbound event left PROCESSING by a dead worker
 * (`INV-INT-039`, #4921). One helper, shared by the automatic worker
 * (`processStoredXeroInboundEvents`) and an officer's Replay.
 *
 * A worker claims a stored event by flipping it to PROCESSING, which restamps
 * `updatedAt`. If the process then stops (a deploy swaps the container, it is
 * killed or runs out of memory) nothing else ever moves the row: Xero was
 * already told "got it" and will not resend, and the selector reads RECEIVED and
 * FAILED rows only. A PROCESSING row older than the shared webhook lease
 * (`staleProcessingXeroInboundEventFilter`) is a dead attempt's, so it is reset
 * to RECEIVED and reprocessed.
 *
 * The takeover is one `updateMany` guarded on status PROCESSING and the stale
 * `updatedAt`, so of racing takeovers (the web after-response kick and the cron
 * leader, or either and a Replay) exactly one wins. In the same transaction the
 * winner deletes the event's `ProcessedWebhookEvent` dedup row (source `xero`),
 * which the dead attempt had already written: left in place it would make the
 * reprocess report a duplicate and mark the event PROCESSED without applying it.
 *
 * The operation row the dead attempt left RUNNING is recovered by the
 * reprocess's own start (`INV-INT-038`). No advisory lock: the guarded write is
 * the claim (`INV-LOCK-001`).
 */
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { staleProcessingXeroInboundEventFilter } from "@/lib/xero-stale-operations";
import { xeroInboundDedupMarkerWhere } from "./dedup-marker";

interface StaleInboundEvent {
  id: string;
  correlationKey: string;
}

/**
 * Reset one stale PROCESSING event to RECEIVED and clear its dedup row, in one
 * transaction. False when the guard matched nothing: the row is no longer a
 * stale PROCESSING one (another takeover won, or its attempt finished).
 */
export async function takeOverStaleProcessingXeroInboundEvent(
  event: StaleInboundEvent,
  now: Date = new Date(),
): Promise<boolean> {
  const taken = await prisma.$transaction(async (tx) => {
    const reset = await tx.xeroInboundEvent.updateMany({
      where: { id: event.id, ...staleProcessingXeroInboundEventFilter(now) },
      data: { status: "RECEIVED", errorMessage: null, processedAt: null },
    });
    if (reset.count !== 1) {
      return false;
    }
    await tx.processedWebhookEvent.deleteMany({
      where: xeroInboundDedupMarkerWhere(event.correlationKey),
    });
    return true;
  });

  if (taken) {
    logger.warn(
      { inboundEventId: event.id, correlationKey: event.correlationKey },
      "Took over a Xero inbound event left PROCESSING past the webhook lease; it will be reprocessed (INV-INT-039)",
    );
  }
  return taken;
}

/**
 * The automatic worker's step before it selects a batch: take over up to
 * `limit` stale PROCESSING events, oldest first. `lost` counts the events this
 * worker found stale but another writer moved first.
 */
export async function takeOverStaleProcessingXeroInboundEvents(options: {
  limit: number;
  now?: Date;
}): Promise<{ takenOver: number; lost: number }> {
  const now = options.now ?? new Date();
  const stale = await prisma.xeroInboundEvent.findMany({
    where: staleProcessingXeroInboundEventFilter(now),
    select: { id: true, correlationKey: true },
    orderBy: { createdAt: "asc" },
    take: options.limit,
  });

  let takenOver = 0;
  for (const event of stale) {
    if (await takeOverStaleProcessingXeroInboundEvent(event, now)) {
      takenOver += 1;
    }
  }
  return { takenOver, lost: stale.length - takenOver };
}
