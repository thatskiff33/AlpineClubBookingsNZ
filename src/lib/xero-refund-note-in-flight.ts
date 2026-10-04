import { prisma } from "@/lib/prisma";
import { XeroRefundCreditNoteInFlightError } from "@/lib/xero-applied-credit-operation-serialization";
import { XERO_REQUEUE_OPERATION_TYPE } from "@/lib/xero-hardening-shared";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { liveRunningXeroOperationFilter } from "@/lib/xero-stale-operations";

/**
 * #3880: ONE REFUND NOTE IN FLIGHT PER PAYMENT, from coverage read to record.
 *
 * A delta note sizes itself off the notes already RECORDED on the payment, and
 * keys its Xero create on the resulting watermark. Two runs that both read
 * before either records size alike - two $10 hand-backs both at watermark
 * $10 - and Xero's idempotency hands both the one $10 note, so $20 of cash has
 * a $10 document. Nothing repairs that for a bank transfer.
 *
 * Every run holds a RUNNING row on this payment before it reads anything: the
 * outbox row its worker claimed, or the operator's REQUEUE row
 * (`processQueuedXeroOperationRetries`). So each run writes (its claim) and
 * then reads (this check), and of two concurrent runs at least one sees the
 * other - a status-guarded claim, with no lock held across the Xero call. Both
 * seeing each other is safe: both wait. A row RUNNING past the stale threshold
 * (`STALE_RUNNING_XERO_OPERATION_MINUTES`) is a dead worker and does not block.
 *
 * Counted: refund-note creates (and legacy rows with no queue type, which
 * include an inline retry's own create) and REQUEUE rows on the payment's
 * credit notes. Account-credit notes size off different evidence and are not.
 */
export async function assertNoRefundCreditNoteInFlight(
  paymentId: string,
  ownOperationIds: ReadonlyArray<string | null | undefined>
): Promise<void> {
  const own = ownOperationIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  const inFlight = await prisma.xeroSyncOperation.findFirst({
    where: {
      ...(own.length > 0 ? { id: { notIn: own } } : {}),
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      localModel: "Payment",
      localId: paymentId,
      ...liveRunningXeroOperationFilter(),
      OR: [
        { operationType: "CREATE", queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE },
        { operationType: "CREATE", queueType: null },
        { operationType: XERO_REQUEUE_OPERATION_TYPE },
      ],
    },
    orderBy: { startedAt: "asc" },
    select: { id: true },
  });
  if (inFlight) throw new XeroRefundCreditNoteInFlightError(paymentId, inFlight.id);
}
