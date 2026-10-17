/**
 * WHICH CARD CAPTURES A DUPLICATE-CAPTURE REFUND OWNS (#1992, #4211).
 *
 * The duplicate-capture refund (`markBookingPaymentSucceeded`) enqueues one
 * recovery operation per (booking, duplicate intent), keyed
 * `duplicate_capture_<bookingId>_<pi>`. A capture such a key names is going
 * back to the member, whatever the operation's status, so it is never the
 * capture that settled the booking. Two readers decide that, here:
 *
 * - guard (c) of the duplicate-capture refund: an arriving capture is refunded
 *   only against a settlement no such refund owns, so a replay of the settling
 *   capture keeps its money and a third capture is still refunded (#4211);
 * - the Xero second-instrument conflict (`findSecondInstrumentSettlement`),
 *   which never names an owned capture as the card side (#3638, #4163).
 *
 * Read under the lock(1) both callers already hold. Prisma-free at runtime (a
 * type import only), like `superseded-intent-ownership.ts`.
 */
import type { Prisma } from "@prisma/client";
import { exactPrefix } from "@/lib/prisma-exact-prefix";
import {
  buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking,
  duplicateCaptureIntentIdForRecoveryKey,
} from "@/lib/payment-recovery-keys";

type RecoveryOperationReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation">;

/**
 * The read itself: this booking's duplicate-capture refund operations. On the
 * booking's index, and the prefix matched literally (#4146): Prisma's
 * `startsWith` is `LIKE`, which reads a `_` in the booking id as any
 * character. Exported so the real-PostgreSQL proof repeats the exact read.
 */
export function duplicateCaptureRefundOperationWhere(bookingId: string) {
  return {
    bookingId,
    idempotencyKey: exactPrefix(buildDuplicateCaptureRefundRecoveryKeyPrefixForBooking(bookingId)),
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/** The intent ids of this booking's captures a duplicate-capture refund owns, at any status. */
export async function listDuplicateCaptureRefundIntentIds({
  bookingId,
  store,
}: {
  bookingId: string;
  store: RecoveryOperationReader;
}): Promise<string[]> {
  const operations = await store.paymentRecoveryOperation.findMany({
    where: duplicateCaptureRefundOperationWhere(bookingId),
    select: { idempotencyKey: true },
  });
  return operations.flatMap((operation) => {
    const intentId = duplicateCaptureIntentIdForRecoveryKey(bookingId, operation.idempotencyKey);
    return intentId ? [intentId] : [];
  });
}
