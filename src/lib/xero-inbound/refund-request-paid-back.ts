import type { Prisma } from "@prisma/client";
import { COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE } from "@/lib/manual-refund-task-settlement-rules";
import { prisma } from "@/lib/prisma";

/**
 * #4215 (`INV-PAY-118`, `INV-ADDPAY-021`): the cash each payment's refund
 * requests were paid back, as their completions recorded it
 * (`COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE`). THE one reader of it: the
 * inbound repair that rebuilds a refunded total from the payment's Xero notes
 * adds it, and the booking repair tool takes it out of the cash a
 * cancellation's note answers, so the two give one answer.
 *
 * Never read from a request's own note (`REFUND_REQUEST_CREDIT_NOTE`): it may
 * still be queued or voided (#4195) while the cash stays paid back, and a
 * request completed before the booking had an invoice queues none at all. Never
 * attributed to the canonical note.
 */
export async function readRefundRequestPaidBackCentsByPaymentId(
  paymentIds: readonly string[],
  db: Pick<Prisma.TransactionClient, "manualRefundTask"> = prisma,
): Promise<Map<string, number>> {
  const centsByPaymentId = new Map<string, number>();
  if (paymentIds.length === 0) return centsByPaymentId;
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId: { in: [...paymentIds] }, ...COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE },
    select: { paymentId: true, amountCents: true },
  });
  for (const task of tasks) {
    if (task.paymentId === null) continue;
    centsByPaymentId.set(task.paymentId, (centsByPaymentId.get(task.paymentId) ?? 0) + Math.max(task.amountCents ?? 0, 0));
  }
  return centsByPaymentId;
}
