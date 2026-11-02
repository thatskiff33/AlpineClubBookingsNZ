import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  buildReissuedAskStripeIdempotencyKey,
} from "@/lib/payment-recovery-keys";

/**
 * #4693 (review of PR #4698): whether a recovery row still names its re-issue
 * door's key (`queueReissuedAskRecovery`) - its edit, read from its own key,
 * gives a door key equal to the intent the row names. The door mints under that
 * key before any attempt claims the row, so the close-time sweep runs whatever
 * the row's attempts; and an ordinary ask's replay never adopts for such a row
 * (`couldRecoveryRowOwnIntent`). The one rule for both (`INV-SSOT`).
 */
export function rowNamesReissuedAskDoorKey(row: { idempotencyKey: string; paymentIntentId: string }): boolean {
  const editId = bookingModificationIdForAdditionalIntentRecoveryKey(row.idempotencyKey);
  return editId !== null && row.paymentIntentId === buildReissuedAskStripeIdempotencyKey(editId);
}
