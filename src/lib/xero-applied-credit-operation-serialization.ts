import { Prisma } from "@prisma/client";
import {
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
} from "./xero-operation-outbox-payload";
import { asRecord, readString } from "./xero-json";

/**
 * #3635 (orchestrator decision 1, `INV-INT-025`): an applied-credit allocation
 * or deallocation cannot be marked resolved in Xero. Fixing Xero by hand does
 * not bring the local credit-slice ledger back in line, and an unconverged
 * deallocation deliberately fences the booking's cancel, the hold-expiry cron
 * and credit writes (below) - a resolved one would fence them for good. These
 * rows stay retry-only. Read from the queue-type column, or the payload for a
 * row written before the column.
 */
export function isAppliedCreditLedgerOperation(operation: {
  queueType: string | null;
  requestPayload: unknown;
}): boolean {
  return readAppliedCreditLedgerQueueType(operation) !== null;
}

/** Which of the two applied-credit ledger types a row is, or null (#3635 N9). */
export function readAppliedCreditLedgerQueueType(operation: {
  queueType: string | null;
  requestPayload: unknown;
}):
  | typeof XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE
  | typeof XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE
  | null {
  const queueType =
    operation.queueType ?? readString(asRecord(operation.requestPayload)?.queueType);
  return queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE ||
    queueType === XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE
    ? queueType
    : null;
}

/**
 * A claimed applied-credit worker found another claimed operation for the same
 * Payment. The outbox treats this as transient contention and returns this
 * operation to PENDING instead of creating a durable FAILED dead-end.
 */
export class XeroAppliedCreditOperationBusyError extends Error {
  /**
   * #3791: the fencing deallocation's status, where a fence raised this. A
   * PENDING or RUNNING one converges by itself; FAILED or PARTIAL waits for an
   * operator to retry the Xero operation, and a caller telling a person what to
   * do next has to be able to tell the two apart.
   */
  readonly fenceStatus: string | null;

  constructor(message: string, fenceStatus: string | null = null) {
    super(message);
    this.name = "XeroAppliedCreditOperationBusyError";
    this.fenceStatus = fenceStatus;
  }
}

/** #3791: a fence only an operator's retry of the Xero operation clears. */
export function needsOperatorXeroRetry(error: XeroAppliedCreditOperationBusyError): boolean {
  return error.fenceStatus === "FAILED" || error.fenceStatus === "PARTIAL";
}

/**
 * A deallocation worker read a provider allocation state that is inconsistent
 * with the durable checkpoints only in a way explainable by Xero's eventual
 * (non read-after-write) consistency — e.g. a just-deleted allocation still
 * listed, or a just-created recreate not yet listed. This is transient and
 * self-heals once Xero converges, so it is a subclass of the busy error: the
 * outbox catch returns the row to PENDING for a bounded, backed-off retry
 * instead of stranding it FAILED (which would defer cancellation/IB-expiry
 * behind the unconverged fence). A mismatch NOT explainable by eventual
 * consistency stays a genuine, fail-closed terminal error.
 */
export class XeroAppliedCreditDeallocationEventualConsistencyError extends XeroAppliedCreditOperationBusyError {
  constructor(message: string) {
    super(message);
    this.name = "XeroAppliedCreditDeallocationEventualConsistencyError";
  }
}

/**
 * #3880 (`INV-PAY-111`): another refund credit note on this payment is being
 * sized, raised or recorded right now. A subclass of the applied-credit busy
 * error so the outbox treats it the same way: the row goes back to PENDING,
 * reason kept, and the next scan raises it once the other has recorded.
 */
export class XeroRefundCreditNoteInFlightError extends XeroAppliedCreditOperationBusyError {
  constructor(paymentId: string, inFlightOperationId: string) {
    super(
      `Refund credit note operation ${inFlightOperationId} on payment ${paymentId} is still running; this note waits for it to record before sizing`
    );
    this.name = "XeroRefundCreditNoteInFlightError";
  }
}

export function isXeroAppliedCreditOperationBusyError(
  error: unknown
): error is XeroAppliedCreditOperationBusyError {
  return error instanceof XeroAppliedCreditOperationBusyError;
}

/**
 * A cancel/expiry transition must not freeze its Xero clearing amount while a
 * queued deallocation still represents a newer local applied-credit target.
 * FAILED/PARTIAL remain blocking because provider and local slice state may
 * have diverged; an operator must retry the operation to COMPLETE it first.
 */
export async function findUnconvergedAppliedCreditDeallocation(
  paymentId: string,
  db: Prisma.TransactionClient,
): Promise<{ id: string; status: string } | null> {
  return db.xeroSyncOperation.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
      status: {
        in: ["PENDING", "RUNNING", "FAILED", "PARTIAL", "WAITING_PAYMENT"],
      },
    },
    select: { id: true, status: true },
  });
}

/**
 * Provider work is deliberately outside the member-ledger transaction. Once a
 * deallocation is RUNNING, or has failed after possibly changing Xero, local
 * writers must stop until that operation converges. Call this only while the
 * caller holds the member-credit ledger lock; that makes the worker's snapshot
 * and every competing mutation strictly ordered.
 *
 * A fresh PENDING row fences ordinary ledger writers because it represents a
 * clamp target that inbound provider truth must not undo. The allocation and
 * deallocation workers may explicitly allow an uncheckpointed PENDING row to
 * preserve queue ordering; checkpointed retries always remain fences.
 */
export async function findAppliedCreditDeallocationFence(
  paymentId: string,
  db: Prisma.TransactionClient,
  options?: {
    excludeOperationId?: string;
    allowUncheckpointedPending?: boolean;
  },
): Promise<{ id: string; status: string } | null> {
  const candidates = await db.xeroSyncOperation.findMany({
    where: {
      ...(options?.excludeOperationId
        ? { id: { not: options.excludeOperationId } }
        : {}),
      localModel: "Payment",
      localId: paymentId,
      queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
      status: {
        in: ["PENDING", "RUNNING", "FAILED", "PARTIAL", "WAITING_PAYMENT"],
      },
    },
    select: { id: true, status: true, requestPayload: true },
    orderBy: { createdAt: "asc" },
  });
  const fence = candidates.find((candidate) => {
    if (candidate.status !== "PENDING") return true;
    const payload =
      candidate.requestPayload &&
      typeof candidate.requestPayload === "object" &&
      !Array.isArray(candidate.requestPayload)
        ? (candidate.requestPayload as Record<string, unknown>)
        : null;
    const hasDurableProviderEvidence = Boolean(
      payload?.ledgerSnapshot || payload?.checkpoint || payload?.history,
    );
    return !options?.allowUncheckpointedPending || hasDurableProviderEvidence;
  });
  return fence ? { id: fence.id, status: fence.status } : null;
}

export async function assertNoAppliedCreditDeallocationFence(
  paymentId: string,
  db: Prisma.TransactionClient,
  options?: {
    excludeOperationId?: string;
    allowUncheckpointedPending?: boolean;
  },
): Promise<void> {
  const fence = await findAppliedCreditDeallocationFence(paymentId, db, options);
  if (fence) {
    throw new XeroAppliedCreditOperationBusyError(
      `Applied-credit deallocation ${fence.id} is ${fence.status} for payment ${paymentId}; converge it before changing applied credit`,
      fence.status,
    );
  }
}
