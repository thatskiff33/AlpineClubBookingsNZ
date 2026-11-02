import type { Prisma, XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  XeroRefundCreditNoteInFlightError,
  XeroRefundCreditNoteUnrecordedError,
} from "@/lib/xero-applied-credit-operation-serialization";
import { XERO_REQUEUE_OPERATION_TYPE } from "@/lib/xero-hardening-shared";
import { XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE } from "@/lib/xero-operation-error-codes";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { liveRunningXeroOperationFilter } from "@/lib/xero-stale-operations";

/**
 * The rows that can drive a credit note on ONE payment: outbound credit-note
 * operations scoped to it. Both refund-note fences filter from this shape - the
 * in-flight guard below and the link repair's blocking-row read
 * (`findBlockingRefundCreditNoteOperationId`) - each with its own statuses.
 */
export function paymentCreditNoteOperationWhere(paymentId: string) {
  return {
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    localModel: "Payment",
    localId: paymentId,
  } as const satisfies Prisma.XeroSyncOperationWhereInput;
}

/**
 * #3880: ONE REFUND NOTE IN FLIGHT PER PAYMENT, from coverage read to record.
 *
 * A delta note sizes itself off the notes already RECORDED on the payment, and
 * keys its Xero create on the resulting watermark. Two runs that both read
 * before either records size alike - two $10 hand-backs both at watermark
 * $10 - and Xero's idempotency hands both the one $10 note, so $20 of cash has
 * a $10 document. Nothing repairs that for a bank transfer.
 *
 * Every run holds a RUNNING row on this payment before it reads anything: the
 * outbox row its worker claimed, or the operator's REQUEUE row
 * (`processQueuedXeroOperationRetries`). So each run writes (its claim) and
 * then reads (this check), and of two concurrent runs at least one sees the
 * other - a status-guarded claim, with no lock held across the Xero call. Both
 * seeing each other is safe: both wait. A row RUNNING past the stale threshold
 * (`STALE_RUNNING_XERO_OPERATION_MINUTES`) is a dead worker and does not block.
 *
 * Counted: refund-note creates (and legacy rows with no queue type, which
 * include an inline retry's own create) and REQUEUE rows on the payment's
 * credit notes. Account-credit notes size off different evidence and are not.
 */
export async function assertNoRefundCreditNoteInFlight(
  paymentId: string,
  ownOperationIds: ReadonlyArray<string | null | undefined>
): Promise<void> {
  const own = ownOperationIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const inFlight = await prisma.xeroSyncOperation.findFirst({
    where: {
      ...(own.length > 0 ? { id: { notIn: own } } : {}),
      ...paymentCreditNoteOperationWhere(paymentId),
      ...liveRunningXeroOperationFilter(),
      OR: [
        { operationType: "CREATE", queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE },
        { operationType: "CREATE", queueType: null },
        { operationType: XERO_REQUEUE_OPERATION_TYPE },
      ],
    },
    orderBy: { startedAt: "asc" },
    select: { id: true },
  });
  if (inFlight) throw new XeroRefundCreditNoteInFlightError(paymentId, inFlight.id);
}

/**
 * #4688 (`INV-INT-028`): the payment's refund-note create rows whose note Xero
 * made but the record could not write (`record-wait-lost`): stamped
 * `XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE` by `recordCreatedRefundNote`, not
 * resolved by hand, and still naming no note. Whatever its status or age - the stale threshold that ends
 * the in-flight hold above does not end this one - such a row means Xero holds a
 * note the coverage reads leave out, so no refund note on the payment may be
 * sized until an officer's Resolve by hand records it (or takes the refund over).
 * The resolve's own claim sets `manuallyResolvedAt`, which is what lifts it; a
 * withdrawn resolve puts it back, as the note is unrecorded again. Mark failed
 * and a stale reset keep the code (`writeStaleRunningXeroOperationReset`).
 */
export function unrecordedRefundNoteOperationWhere(paymentId: string) {
  return {
    ...paymentCreditNoteOperationWhere(paymentId),
    operationType: "CREATE",
    OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }],
    lastErrorCode: XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE,
    manuallyResolvedAt: null,
    xeroObjectId: null,
  } as const satisfies Prisma.XeroSyncOperationWhereInput;
}

/** #4688: the payment's oldest refund-note create whose note is unrecorded, or null. */
export async function findUnrecordedRefundNoteOperation(
  paymentId: string,
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation"> = prisma,
): Promise<{ id: string } | null> {
  return db.xeroSyncOperation.findFirst({
    where: unrecordedRefundNoteOperationWhere(paymentId),
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

/**
 * #4688: no refund note is raised on a payment while Xero holds one of its
 * notes unrecorded. Asked by every refund-note create (`createXeroCreditNote`,
 * whatever its mode) before it sizes or mints; the busy error holds the row in
 * PENDING, as an in-flight note does, until the officer resolves the
 * unrecorded one. Read without a lock, as the in-flight check is. The stamp
 * lands as the record gives up; before that, its row holds others back only as
 * a live claim (younger than the stale threshold) - a stated limit.
 */
export async function assertNoUnrecordedRefundNote(paymentId: string): Promise<void> {
  const unrecorded = await findUnrecordedRefundNoteOperation(paymentId);
  if (unrecorded) throw new XeroRefundCreditNoteUnrecordedError(paymentId, unrecorded.id);
}

/** #4688: why Retry refuses the row whose own note is unrecorded. */
export const UNRECORDED_REFUND_NOTE_RETRY_REASON =
  "Xero made this operation's refund credit note, but the app could not record it. Do not retry: a retry is sized without that note and could raise a second one. Resolve this operation by hand with that note's number (the alert and the error message name it).";

/**
 * #4688: the row itself holds an unrecorded note - the fence's predicate on
 * one row (`unrecordedRefundNoteOperationWhere`), for `getXeroOperationRetryMeta`.
 * The code is stamped only on a payment refund-note create row.
 */
export function holdsUnrecordedRefundNote(row: {
  lastErrorCode?: string | null;
  manuallyResolvedAt: Date | null;
  xeroObjectId: string | null;
}): boolean {
  return row.lastErrorCode === XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE && row.manuallyResolvedAt === null && row.xeroObjectId === null;
}

/**
 * #4688: Retry (single, Requeue and Retry all) refuses a payment refund-note
 * create that would raise a note while the payment holds an unrecorded one -
 * that row itself, or any other, such as the original a retry ran for. A row
 * that already records its note is the #3548 repair leg, which raises none,
 * and passes. Null when the retry may go ahead.
 */
export async function unrecordedRefundNoteRetryRefusal(
  operation: Pick<XeroSyncOperation, "id" | "direction" | "entityType" | "operationType" | "localModel" | "localId" | "queueType" | "xeroObjectId">,
): Promise<string | null> {
  if (
    operation.direction !== "OUTBOUND" ||
    operation.entityType !== "CREDIT_NOTE" ||
    operation.operationType !== "CREATE" ||
    operation.localModel !== "Payment" ||
    !operation.localId ||
    (operation.queueType !== null && operation.queueType !== XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE) ||
    operation.xeroObjectId !== null
  ) {
    return null;
  }
  const unrecorded = await findUnrecordedRefundNoteOperation(operation.localId);
  if (!unrecorded) return null;
  return unrecorded.id === operation.id
    ? UNRECORDED_REFUND_NOTE_RETRY_REASON
    : `Xero made a refund credit note on this payment that operation ${unrecorded.id} could not record. A retry now is sized without it and could raise a second note: resolve operation ${unrecorded.id} by hand with that note's number first, then retry this one.`;
}
