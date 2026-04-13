const CAPTURED_PAYMENT_STATUSES = new Set([
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

export interface BookingPaymentState {
  status: string;
  amountCents?: number | null;
  refundedAmountCents?: number | null;
}

export function hasCapturedPayment(
  payment: BookingPaymentState | null | undefined
): boolean {
  if (!payment || !CAPTURED_PAYMENT_STATUSES.has(payment.status)) {
    return false;
  }

  if (typeof payment.amountCents === "number") {
    return payment.amountCents > 0;
  }

  return true;
}

export function getRemainingRefundableCents(
  payment: BookingPaymentState | null | undefined
): number {
  if (!payment || !hasCapturedPayment(payment)) {
    return 0;
  }

  return Math.max(
    (payment.amountCents ?? 0) - (payment.refundedAmountCents ?? 0),
    0
  );
}
