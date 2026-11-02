// #3635 (`INV-INT-025`, orchestrator decision 3): what the "resolved in Xero"
// route must check before its mark may stand. Kept out of the route so the
// route stays a thin handler and the reads have one home.
import { XERO_ACTIVE_OPERATION_STATUSES } from "./xero-active-operation-statuses";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildXeroOperationRequeueCorrelationKey } from "@/lib/xero-operation-queue";
import { XERO_REQUEUE_OPERATION_TYPE } from "@/lib/xero-hardening-shared";
import { isStaleRunningXeroOperation } from "@/lib/xero-stale-operations";
import { isAppliedCreditLedgerOperation } from "@/lib/xero-applied-credit-operation-serialization";
import { holdsUnrecordedRefundNote } from "@/lib/xero-refund-note-in-flight";

type OperationReader = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

export interface ConflictingRetry {
  id: string;
  status: string;
  startedAt: Date | null;
}

/**
 * A queued retry of this operation that ran, or may have run, alongside a mark
 * written at `markAt`: one still RUNNING, or one that started at or before the
 * mark and completed at or after it (review N4) - a retry that read the row
 * before the mark and finished in the moments before this check. A retry that
 * stood down CANCELLED after the mark ran nothing, so it is not a conflict
 * unless it is still RUNNING.
 *
 * The one window left is clock skew between the instance that wrote the mark
 * and the one that stamped the retry's `startedAt`/`completedAt`.
 */
export async function findRetryOverlappingMark(
  operationId: string,
  markAt: Date,
  db: OperationReader = prisma,
): Promise<ConflictingRetry | null> {
  return db.xeroSyncOperation.findFirst({
    where: {
      correlationKey: buildXeroOperationRequeueCorrelationKey(operationId),
      operationType: XERO_REQUEUE_OPERATION_TYPE,
      OR: [
        { status: "RUNNING" },
        {
          status: { not: "CANCELLED" },
          startedAt: { lte: markAt },
          completedAt: { gte: markAt },
        },
      ],
    },
    select: { id: true, status: true, startedAt: true },
  });
}

/**
 * #4421 (concurrency review F1): a queued retry of this operation that could
 * have minted a document since `since` - the moment the resolve route read the
 * row. One still RUNNING, or one (not stood down) that started or completed at
 * or after it. Asked under the resolve's `lock(1)` BEFORE a mark that records
 * a hand-made note is written: a retry of a FAILED refund-note create runs on
 * its own REQUEUE row without claiming the original, so one that started and
 * finished while the route checked Xero and waited for the lock is missed by
 * `findRetryOverlappingMark` (not RUNNING, started after the read), and the
 * resolve would record the officer's note beside the note the retry raised.
 * `since` is a JS clock reading on the route's instance and the retry's
 * `startedAt`/`completedAt` are stamped by the drain's; clock skew between
 * instances is the one window left, as for `findRetryOverlappingMark`. A retry
 * that ran and SUCCEEDED earlier is `findSupersedingRefundNoteRun`'s.
 */
export async function findRetryRunningOrSince(
  operationId: string,
  since: Date,
  db: OperationReader = prisma,
): Promise<ConflictingRetry | null> {
  return db.xeroSyncOperation.findFirst({
    where: {
      correlationKey: buildXeroOperationRequeueCorrelationKey(operationId),
      operationType: XERO_REQUEUE_OPERATION_TYPE,
      OR: [
        { status: "RUNNING" },
        { status: { not: "CANCELLED" }, startedAt: { gte: since } },
        { status: { not: "CANCELLED" }, completedAt: { gte: since } },
      ],
    },
    select: { id: true, status: true, startedAt: true },
  });
}

/**
 * #4421 review (money, round 2): a run of this refund-note create that has
 * ALREADY raised its note, at any time - a queued retry of the row (REQUEUE)
 * that ended SUCCEEDED or PARTIAL, or another create on the payment with the
 * same correlation key that did (a FAILED row's retry replays on a new inline
 * row and never closes the original, which stays FAILED naming no note; the
 * failure overview calls it repaired, `succeededByCorrelation`). Resolving
 * the original with a hand-made note as well would leave two notes, and $400
 * of coverage, for one $200 refund.
 */
