/**
 * The operation row an inbound webhook reconcile runs under (`INV-INT-038`,
 * the #4921 prerequisite).
 *
 * One ACTIVE row per correlation key (#1354). A process that dies mid-reconcile
 * leaves its INBOUND `WEBHOOK_RECONCILE` row RUNNING, and nothing reaps it: the
 * outbox and the waiting-invoice reaper read OUTBOUND rows only, and the stale
 * reset is an officer's. A later attempt for the same event used to be handed
 * that row by `startXeroSyncOperation`, abandoned claim (`startedAt`) and all,
 * so a late outcome of the abandoned attempt could still land on the row the
 * new attempt was running.
 *
 * Here a later attempt never shares a row. A RUNNING row past the stale
 * threshold is taken over in place under a fresh claim (a new `startedAt`) in
 * one guarded write, so of two racing attempts exactly one wins, and the
 * abandoned attempt's late outcome is refused by `outcomeWriteGuard`
 * (`INV-INT-029`): it names a claim no longer on the row. A live row is left to
 * its attempt; this one fails as in flight and the event is retried after its
 * backoff. Outbound rows never come here.
 */
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { XERO_ACTIVE_OPERATION_STATUSES } from "@/lib/xero-active-operation-statuses";
import { XERO_ORPHANED_STALE_RUNNING_ERROR_CODE } from "@/lib/xero-operation-error-codes";
import { isStaleRunningXeroOperation } from "@/lib/xero-stale-operations";
import { startXeroSyncOperation } from "@/lib/xero-sync";

const DIRECTION = "INBOUND";
const OPERATION_TYPE = "WEBHOOK_RECONCILE";

/** Rounds of insert-then-take-over before giving up: each lost round means another writer moved the row. */
const START_ROUNDS = 3;

const TAKEN_OVER_MESSAGE =
  "An earlier attempt at this inbound reconcile was abandoned RUNNING past the staleness threshold; this attempt took the operation over.";

/** Another attempt holds the event's operation row live, so this attempt does not run. */
export class XeroInboundReconcileInFlightError extends Error {
  readonly operationId: string | null;

  constructor(correlationKey: string, operationId: string | null) {
    super(`Another attempt is still reconciling Xero inbound event ${correlationKey}; it will be retried after its backoff.`);
    this.name = "XeroInboundReconcileInFlightError";
    this.operationId = operationId;
  }
}

export interface InboundReconcileOperationInput {
  entityType: string;
  correlationKey: string;
  requestPayload: unknown;
}

/**
 * Starts this attempt's claim on the event's operation row: a row it inserts,
 * or an abandoned one it takes over. Throws `XeroInboundReconcileInFlightError`
 * while another attempt's claim is live.
 */
export async function startInboundReconcileOperation(
  input: InboundReconcileOperationInput,
): Promise<XeroSyncOperation> {
  const { correlationKey } = input;
  let held: string | null = null;
  for (let round = 0; round < START_ROUNDS; round += 1) {
    try {
      return await startXeroSyncOperation({
        direction: DIRECTION,
        entityType: input.entityType,
        operationType: OPERATION_TYPE,
        correlationKey,
        replayable: true,
        requestPayload: input.requestPayload,
        shareActiveOperation: false,
      });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) throw error;
    }
    const active = await prisma.xeroSyncOperation.findFirst({
      where: { correlationKey, status: { in: [...XERO_ACTIVE_OPERATION_STATUSES] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    // It ended between the insert and the read: insert again.
    if (!active) continue;
    held = active.id;
    const now = new Date();
    if (active.direction !== DIRECTION || active.operationType !== OPERATION_TYPE || !isStaleRunningXeroOperation(active, now)) {
      throw new XeroInboundReconcileInFlightError(correlationKey, active.id);
    }
    const taken = await takeOverAbandonedOperation(active, now);
    if (taken) return taken;
    // Lost: another attempt took it over, or an officer's reset ended it. Read again.
  }
  throw new XeroInboundReconcileInFlightError(correlationKey, held);
}

/**
 * The takeover: one `updateMany` guarded on the abandoned claim exactly as read
 * (RUNNING under the stale `startedAt` read), so a racing takeover,
 * an officer's Mark failed or the abandoned attempt's own outcome, whichever
 * commits first, makes the others match nothing.
 */
async function takeOverAbandonedOperation(
  abandoned: XeroSyncOperation,
  now: Date,
): Promise<XeroSyncOperation | null> {
  const [taken] = await prisma.xeroSyncOperation.updateManyAndReturn({
    where: {
      id: abandoned.id,
      direction: DIRECTION,
      operationType: OPERATION_TYPE,
      status: "RUNNING",
      startedAt: abandoned.startedAt,
    },
    data: {
      startedAt: now,
      completedAt: null,
      attemptCount: { increment: 1 },
      lastErrorCode: XERO_ORPHANED_STALE_RUNNING_ERROR_CODE,
      lastErrorMessage: TAKEN_OVER_MESSAGE,
    },
  });
  if (!taken) return null;
  logger.warn(
    { operationId: taken.id, correlationKey: taken.correlationKey, abandonedClaimStartedAt: abandoned.startedAt },
    "Took over an abandoned Xero inbound reconcile operation under a fresh claim (INV-INT-038)",
  );
  return taken;
}
