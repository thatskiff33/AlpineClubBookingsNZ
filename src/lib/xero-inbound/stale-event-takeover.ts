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
 * reprocess's own start (`INV-INT-038`), which counts each dead attempt on it.
 * An event whose own processing kills the process would otherwise be retaken,
 * and take its process down again, every lease: past
 * `MAX_DEAD_XERO_INBOUND_ATTEMPTS` the automatic worker leaves it PROCESSING,
 * logs an error each run, and an officer's Replay is the only route.
 *
 * No advisory lock: the guarded write is the claim (`INV-LOCK-001`).
 */
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { staleProcessingXeroInboundEventFilter } from "@/lib/xero-stale-operations";
import { xeroInboundDedupMarkerWhere } from "./dedup-marker";
import { INBOUND_RECONCILE_DIRECTION, INBOUND_RECONCILE_OPERATION_TYPE } from "./reconcile-operation";

/**
 * Dead attempts on one event after which the automatic worker stops taking it
 * over (`INV-INT-039`). Read from the RUNNING inbound reconcile operation's
 * `attemptCount`, which `INV-INT-038` increments on each takeover of a dead
 * attempt's row: at 3, the first attempt and two automatic retakes all died.
 */
export const MAX_DEAD_XERO_INBOUND_ATTEMPTS = 3;

/** Stale rows read per run, so events held for an officer never crowd out newer stale ones. */
const STALE_SCAN_LIMIT = 200;

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
 * The correlation keys whose RUNNING inbound reconcile operation records
 * `MAX_DEAD_XERO_INBOUND_ATTEMPTS` dead attempts or more.
 */
async function exhaustedCorrelationKeys(correlationKeys: string[]): Promise<Set<string>> {
  if (correlationKeys.length === 0) return new Set();
  const operations = await prisma.xeroSyncOperation.findMany({
    where: {
      correlationKey: { in: correlationKeys },
      direction: INBOUND_RECONCILE_DIRECTION,
      operationType: INBOUND_RECONCILE_OPERATION_TYPE,
      status: "RUNNING",
      attemptCount: { gte: MAX_DEAD_XERO_INBOUND_ATTEMPTS },
    },
    select: { correlationKey: true },
  });
  return new Set(operations.flatMap((operation) => (operation.correlationKey ? [operation.correlationKey] : [])));
}

/**
 * The automatic worker's step before it selects a batch: take over up to
 * `limit` stale PROCESSING events, oldest first. `lost` counts the events this
 * worker found stale but another writer moved first; `heldForOfficer` the
 * stale events past the dead-attempt cap, left PROCESSING for Replay.
 */
export async function takeOverStaleProcessingXeroInboundEvents(options: {
  limit: number;
  now?: Date;
}): Promise<{ takenOver: number; lost: number; heldForOfficer: number }> {
  const now = options.now ?? new Date();
  const stale = await prisma.xeroInboundEvent.findMany({
    where: staleProcessingXeroInboundEventFilter(now),
    select: { id: true, correlationKey: true },
    orderBy: { createdAt: "asc" },
    take: STALE_SCAN_LIMIT,
  });

  const exhausted = await exhaustedCorrelationKeys(stale.map((event) => event.correlationKey));
  for (const event of stale) {
    if (exhausted.has(event.correlationKey)) {
      logger.error(
        { inboundEventId: event.id, correlationKey: event.correlationKey, maxDeadAttempts: MAX_DEAD_XERO_INBOUND_ATTEMPTS },
        "Xero inbound event killed its worker on every attempt; it is left PROCESSING and only an officer's Replay retries it (INV-INT-039)",
      );
    }
  }

  const eligible = stale.filter((event) => !exhausted.has(event.correlationKey)).slice(0, options.limit);
  let takenOver = 0;
  for (const event of eligible) {
    if (await takeOverStaleProcessingXeroInboundEvent(event, now)) {
      takenOver += 1;
    }
  }
  return { takenOver, lost: eligible.length - takenOver, heldForOfficer: exhausted.size };
}
