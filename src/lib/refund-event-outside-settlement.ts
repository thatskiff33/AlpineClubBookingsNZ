/**
 * REFUNDED EVENTS THAT ARE NOT THE BOOKING'S OWN SETTLEMENT — the one list.
 *
 * The booking narrative takes the first REFUNDED or CREDITED event as a later
 * cancellation's settlement sentence. Three refunds are recorded as REFUNDED
 * events and are nothing of the kind, so each is excluded here:
 *
 *  - #2008: the #1992 duplicate-capture auto-refund, which settles a SECOND
 *    capture on an already-paid booking;
 *  - #3340: a capture against an intent a later edit had already replaced,
 *    refunded by the recovery queue;
 *  - #3827 (`INV-PAY-114`): an edit's refund the treasurer sent back by hand
 *    while the booking was live.
 *
 * Pure, like the three predicates it composes, so the narrative resolver can
 * import it without pulling the database client into its bundle.
 */
import { isDuplicateCaptureRefundEvent } from "@/lib/duplicate-capture-refund-event";
import { isNonCancellationHandBackCompletedEvent } from "@/lib/manual-refund-task-settlement-rules";
import { isSupersededAdditionalRefundEvent } from "@/lib/superseded-additional-refund-event";

type RefundEvent = Parameters<typeof isDuplicateCaptureRefundEvent>[0] &
  Parameters<typeof isSupersededAdditionalRefundEvent>[0];

export function isRefundOutsideBookingSettlement(event: RefundEvent): boolean {
  return (
    isDuplicateCaptureRefundEvent(event) ||
    isSupersededAdditionalRefundEvent(event) ||
    isNonCancellationHandBackCompletedEvent(event)
  );
}
