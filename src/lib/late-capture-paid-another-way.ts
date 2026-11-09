import type { Prisma } from "@prisma/client";

import { CARD_REFUND_STILL_OWED_RECOVERY_PREFIX, cardRefundStillOwedCloseRecordId } from "@/lib/card-refund-still-owed-keys";
import { cardRefundStillOwedOrigin } from "@/lib/card-refund-still-owed-origin";
import { findLateCapturePaymentIntents, readPaidAnotherWayLateCaptureXeroReceipt } from "@/lib/late-capture-xero-receipt";
import {
  cardRefundPaidAnotherWayClosesWhere,
  paidAnotherWayCloseXeroNote,
  paymentRecoveryOperationIdOfPaidAnotherWay,
  type PaidAnotherWayXeroNote,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  buildLateCaptureApprovalRefundRecoveryIdempotencyKey,
  CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
  cardRefundFailedLaterRefundId,
  lateCaptureIntentOfApprovalRefundRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";

/**
 * #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit";
 * `INV-PAY-110`, `INV-PAY-122`): A LATE CARD CHARGE WHOSE APPROVED REFUND WAS
 * CLOSED AS PAID ANOTHER WAY.
 *
 * The treasurer approved refunding a late capture on a cancelled booking, every
 * Stripe retry failed, and they paid the member back by bank. The charge is
 * still in the Stripe account, so Xero records it as a receipt
 * (`decideLateCapture`: `refundClosedPaidAnotherWay`) and the bank transfer as
 * a refund note against it. These two reads join the capture and the close,
 * which share no column: the approval's card refund row is keyed on the
 * capture (`buildLateCaptureApprovalRefundRecoveryIdempotencyKey`, unique), and
 * the close's record on that row (`cardRefundPaidAnotherWayOccurrenceKey`).
 */

type CloseStore = Pick<Prisma.TransactionClient, "manualRefundTask" | "paymentRecoveryOperation">;

/** The record of the close of one late capture's approved refund, as its Xero steps read it. */
export interface LateCaptureRefundPaidAnotherWay {
  id: string;
  kind: string | null;
  occurrenceKey: string | null;
  paymentId: string | null;
  amountCents: number | null;
  completedAt: Date | null;
  completedByMemberId: string | null;
}

/**
 * #4104: the card refund rows a late capture's refund can be closed on - its
 * approval row, and a row owing a refund of it that Stripe failed later
 * (`card_refund_failed_later_<refund>`, on the capture's own intent) - so the
 * close keeps `INV-PAY-110`'s routing whichever row it was. #4516 (round-2
 * review A): and a still-owed rest of either (`card_refund_still_owed_<record>`,
 * carrying its origin's intent), kept only where its origin is that capture's
 * (`lateCaptureRefundOperations`).
 */
function lateCaptureRefundOperationsWhere(paymentIntentIds: readonly string[]) {
  return {
    OR: [
      { idempotencyKey: { in: paymentIntentIds.map((intent) => buildLateCaptureApprovalRefundRecoveryIdempotencyKey(intent)) } },
      { idempotencyKey: { startsWith: CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX }, paymentIntentId: { in: [...paymentIntentIds] } },
      { idempotencyKey: { startsWith: CARD_REFUND_STILL_OWED_RECOVERY_PREFIX }, paymentIntentId: { in: [...paymentIntentIds] } },
    ],
  };
}

/** Those rows, each with the capture it refunds: a still-owed rest's is asked of its origin, and one of another capture's is left out. */
async function lateCaptureRefundOperations(paymentIntentIds: readonly string[], store: CloseStore) {
  const rows = await store.paymentRecoveryOperation.findMany({
    where: lateCaptureRefundOperationsWhere(paymentIntentIds),
    select: { id: true, idempotencyKey: true, paymentIntentId: true },
  });
  const found: Array<{ id: string; intent: string }> = [];
  for (const row of rows ?? []) {
    const approved = lateCaptureIntentOfApprovalRefundRecoveryKey(row.idempotencyKey);
    const intent = approved ?? (cardRefundStillOwedCloseRecordId(row.idempotencyKey) === null
      ? row.paymentIntentId : await lateCaptureIntentOfCardRefundOperation(row, store));
    if (intent !== null && paymentIntentIds.includes(intent)) found.push({ id: row.id, intent });
  }
  return found;
}

/**
 * The late capture a card refund row refunds: an approval row's own capture,
 * or (#4104) a failed-later row's intent when that intent is a late capture.
 * #4516 review M4: a still-owed rest of either refunds the same capture, so it
 * is asked of the row the rest was first owed on (`cardRefundStillOwedOrigin`).
 * Null for any other row.
 */
export async function lateCaptureIntentOfCardRefundOperation(
  operation: { idempotencyKey: string; paymentIntentId?: string | null },
  store: Pick<Prisma.TransactionClient, "manualRefundTask" | "paymentRecoveryOperation"> = prisma,
): Promise<string | null> {
  const origin = await cardRefundStillOwedOrigin(store, operation.idempotencyKey);
  if (origin) return lateCaptureIntentOfCardRefundOperation(origin, store);
  const approved = lateCaptureIntentOfApprovalRefundRecoveryKey(operation.idempotencyKey);
  if (approved !== null) return approved;
  const intent = operation.paymentIntentId;
  if (!intent || cardRefundFailedLaterRefundId(operation.idempotencyKey) === null) return null;
  return (await findLateCapturePaymentIntents([intent], store)).has(intent) ? intent : null;
}

/**
 * Every close of this capture's approved card refund, oldest first (#4516 round-2 review A): a part close whose rest
 * stays owed is followed by a close of that rest, and each close's bank-transfer note is its own.
 */
export async function findLateCaptureRefundPaidAnotherWayCloses(
  paymentIntentId: string,
  store: CloseStore = prisma,
): Promise<LateCaptureRefundPaidAnotherWay[]> {
  const operations = await lateCaptureRefundOperations([paymentIntentId], store);
  if (operations.length === 0) return [];
  return store.manualRefundTask.findMany({
    where: cardRefundPaidAnotherWayClosesWhere(operations.map((operation) => operation.id)),
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      occurrenceKey: true,
      paymentId: true,
      amountCents: true,
      completedAt: true,
      completedByMemberId: true,
    },
  });
}