/**
 * The shape of a refund-note create on a payment that a run of the same note
 * could be (#4421): one definition for the single-row and the page reader.
 */
const PAYMENT_REFUND_NOTE_CREATE = {
  entityType: "CREDIT_NOTE",
  operationType: "CREATE",
  localModel: "Payment",
} as const;

export async function findSupersedingRefundNoteRun(
  operation: { id: string; correlationKey: string | null; localId: string | null },
  db: OperationReader = prisma,
): Promise<{ id: string } | null> {
  return db.xeroSyncOperation.findFirst({
    where: {
      id: { not: operation.id },
      status: { in: [...REFUND_NOTE_RAN_STATUSES] },
      OR: [
        { correlationKey: buildXeroOperationRequeueCorrelationKey(operation.id), operationType: XERO_REQUEUE_OPERATION_TYPE },
        ...(operation.correlationKey && operation.localId
          ? [{ ...PAYMENT_REFUND_NOTE_CREATE, correlationKey: operation.correlationKey, localId: operation.localId }]
          : []),
      ],
    },
    select: { id: true },
  });
}

/** The statuses of a run that raised its note. */
const REFUND_NOTE_RAN_STATUSES = ["SUCCEEDED", "PARTIAL"] as const;

/**
 * The same question, asked of a page of rows at once for the Xero operations
 * list (`resolveCreditNotePrompt`): which of these rows a run has already
 * superseded. Two reads, whatever the page size.
 */
export async function findSupersededRefundNoteRowIds(
  operations: Array<{ id: string; correlationKey: string | null; localId: string | null }>,
  db: OperationReader = prisma,
): Promise<Set<string>> {
  if (operations.length === 0) return new Set();
  const byRequeueKey = new Map(operations.map((operation) => [buildXeroOperationRequeueCorrelationKey(operation.id), operation.id]));
  const keyed = operations.filter((operation) => operation.correlationKey && operation.localId);
  const [requeues, creates] = await Promise.all([
    db.xeroSyncOperation.findMany({
      where: { operationType: XERO_REQUEUE_OPERATION_TYPE, status: { in: [...REFUND_NOTE_RAN_STATUSES] }, correlationKey: { in: [...byRequeueKey.keys()] } },
      select: { correlationKey: true },
    }),
    keyed.length === 0
      ? Promise.resolve([])
      : db.xeroSyncOperation.findMany({
          where: {
            ...PAYMENT_REFUND_NOTE_CREATE,
            status: { in: [...REFUND_NOTE_RAN_STATUSES] },
            correlationKey: { in: keyed.map((operation) => operation.correlationKey!) },
          },
          select: { id: true, correlationKey: true, localId: true },
        }),
  ]);
  const superseded = new Set<string>();
  for (const requeue of requeues) {
    const id = requeue.correlationKey ? byRequeueKey.get(requeue.correlationKey) : undefined;
    if (id) superseded.add(id);
  }
  for (const operation of keyed) {
    // Same key on the same payment, and not the row itself.
    if (creates.some((create) => create.id !== operation.id && create.correlationKey === operation.correlationKey && create.localId === operation.localId)) {
      superseded.add(operation.id);
    }
  }
  return superseded;
}

/** The refusal while a live copy of the same document is queued (#3635 review N3). */
export const QUEUED_LIVE_COPY_REFUSAL =
  "A new copy of this Xero document is queued. Wait for it to run or cancel it, then check Xero before resolving this one.";

/**
 * A live copy of the same document queued beside this operation (review N3):
 * same correlation key, still PENDING, RUNNING or WAITING_PAYMENT. Resolving
 * now would leave that copy to mint a second document. The outbox also
 * cancels such a copy after a resolve (`findResolvedSiblingSince`); this is the
 * cheap, earlier answer.
 *
 * #4692 review (`INV-INT-035`): a row holding an unrecorded refund note fences
 * its payment's refund notes, so a PENDING copy cannot mint while it stands -
 * it waits on the fence until this very resolve, and its next claim then
 * closes it CANCELLED, before any Xero call (`findResolvedSiblingSince`).
 * Refusing over it would leave the payment with no way out, so only a copy
 * running now counts against such a row.
 */
