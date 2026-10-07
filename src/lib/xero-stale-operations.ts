import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Issue #819: an outbox operation is claimed by flipping it to RUNNING and
// stamping startedAt. If the worker dies (or an unexpected dispatch-level error
// escapes the per-operation failure helper) the row can stay RUNNING forever.
// The outbox worker runs every ~15 minutes, so a RUNNING row older than this
// threshold is almost certainly stuck rather than genuinely in flight, and
// should be surfaced to operators.
export const STALE_RUNNING_XERO_OPERATION_MINUTES = 15;

/**
 * THE ERROR CODE a stale-RUNNING reset stamps on the row it fails (#3001).
 *
 * One home, because three places depend on the exact string: the operator reset
 * route writes it, the contact-create recovery reads it back, and the booking
 * page's invoice warning uses it to tell an operation that FAILED from an
 * operation that was never seen through — a worker killed mid-invoice leaves no
 * evidence either way, so the honest reading of such a row is that the invoice
 * state is UNKNOWN rather than that no invoice was raised.
 */
export const XERO_ORPHANED_STALE_RUNNING_ERROR_CODE = "ORPHANED_STALE_RUNNING";

/** The instant before which a RUNNING claim is stale. One threshold for both forms below. */
function staleRunningThreshold(now: Date): Date {
  return new Date(now.getTime() - STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000);
}

/**
 * THE row-level "is stale RUNNING" predicate (#3462): the row is RUNNING and
 * was claimed longer ago than the staleness threshold, i.e. it is almost
 * certainly stuck rather than genuinely in flight.
 *
 * It takes the row, status included, because the status is the load-bearing
 * half: completing or failing a row never clears its `startedAt`, so a
 * `startedAt`-only check would read every old SUCCEEDED or FAILED row as stuck.
 * The row-level counterpart of {@link staleRunningXeroOperationFilter}, and
 * written to agree with it: a null `startedAt` is never stale, exactly as the
 * filter's `lt` comparison never matches one.
 */
export function isStaleRunningXeroOperation(
  operation: { status: string; startedAt: Date | null | undefined },
  now: Date = new Date(),
): boolean {
  if (operation.status !== "RUNNING" || !operation.startedAt) return false;

  return operation.startedAt.getTime() < staleRunningThreshold(now).getTime();
}

/**
 * #3880: the complement - a RUNNING claim young enough to be genuinely in
 * flight. A sibling that must wait for one waits only this long for a dead one.
 */
export function liveRunningXeroOperationFilter(now: Date = new Date()) {
  return {
    status: "RUNNING",
    startedAt: { gte: staleRunningThreshold(now) },
  } as const;
}

/**
 * Prisma `where` filter matching XeroSyncOperation rows stuck in RUNNING past
 * the staleness threshold. Rows with a null startedAt are never matched by the
 * `lt` comparison, so only genuinely-claimed-and-stuck rows are counted.
 */
export function staleRunningXeroOperationFilter(now: Date = new Date()) {
  return {
    status: "RUNNING",
    startedAt: { lt: staleRunningThreshold(now) },
  } as const;
}

/**
 * #3462: the one wording of a stale-RUNNING reset, bulk or per row. Both
 * messages start with this lead, which is also how a later Mark failed
 * recognises a message one of them wrote.
 */
const STALE_RUNNING_RESET_LEAD =
  "Operation was stuck RUNNING past the staleness threshold and was";

export const STALE_RUNNING_XERO_OPERATION_BULK_RESET_MESSAGE = `${STALE_RUNNING_RESET_LEAD} reset to FAILED by an operator.`;

const STALE_RUNNING_MARK_FAILED_MESSAGE = `${STALE_RUNNING_RESET_LEAD} marked FAILED by an operator.`;

const CARRIED_CAUSE_LEAD = " The last error recorded before it stuck: ";

/**
 * The cause a Mark failed carries forward from the row it marks (#3462). The
 * earlier error a stranded retry left is usually what the operator must fix.
 * But when that error is itself an earlier stale reset (the row was marked
 * failed, requeued and stuck again), only the cause inside it is carried, so
 * repeated cycles never nest the prefix.
 */
function carriedStaleRunningCause(row: {
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}): string | null {
  const message = row.lastErrorMessage;
  if (!message) return null;
  if (
    row.lastErrorCode !== XERO_ORPHANED_STALE_RUNNING_ERROR_CODE &&
    !message.startsWith(STALE_RUNNING_RESET_LEAD)
  ) {
    return message;
  }
  const at = message.lastIndexOf(CARRIED_CAUSE_LEAD);
  return at === -1 ? null : message.slice(at + CARRIED_CAUSE_LEAD.length) || null;
}

type StaleResetWriter = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

