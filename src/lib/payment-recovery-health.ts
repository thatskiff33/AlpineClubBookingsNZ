import { prisma } from "@/lib/prisma";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";

// Issue #821: a payment-recovery operation that has FAILED with attempts at the
// maximum is terminal — the claim query requires attempts < MAX, so it will
// never be retried. These need manual operator reconciliation, but the health
// check previously only counted stale PENDING work, leaving exhausted failures
// invisible.
export async function countExhaustedPaymentRecoveryOperations(): Promise<number> {
  return prisma.paymentRecoveryOperation.count({
    where: {
      status: "FAILED",
      attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
    },
  });
}