export async function findQueuedLiveCopy(
  operation: {
    id: string;
    correlationKey: string | null;
    entityType: string;
    operationType: string;
    lastErrorCode: string | null;
    manuallyResolvedAt: Date | null;
    xeroObjectId: string | null;
  },
  db: OperationReader = prisma,
): Promise<{ id: string } | null> {
  if (!operation.correlationKey) return null;
  const fenced = holdsUnrecordedRefundNote(operation);
  return db.xeroSyncOperation.findFirst({
    where: {
      id: { not: operation.id },
      correlationKey: operation.correlationKey,
      entityType: operation.entityType,
      operationType: operation.operationType,
      status: { in: XERO_ACTIVE_OPERATION_STATUSES.filter((status) => !fenced || status !== "PENDING") },
    },
    select: { id: true },
  });
}

/**
 * The officer-facing refusal while a retry is running (reviews N6, N7). It says
 * the mark was not kept, what to do if the retry stood down because of it, and
 * - when the retry looks stuck - where to reset it.
 */
export function retryRunningRefusal(
  retry: { status: string; startedAt: Date | null } | null,
  now: Date = new Date(),
): string {
  if (retry && isStaleRunningXeroOperation(retry, now)) {
    return "A retry of this Xero operation has been running for a long time and looks stuck. Use Reset stale running operations on the Xero operations screen, then check Xero before resolving it.";
  }
  return "A retry of this Xero operation is running, so it was not marked resolved. Wait for the retry to finish, then check Xero: if the retry stood down because of this attempt, nothing ran and you can resolve it again.";
}

/**
 * The resolve route's checks before any mark (moved here from the route,
 * #4421, so the route stays within its size budget): the refusal to answer,
 * or null when the row may be marked.
 */
export async function resolvePrecheckRefusal(operation: {
  id: string;
  status: string;
  startedAt: Date | null;
  queueType: string | null;
  requestPayload: unknown;
  correlationKey: string | null;
  entityType: string;
  operationType: string;
  lastErrorCode: string | null;
  manuallyResolvedAt: Date | null;
  xeroObjectId: string | null;
}): Promise<string | null> {
  // #3635 decision 3: a retry that claimed the operation itself.
  if (operation.status === "RUNNING") return retryRunningRefusal(operation);
  if (operation.status !== "FAILED" && operation.status !== "PARTIAL") {
    return "Only failed or partially-completed Xero operations can be resolved.";
  }
  // #3635 decision 1 (`INV-INT-025`): resolving does not converge the local
  // credit ledger, and a resolved deallocation would fence the booking's
  // cancel and credit writes for good.
  if (isAppliedCreditLedgerOperation(operation)) {
    return "An applied-credit allocation or deallocation cannot be marked resolved in Xero, because fixing Xero by hand does not bring the club's own credit ledger back in line. Retry it instead.";
  }
  // #3635 review N3: a live copy of the same document queued beside this one
  // would mint a second document after the mark (re-checked under the claim's
  // locks for a recorded note, #4421).
  if (await findQueuedLiveCopy(operation)) return QUEUED_LIVE_COPY_REFUSAL;
  return null;
}

/**
 * #3635 (`INV-INT-025`): the plain mark, status-guarded - the mirror of the
 * retry claims' `manuallyResolvedAt: null` guard, so a retry that claimed the
 * row after the route's read wins. True when this call wrote it.
 */
export async function claimResolvedInXeroMark(input: { id: string; resolvedAt: Date; reason: string; resolvedById: string }): Promise<boolean> {
  const claimed = await prisma.xeroSyncOperation.updateMany({
    where: { id: input.id, status: { in: ["FAILED", "PARTIAL"] }, manuallyResolvedAt: null },
    data: { manuallyResolvedAt: input.resolvedAt, manuallyResolvedReason: input.reason, manuallyResolvedById: input.resolvedById },
  });
  return claimed.count === 1;
}

/** #3635 decision 3: the plain mark taken back when a retry turned out to be running beside it. */
export async function withdrawResolvedInXeroMark(id: string, resolvedAt: Date): Promise<void> {
  await prisma.xeroSyncOperation.updateMany({
    where: { id, manuallyResolvedAt: resolvedAt },
    data: { manuallyResolvedAt: null, manuallyResolvedReason: null, manuallyResolvedById: null },
  });
}
