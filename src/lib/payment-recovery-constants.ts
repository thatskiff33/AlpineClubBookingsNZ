import type { PaymentRecoveryOperationStatus } from "@prisma/client";

// Shared payment-recovery constants kept in a dependency-light module so health
// and visibility code can reuse them without importing the full payment-recovery
// service (which pulls in Stripe and the email/transaction layers).

// A recovery operation is retried while attempts < this maximum; once attempts
// reach it the operation is terminal and will never be reclaimed.
export const MAX_PAYMENT_RECOVERY_ATTEMPTS = 5;

/**
 * IS A RECOVERY OPERATION STILL IN FLIGHT — will the runner still make it? The
 * one reading for every reader that asks (`INV-SSOT`; #3854 K1): `PENDING` and
 * `PROCESSING`, and a `FAILED` row with a retry still scheduled (`nextRetryAt`
 * set) and attempts left — the runner reclaims exactly those
 * (`CLAIMABLE_PAYMENT_RECOVERY_STATUSES` with `attempts < MAX`). A `FAILED` row
 * with no retry scheduled, or at the attempt ceiling, is DEAD: the money it was
 * to move will not move without a person, so it is never read as in flight.
 */
export function isPaymentRecoveryOperationInFlight(operation: {
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  nextRetryAt: Date | null;
}): boolean {
  if (operation.status === "PENDING" || operation.status === "PROCESSING") return true;
  return operation.status === "FAILED" && operation.nextRetryAt !== null && operation.attempts < MAX_PAYMENT_RECOVERY_ATTEMPTS;
}
