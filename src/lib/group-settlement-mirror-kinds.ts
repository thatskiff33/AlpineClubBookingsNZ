import { isEditRefundHandBackTask, isRefundRequestHandBackTask } from "@/lib/manual-refund-task-settlement-rules";
import { editReviewRefundSettlementPayment } from "@/lib/booking-payment-state";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";

/**
 * #3949 (`INV-PAY-137`): THE HAND-BACKS THAT GO BACK TO THE GROUP ORGANISER on a
 * joiner's booking the organiser paid for by internet banking, by their kind and
 * key alone: an edit's refund (`INV-PAY-117`), an approved appeal's
 * (`INV-PAY-118`) and - owner decision, 22 Oct 2026 - the joiner's own
 * cancellation's, the ordinary keyless `CANCELLED_BOOKING_HAND_BACK` the paid
 * cancel raises (a part-payment review shares that kind but is never completed,
 * so never reaches a settlement route). Pure and client-safe: the completion's
 * route (`isGroupSettlementMirrorHandBack`) and the finance queue's payload ask
 * it, each beside `paidByOrganiserInternetBanking`.
 */
export function isGroupSettlementMirrorHandBackKind(task: {
  kind: string | null;
  occurrenceKey: string | null;
}): boolean {
  return (
    isEditRefundHandBackTask(task) ||
    isRefundRequestHandBackTask(task) ||
    (task.kind === "CANCELLED_BOOKING_HAND_BACK" && task.occurrenceKey === null)
  );
}

/**
 * #3949 review round 3 (`INV-PAY-137`): DOES A REFUND-DIRECTION EDIT REVIEW'S
 * SHARE GO TO THE GROUP ORGANISER? The payment its refund comes out of
 * (`editReviewRefundSettlementPayment`) is the child's own settle mirror on a
 * joiner's booking the organiser paid for by Internet Banking. The one test:
 * `chooseEditReviewSettlementRoute` takes the mirror route from it, and the
 * finance queue words the review for the organiser from it.
 */
export function reviewRefundGoesToGroupOrganiser(task: Parameters<typeof editReviewRefundSettlementPayment>[0] & {
  booking: Parameters<typeof editReviewRefundSettlementPayment>[0]["booking"] & { organiserSettled: boolean; parentBookingId: string | null };
}): boolean {
  const settlementPayment = editReviewRefundSettlementPayment(task);
  return settlementPayment !== null && settlementPayment.id === task.booking.payment?.id && paidByOrganiserInternetBanking({ ...task.booking, payment: task.booking.payment ?? null });
}
