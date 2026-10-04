/**
 * WHICH COMPLETED REFUND TASKS SEND THEIR MONEY BACK BY HAND — the one statement
 * of that route rule, read by `chooseEditReviewSettlementRoute` when a task is
 * completed and by the booking-ledger back-post (#3583) when it posts a
 * completed hand-back's line from history.
 */
import { ManualRefundTaskKind } from "@prisma/client";

/**
 * The `local-allocation` route: any kind but an edit review, not an approved
 * late capture (that goes back to the card), and on a payment.
 */
export function handsBackByHand(task: {
  kind: ManualRefundTaskKind | null;
  lateCaptureApprovalIntentId: string | null;
  paymentId: string | null;
}): boolean {
  return (
    task.kind !== ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW &&
    !task.lateCaptureApprovalIntentId &&
    task.paymentId !== null
  );
}
