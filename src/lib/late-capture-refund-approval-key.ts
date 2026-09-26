/**
 * #3639: the `occurrenceKey` of the ONE treasurer-approval task a late capture on
 * a cancelled booking can raise. Keyed on the payment intent — the same identity
 * every other record of that capture uses — and required for the
 * `LATE_CAPTURE_REFUND_APPROVAL` kind by the CHECK in migration 20261013010000,
 * so the unique index is a real duplicate fence rather than one NULL can walk
 * around.
 *
 * A pure leaf, so the webhook side and the confirm route's #2700 raise can both
 * ask for it without importing each other.
 */
const PREFIX = "late-capture-refund-approval:v1:";

export function lateCaptureRefundApprovalOccurrenceKey(
  paymentIntentId: string,
): string {
  return `${PREFIX}${paymentIntentId}`;
}

/** The inverse, for the completion: which capture is this task about? */
export function paymentIntentIdFromLateCaptureApprovalKey(
  occurrenceKey: string | null,
): string | null {
  if (!occurrenceKey?.startsWith(PREFIX)) return null;
  const paymentIntentId = occurrenceKey.slice(PREFIX.length);
  return paymentIntentId.length > 0 ? paymentIntentId : null;
}