/** The first close of this capture's approved card refund, or null when it was never closed as paid another way. */
export async function findLateCaptureRefundPaidAnotherWay(
  paymentIntentId: string,
  store: CloseStore = prisma,
): Promise<LateCaptureRefundPaidAnotherWay | null> {
  return (await findLateCaptureRefundPaidAnotherWayCloses(paymentIntentId, store))[0] ?? null;
}

/**
 * #3924 round 7 (money M2): the same join for many captures at once, for the
 * Xero repair tool - by capture, how its approved refund's close is recorded in
 * Xero and when its approval task was raised (the capture day its receipt is
 * dated from). A capture never closed so is absent.
 */
export async function readLateCaptureRefundsPaidAnotherWay(
  paymentIntentIds: readonly string[],
  store: CloseStore = prisma,
): Promise<Map<string, { xeroRefundNote: PaidAnotherWayXeroNote; raisedAt: Date }>> {
  const found = new Map<string, { xeroRefundNote: PaidAnotherWayXeroNote; raisedAt: Date }>();
  if (paymentIntentIds.length === 0) return found;
  const intentByOperation = new Map((await lateCaptureRefundOperations(paymentIntentIds, store)).map((row) => [row.id, row.intent]));
  if (intentByOperation.size === 0) return found;
  const [closes, tasks] = await Promise.all([
    store.manualRefundTask.findMany({
      where: cardRefundPaidAnotherWayClosesWhere(intentByOperation.keys()),
      select: { kind: true, occurrenceKey: true },
    }),
    store.manualRefundTask.findMany({
      where: { lateCaptureApprovalIntentId: { in: [...paymentIntentIds] } },
      select: { lateCaptureApprovalIntentId: true, createdAt: true },
    }),
  ]);
  const raisedAtByIntent = new Map((tasks ?? []).map((task) => [task.lateCaptureApprovalIntentId, task.createdAt]));
  for (const close of closes ?? []) {
    const operationId = paymentRecoveryOperationIdOfPaidAnotherWay(close);
    const intent = operationId === null ? undefined : intentByOperation.get(operationId);
    const xeroRefundNote = paidAnotherWayCloseXeroNote(close);
    const raisedAt = intent === undefined ? undefined : raisedAtByIntent.get(intent);
    // #4516 (round-2 review A): of a capture's closes, one whose note still waits for the receipt says so.
    if (intent !== undefined && xeroRefundNote !== null && raisedAt !== undefined && found.get(intent)?.xeroRefundNote !== "after-receipt") {
      found.set(intent, { xeroRefundNote, raisedAt });
    }
  }
  return found;
}

type ReceiptGateStore = Pick<
  Prisma.TransactionClient,
  "manualRefundTask" | "paymentRecoveryOperation" | "xeroObjectLink" | "xeroSyncOperation"
>;

/**
 * Whether the late capture a close's card refund was refunding now has the
 * receipt the app recorded IN XERO (`readPaidAnotherWayLateCaptureXeroReceipt`, with its
 * invoice id). Asked of a close whose note waits for that receipt: until it is
 * in Xero, no refund note may answer the close's bank transfer. False for a
 * close that is not a late capture's.
 *
 * #3924 round 8 (money review): "recorded" is not enough. A change's released
 * supplementary invoice for the capture counts as the receipt from the moment
 * it is queued, but has no invoice for a note to credit until it is sent
 * (queued, sending, or FAILED and waiting for an officer's retry). Its note
 * waits for the invoice id like a receipt the close queued itself.
 */
export async function paidAnotherWayCloseReceiptRecorded(
  task: { kind: string | null; occurrenceKey: string | null },
  store: ReceiptGateStore,
): Promise<boolean> {
  const operationId = paymentRecoveryOperationIdOfPaidAnotherWay(task);
  if (operationId === null) return false;
  const operation = await store.paymentRecoveryOperation.findUnique({
    where: { id: operationId },
    select: { idempotencyKey: true, paymentIntentId: true },
  });
  const paymentIntentId = operation ? await lateCaptureIntentOfCardRefundOperation(operation, store) : null;
  if (paymentIntentId === null) return false;
  const receipt = await readPaidAnotherWayLateCaptureXeroReceipt(paymentIntentId, store);
  return receipt.kind === "recorded" && receipt.invoiceId !== null;
}
