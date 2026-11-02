import type { Prisma, XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  XeroRefundCreditNoteInFlightError,
  XeroRefundCreditNoteUnrecordedError,
} from "@/lib/xero-applied-credit-operation-serialization";
import { XERO_REQUEUE_OPERATION_TYPE } from "@/lib/xero-hardening-shared";
import { XERO_REFUND_NOTE_AWAITING_RESOLVE_CODE, XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE } from "@/lib/xero-operation-error-codes";
import { asRecord, readString } from "@/lib/xero-json";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { isRefundCreditNoteLinkCancelledInXero } from "@/lib/xero-refund-note-status";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  findResolvedSiblingSince,
  isRefundNoteCreateRow,
  REFUND_NOTE_CREATE_QUEUE_TYPES,
  REFUND_NOTE_CREATE_ROW,
  resolvedSiblingCopySkippedPayload,
} from "@/lib/xero-resolved-in-xero-fences";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { completeXeroSyncOperation } from "@/lib/xero-sync";
import { liveRunningXeroOperationFilter } from "@/lib/xero-stale-operations";
import { scanSpacesWaitCode } from "@/lib/xero-operation-wait-spacing";

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
 * #4688: a payment refund-note create row, as the fence reads one - the
 * resolved-coverage reader's population (`isRefundNoteCreateRow`, `INV-SSOT`)
 * on a payment, and a refund's note: an inline account-credit row has a null
 * queue type too (#4692 review).
 */
function isPaymentRefundNoteCreateRow(row: Pick<XeroSyncOperation, "direction" | "entityType" | "operationType" | "localModel" | "localId" | "queueType" | "requestPayload">): row is typeof row & { localId: string } {
  return isRefundNoteCreateRow(row) && !!row.localId && parsePaymentCreditNoteRetryInput(row)?.kind === "refund";
}

/**
 * #4688 (`INV-INT-035`): the payment's refund-note create rows stamped
 * `XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE` by `recordCreatedRefundNote`, not
 * resolved by hand, and still naming no note - whatever their status or age
 * (the stale threshold that ends the in-flight hold above does not end this
 * one). The candidates of the fence; `findUnrecordedRefundNoteOperation`
 * drops one whose note is since recorded on the payment by another row.
 * The resolve's own claim sets `manuallyResolvedAt`; a withdrawn resolve puts
 * it back, as the note is unrecorded again. Mark failed and a stale reset keep
 * the code (`writeStaleRunningXeroOperationReset`).
 */
export function unrecordedRefundNoteOperationWhere(paymentId: string) {
  return { ...stampedRefundNoteRowsWhere(paymentId), manuallyResolvedAt: null, xeroObjectId: null } as const satisfies Prisma.XeroSyncOperationWhereInput;
}

/** The payment's refund-note create rows a record ever stamped, resolved since or not. */
function stampedRefundNoteRowsWhere(paymentId: string) {
  return {
    ...REFUND_NOTE_CREATE_ROW,
    localId: paymentId,
    OR: REFUND_NOTE_CREATE_QUEUE_TYPES.map((queueType) => ({ queueType })),
    lastErrorCode: XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE,
  } as const satisfies Prisma.XeroSyncOperationWhereInput;
}

/** #4692 review: the response-payload key the stamp names its note under (`recordCreatedRefundNote`). */
const UNRECORDED_CREDIT_NOTE_ID_KEY = "unrecordedCreditNoteId" as const;

/**
 * #4692 review: the response payload the stamp writes, naming the Xero note it
 * holds unrecorded, so the fence lifts once that note is recorded on the
 * payment some other way (`findUnrecordedRefundNoteOperation`). The stamp
 * reaches only a row naming no note, whose response payload holds nothing.
 */
export function unrecordedNoteStampPayload(creditNoteId: string) {
  return { [UNRECORDED_CREDIT_NOTE_ID_KEY]: creditNoteId } satisfies Prisma.InputJsonObject;
}

function readStampedNoteId(responsePayload: unknown): string | null {
  return readString(asRecord(responsePayload)?.[UNRECORDED_CREDIT_NOTE_ID_KEY]);
}

/**
 * #4692 review (F4): the note a row's stamp names, while the row still holds
 * it unrecorded (`holdsUnrecordedRefundNote`), or null - so Resolve by hand
 * can record that very note on the row once another row has recorded it on
 * the payment, rather than refuse it for good.
 */
export function stampedUnrecordedNoteId(row: Parameters<typeof holdsUnrecordedRefundNote>[0] & { responsePayload: unknown }): string | null {
  return holdsUnrecordedRefundNote(row) ? readStampedNoteId(row.responsePayload) : null;
}

/**
 * #4692 review: the stamped row's note is now recorded on the payment by
 * something else - the officer resolved ANOTHER row (the original a retry ran
 * for) with it, or a retry recorded it - so the coverage reads count it and
 * the fence has nothing left to hold. A link on the payment naming the note
 * that is live, or whose recorded Xero status says it was voided or deleted
 * (nothing to leave out then). A link a withdrawn resolve retired is neither:
 * the note is unrecorded again and the fence stays. A stamp written before
 * the row named its note (or naming none) is never lifted this way.
 */
async function noteNowRecordedOnPayment(
  paymentId: string,
  responsePayload: unknown,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<boolean> {
  const creditNoteId = readStampedNoteId(responsePayload);
  if (!creditNoteId) return false;
  const links = await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: creditNoteId },
    select: { active: true, metadata: true },
  });
  return links.some((link) => link.active || isRefundCreditNoteLinkCancelledInXero(link.metadata));
}

