import {
  BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
  REFUND_REQUEST_REFUND_RECOVERY_PREFIX,
  buildLegacyModificationRefundStripeKeyPrefix,
  buildRefundRequestRefundStripeKeyPrefix,
  isRefundRequestRefundRecoveryKey,
} from "@/lib/payment-recovery-keys";

/**
 * #4516 (M4c, `INV-SSOT`): the Stripe key prefix a card refund row's slices are sent under, the one rule the
 * recovery runner sends by and a "Paid another way" close reads to name the reservations it closes: a superseded
 * intent's row under its own key; an appeal's (#1507) and a cancellation's (#1494) under their inline prefix,
 * rebuilt from the row; every other under the prefix it stored (#1152), or, before that column, its operation's.
 */
export function cardRefundOperationStripeKeyPrefix(operation: {
  id: string; type: string; idempotencyKey: string; bookingId: string; stripeKeyPrefix: string | null;
}): string {
  if (operation.type === "REFUND_SUPERSEDED_PAYMENT") return operation.idempotencyKey;
  if (isRefundRequestRefundRecoveryKey(operation.idempotencyKey)) {
    return buildRefundRequestRefundStripeKeyPrefix(operation.idempotencyKey.slice(REFUND_REQUEST_REFUND_RECOVERY_PREFIX.length));
  }
  if (operation.idempotencyKey.startsWith(BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX)) return `booking_cancel_refund_${operation.bookingId}`;
  return operation.stripeKeyPrefix ?? buildLegacyModificationRefundStripeKeyPrefix(operation.id);
}
