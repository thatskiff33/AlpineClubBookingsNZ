/**
 * #4516 (M4c; owner decision of 2 Nov 2026, `INV-PAY-122`): what a part "Paid another way" close left STILL OWED,
 * as the treasurer chose. A row of its own, born dead (attempts spent, so the runner never claims it), keyed by the
 * close's record: it keeps the rest in "Refunds owed" and on the dead card refund list, where a later close pays
 * it. The key doubles as its Stripe key prefix and its metadata reason, so it is never another row's request.
 */
export const CARD_REFUND_STILL_OWED_RECOVERY_PREFIX = "card_refund_still_owed_";
export function buildCardRefundStillOwedRecoveryKey(closeRecordId: string) {
  return `${CARD_REFUND_STILL_OWED_RECOVERY_PREFIX}${closeRecordId}`;
}
/** The part close a still-owed row carries forward; null for any other key. */
export function cardRefundStillOwedCloseRecordId(key: string): string | null {
  return key.startsWith(CARD_REFUND_STILL_OWED_RECOVERY_PREFIX) && key.length > CARD_REFUND_STILL_OWED_RECOVERY_PREFIX.length
    ? key.slice(CARD_REFUND_STILL_OWED_RECOVERY_PREFIX.length)
    : null;
}
/** Its Stripe metadata reason (`bookingModificationRefundReasonForKeyPrefix`). */
export const CARD_REFUND_STILL_OWED_REASON = "card_refund_still_owed";