/** #4688: the payment's oldest refund-note create whose note is unrecorded, or null. */
export async function findUnrecordedRefundNoteOperation(
  paymentId: string,
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation" | "xeroObjectLink"> = prisma,
): Promise<{ id: string } | null> {
  // One after the other (#1357): the stamped rows are few, usually one.
  const stamped = await db.xeroSyncOperation.findMany({
    where: unrecordedRefundNoteOperationWhere(paymentId),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, responsePayload: true },
  });
  for (const row of stamped) {
    if (!(await noteNowRecordedOnPayment(paymentId, row.responsePayload, db))) return { id: row.id };
  }
  return null;
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

/**
 * #4692 review (F2): the fence as a refund-note create passes it, before it
 * sizes or mints. A resolve of the row holding the fence is not refused over a
 * PENDING copy of its document (`findQueuedLiveCopy`), and the outbox's own
 * check for such a copy (`findResolvedSiblingSince`, at the claim) can run
 * before the mark lands; a plain resolve (a refund request's note) then holds
 * no lock the create waits on and records no link its coverage would read. Past
 * `assertNoUnrecordedRefundNote`, a fence lifted by a resolve means the mark
 * has committed, so where the payment has such a resolved row the check is
 * asked again here: a copy queued before the resolve closes CANCELLED, as the
 * outbox closes one (`"closed"`); otherwise `"open"`. Where no resolved row
 * ever held the fence, nothing more is read.
 */
export async function passUnrecordedRefundNoteFence(paymentId: string, claim: XeroOperationClaim | null): Promise<"closed" | "open"> {
  await assertNoUnrecordedRefundNote(paymentId);
  if (!claim) return "open";
  const resolvedFence = await prisma.xeroSyncOperation.findMany({
    where: { ...stampedRefundNoteRowsWhere(paymentId), manuallyResolvedAt: { not: null }, id: { not: claim.id } },
    select: { id: true },
    take: 1,
  });
  if (resolvedFence.length === 0) return "open";
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: claim.id },
    select: { id: true, correlationKey: true, entityType: true, operationType: true, createdAt: true },
  });
  const resolvedSibling = row ? await findResolvedSiblingSince(row) : null;
  if (!resolvedSibling) return "open";
  await completeXeroSyncOperation(claim, { status: "CANCELLED", responsePayload: resolvedSiblingCopySkippedPayload(resolvedSibling.id) });
  return "closed";
}

/**
 * #4692 review (finding 1): how long a note held by the fence is left out of
 * the outbox scan and the retry drain before it is looked at again. It returns
 * to PENDING with its `createdAt` unchanged, and may wait days for the
 * resolve, so without this it would take the head of every oldest-first scan
 * - every `limit: 1` kick, and with ten such rows every cron run.
 */
export const REFUND_NOTE_AWAITING_RESOLVE_RECHECK_MS = 5 * 60 * 1000;

/**
 * The scan's filter, as `outboxScanLeavesAwaitingOwnNote` is: leave out a row
 * returned to wait on the fence until its recheck is due. Every other row - a
 * null code included, which `not` alone would drop - is scanned as before.
 */
export function scanSpacesRefundNotesAwaitingResolve(now: Date) {
  return scanSpacesWaitCode(XERO_REFUND_NOTE_AWAITING_RESOLVE_CODE, REFUND_NOTE_AWAITING_RESOLVE_RECHECK_MS, now);
}

/** #4688: why Retry refuses the row whose own note is unrecorded. */
export const UNRECORDED_REFUND_NOTE_RETRY_REASON =
  "Xero made this operation's refund credit note, but the app could not record it. Do not retry: a retry is sized without that note and could raise a second one. Resolve this operation by hand with that note's number (the alert and the error message name it).";

/**
 * #4688: the row itself holds an unrecorded note - the fence's predicate
 * (`unrecordedRefundNoteOperationWhere`) on one row, for
 * `getXeroOperationRetryMeta`, the resolve guards and the record's alert. The
 * code is stamped only on a payment refund-note create row.
 */
export function holdsUnrecordedRefundNote(row: {
  lastErrorCode?: string | null;
  manuallyResolvedAt: Date | null;
  xeroObjectId: string | null;
}): boolean {
  const fence = unrecordedRefundNoteOperationWhere("");
  return row.lastErrorCode === fence.lastErrorCode && row.manuallyResolvedAt === fence.manuallyResolvedAt && row.xeroObjectId === fence.xeroObjectId;
}

/**
 * #4688: Retry (single, Requeue and Retry all) refuses a payment refund-note
 * create that would raise a note while the payment holds an unrecorded one -
 * that row itself, or any other, such as the original a retry ran for. A row
 * that already records its note is the #3548 repair leg, which raises none,
 * and passes; so does an account-credit note. Null when the retry may go ahead.
 */
export async function unrecordedRefundNoteRetryRefusal(
  operation: Pick<XeroSyncOperation, "id" | "direction" | "entityType" | "operationType" | "localModel" | "localId" | "queueType" | "requestPayload" | "xeroObjectId">,
): Promise<string | null> {
  if (!isPaymentRefundNoteCreateRow(operation) || operation.xeroObjectId !== null) return null;
  const unrecorded = await findUnrecordedRefundNoteOperation(operation.localId);
  if (!unrecorded) return null;
  return unrecorded.id === operation.id
    ? UNRECORDED_REFUND_NOTE_RETRY_REASON
    : `Xero made a refund credit note on this payment that operation ${unrecorded.id} could not record. A retry now is sized without it and could raise a second note: resolve operation ${unrecorded.id} by hand with that note's number first, then retry this one.`;
}
