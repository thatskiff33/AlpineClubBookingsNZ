// #4104 (#4128 review C5): the booking-vs-Xero repair tool's read of card
// refunds Stripe failed later, moved out of `xero-booking-repair-load.ts`
// (#4215) to keep that loader within its size budget.
import { PaymentRecoveryOperationStatus } from "@prisma/client";
import { CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX } from "./payment-recovery-keys";
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import type { RepairDependencies } from "./xero-booking-repair-deps";

/**
 * #4104 (#4128 review C5): the cents a card refund Stripe failed later is still
 * owed by a row of its own (`card_refund_failed_later_<refund>`, unsettled), by
 * payment then by charge. The late-capture finding leaves them out: the row
 * asks Stripe for them again, or the treasurer closes it as paid another way,
 * and an offer to refund them here too would refund them twice.
 */
export async function loadFailedLaterOwedCents(
  deps: Pick<RepairDependencies, "prisma">,
  paymentIds: readonly string[],
): Promise<Map<string, Map<string, number>>> {
  const owed = new Map<string, Map<string, number>>();
  if (paymentIds.length === 0) return owed;
  const rows =
    (await deps.prisma.paymentRecoveryOperation.findMany({
      where: {
        paymentId: { in: [...paymentIds] },
        idempotencyKey: { startsWith: CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX },
        status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      },
      select: { paymentId: true, idempotencyKey: true, allocationPlan: true },
    })) ?? [];
  for (const row of rows) {
    if (!row.idempotencyKey?.startsWith(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX)) continue;
    const byTransaction = owed.get(row.paymentId) ?? new Map<string, number>();
    for (const slice of parseRefundAllocationPlan(row.allocationPlan) ?? []) {
      byTransaction.set(slice.paymentTransactionId, (byTransaction.get(slice.paymentTransactionId) ?? 0) + slice.amountCents);
    }
    owed.set(row.paymentId, byTransaction);
  }
  return owed;
}
