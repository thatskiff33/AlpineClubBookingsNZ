import type { Prisma } from "@prisma/client";

import { hasXeroReceiptForLateCapture } from "@/lib/late-capture-xero-receipt";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  cardRefundPaidAnotherWayOccurrenceKey,
  paidAnotherWayCloseXeroNote,
  paymentRecoveryOperationIdOfPaidAnotherWay,
  type PaidAnotherWayXeroNote,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  buildLateCaptureApprovalRefundRecoveryIdempotencyKey,
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

/** The close of this capture's approved card refund, or null when it was never closed as paid another way. */
export async function findLateCaptureRefundPaidAnotherWay(
  paymentIntentId: string,
  store: CloseStore = prisma,
): Promise<LateCaptureRefundPaidAnotherWay | null> {
  const operation = await store.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildLateCaptureApprovalRefundRecoveryIdempotencyKey(paymentIntentId) },
    select: { id: true },
  });
  if (!operation) return null;
  return store.manualRefundTask.findFirst({
    where: {
      ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
      occurrenceKey: { in: closeKeysOf(operation.id) },
    },
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

/** Every key a close of this card refund row can carry, one per way its note is raised. */
function closeKeysOf(operationId: string): string[] {
  return (["now", "after-receipt", "none"] as const).map((xeroRefundNote) =>
    cardRefundPaidAnotherWayOccurrenceKey(operationId, { xeroRefundNote }),
  );
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
  const intentByKey = new Map(
    paymentIntentIds.map((intent) => [buildLateCaptureApprovalRefundRecoveryIdempotencyKey(intent), intent]),
  );
  const operations = await store.paymentRecoveryOperation.findMany({
    where: { idempotencyKey: { in: [...intentByKey.keys()] } },
    select: { id: true, idempotencyKey: true },
  });
  const intentByOperation = new Map((operations ?? []).map((row) => [row.id, intentByKey.get(row.idempotencyKey)]));
  if (intentByOperation.size === 0) return found;
  const [closes, tasks] = await Promise.all([
    store.manualRefundTask.findMany({
      where: { ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, occurrenceKey: { in: [...intentByOperation.keys()].flatMap(closeKeysOf) } },
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
    if (intent !== undefined && xeroRefundNote !== null && raisedAt !== undefined) {
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
 * receipt the app recorded in Xero (`hasXeroReceiptForLateCapture`). Asked of a
 * close whose note waits for that receipt: until it is in Xero, no refund note
 * may answer the close's bank transfer. False for a close that is not a late
 * capture's.
 */
export async function paidAnotherWayCloseReceiptRecorded(
  task: { kind: string | null; occurrenceKey: string | null },
  store: ReceiptGateStore,
): Promise<boolean> {
  const operationId = paymentRecoveryOperationIdOfPaidAnotherWay(task);
  if (operationId === null) return false;
  const operation = await store.paymentRecoveryOperation.findUnique({
    where: { id: operationId },
    select: { idempotencyKey: true },
  });
  const paymentIntentId = operation ? lateCaptureIntentOfApprovalRefundRecoveryKey(operation.idempotencyKey) : null;
  return paymentIntentId !== null && hasXeroReceiptForLateCapture(paymentIntentId, store);
}