/**
 * THE stale-RUNNING reset write (#3462): one home for the bulk reset and the
 * per-row Mark failed, so the two can never record different codes - the
 * contact-create recovery and the booking page read this code back. Only the
 * `where` differs between them; neither touches the response payload or the
 * Xero object identity, which may be the only proof of what a dead run created.
 * The client is required: both callers write inside the transaction that also
 * writes their audit row.
 */
export async function writeStaleRunningXeroOperationReset(
  where: Prisma.XeroSyncOperationWhereInput,
  now: Date,
  lastErrorMessage: string,
  db: StaleResetWriter,
): Promise<number> {
  const result = await db.xeroSyncOperation.updateMany({
    where,
    data: {
      status: "FAILED",
      lastErrorCode: XERO_ORPHANED_STALE_RUNNING_ERROR_CODE,
      lastErrorMessage,
      completedAt: now,
    },
  });
  return result.count;
}

export interface MarkedStaleRunningXeroOperation {
  id: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  startedAt: Date;
  previousErrorCode: string | null;
  previousErrorMessage: string | null;
}

export type MarkStaleRunningXeroOperationFailedResult =
  | { outcome: "not-found" }
  | { outcome: "not-stale"; status: string }
  | { outcome: "marked"; operation: MarkedStaleRunningXeroOperation };

/**
 * #3462: the per-row **Mark failed** - the runbook's hand `UPDATE` as one
 * guarded write. Only a row the census reads as stale-RUNNING qualifies: the
 * same gate as the bulk reset and the health count, NOT the narrower "stale
 * and carrying an earlier error" signature of a stranded retry, because a row
 * whose worker died on its first attempt is stuck in exactly the same way and
 * needs exactly the same remedy.
 *
 * The write is status-guarded on the claim that was read (still RUNNING, still
 * that `startedAt`, still past the threshold), so a run that completed or
 * re-claimed the row in the meantime is never overwritten. The earlier error a
 * stranded retry left on the row is kept in the new message, because it is
 * usually the cause the operator has to fix before requeueing. Once FAILED, the
 * row's ordinary Retry / Requeue applies.
 *
 * `recordAudit` runs in the same transaction as the write, and is required, so
 * the state change commits with its audit row or not at all: an audit that
 * fails rolls the row back to RUNNING rather than leaving an unattributed
 * critical override behind a 500.
 */
export async function markStaleRunningXeroOperationFailed(
  operationId: string,
  recordAudit: (
    tx: Prisma.TransactionClient,
    operation: MarkedStaleRunningXeroOperation,
  ) => Promise<void>,
  now: Date = new Date(),
): Promise<MarkStaleRunningXeroOperationFailedResult> {
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      entityType: true,
      operationType: true,
      localModel: true,
      localId: true,
      lastErrorCode: true,
      lastErrorMessage: true,
    },
  });
  if (!row) return { outcome: "not-found" };
  if (!row.startedAt || !isStaleRunningXeroOperation(row, now)) {
    return { outcome: "not-stale", status: row.status };
  }

  const stale = staleRunningXeroOperationFilter(now);
  const cause = carriedStaleRunningCause(row);
  const message = `${STALE_RUNNING_MARK_FAILED_MESSAGE}${
    cause ? `${CARRIED_CAUSE_LEAD}${cause}` : ""
  }`;
  const operation: MarkedStaleRunningXeroOperation = {
    id: row.id,
    entityType: row.entityType,
    operationType: row.operationType,
    localModel: row.localModel,
    localId: row.localId,
    startedAt: row.startedAt,
    previousErrorCode: row.lastErrorCode,
    previousErrorMessage: row.lastErrorMessage,
  };
  const marked = await prisma.$transaction(async (tx) => {
    const count = await writeStaleRunningXeroOperationReset(
      {
        id: row.id,
        status: stale.status,
        startedAt: { equals: operation.startedAt, lt: stale.startedAt.lt },
      },
      now,
      message,
      tx,
    );
    if (count !== 1) return false;
    await recordAudit(tx, operation);
    return true;
  });
  if (!marked) {
    const current = await prisma.xeroSyncOperation.findUnique({
      where: { id: operationId },
      select: { status: true },
    });
    return current
      ? { outcome: "not-stale", status: current.status }
      : { outcome: "not-found" };
  }

  return { outcome: "marked", operation };
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

// test seam
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

export function canReplayXeroInboundEvent(
  event: { status: string; updatedAt?: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (event.status !== "PROCESSING") {
    return true;
  }

  const updatedAt =
    typeof event.updatedAt === "string" ? new Date(event.updatedAt) : event.updatedAt;
  if (updatedAt instanceof Date && Number.isNaN(updatedAt.getTime())) {
    return false;
  }

  return isStaleProcessingXeroInboundEvent(updatedAt, now);
}
