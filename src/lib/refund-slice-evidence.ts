// #4510 (`INV-PAY-147`): the slice evidence a keyed Stripe refund carries. One
// home for its wire name and its builder, so the sender, the preflight that
// reads it back and the owed-figure matcher cannot spell it apart.

/** Stripe refund evidence of the exact keyed slice (14 characters; limit 40). */
export const REFUND_SLICE_KEY_METADATA = "refundSliceKey";

/**
 * #4510 (`INV-PAY-147`): the metadata Stripe receives for one refund request.
 * Unstamped, the caller's own metadata, exactly as before slice evidence; stamped,
 * that metadata plus `refundSliceKey`, the request's own idempotency key. A
 * stamp with no key is refused, so the evidence can never name another key.
 */
export function refundRequestStripeMetadata({ metadata, idempotencyKey, stampRefundSliceKey }: {
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  stampRefundSliceKey?: boolean;
}): Record<string, string> {
  if (!stampRefundSliceKey) return metadata ?? {};
  if (!idempotencyKey) throw new Error("A refund slice key stamp needs the request's idempotency key (INV-PAY-147)");
  return { ...metadata, [REFUND_SLICE_KEY_METADATA]: idempotencyKey };
}
