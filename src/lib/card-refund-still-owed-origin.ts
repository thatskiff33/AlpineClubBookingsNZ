import type { Prisma } from "@prisma/client";

import { cardRefundStillOwedCloseRecordId } from "@/lib/card-refund-still-owed-keys";
import { paymentRecoveryOperationIdOfPaidAnotherWay } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #4516 review M4 (`INV-SSOT`): THE ROW A STILL-OWED REST WAS FIRST OWED ON. A part "Paid another way" close that
 * leaves the rest owed carries it to a row of its own (`card_refund_still_owed_<record>`), whose key names only the
 * close's record. Everything a reader decides from the row it came from - which debt it pays, whether it refunds a
 * late capture, whether a card note in Xero already answers a failed refund in it, whether it is the cancel's own
 * card part - is decided on that origin, followed back through each close (a still-owed rest can be part closed
 * again). Null for any other row, and where a link in the chain is gone.
 */
export const CARD_REFUND_STILL_OWED_ORIGIN_SELECT = {
  id: true,
  type: true,
  idempotencyKey: true,
  stripeKeyPrefix: true,
  bookingId: true,
  paymentId: true,
  paymentIntentId: true,
  amountCents: true,
  allocationPlan: true,
} as const;
export type CardRefundStillOwedOrigin = Prisma.PaymentRecoveryOperationGetPayload<{ select: typeof CARD_REFUND_STILL_OWED_ORIGIN_SELECT }>;

type OriginStore = Pick<Prisma.TransactionClient, "manualRefundTask" | "paymentRecoveryOperation">;

/** A chain longer than this is not one a treasurer made by hand: refused, never walked forever. */
const MAX_CLOSES = 20;

export async function cardRefundStillOwedOrigin(store: OriginStore, idempotencyKey: string): Promise<CardRefundStillOwedOrigin | null> {
  let key = idempotencyKey;
  for (let closes = 0; closes < MAX_CLOSES; closes += 1) {
    const recordId = cardRefundStillOwedCloseRecordId(key);
    if (recordId === null) return null;
    const record = await store.manualRefundTask.findUnique({ where: { id: recordId }, select: { kind: true, occurrenceKey: true } });
    const operationId = record ? paymentRecoveryOperationIdOfPaidAnotherWay(record) : null;
    if (!operationId) return null;
    const closed = await store.paymentRecoveryOperation.findUnique({ where: { id: operationId }, select: CARD_REFUND_STILL_OWED_ORIGIN_SELECT });
    if (!closed) return null;
    if (cardRefundStillOwedCloseRecordId(closed.idempotencyKey) === null) return closed;
    key = closed.idempotencyKey;
  }
  return null;
}
