/**
 * #4145 (`INV-SSOT`): THE REASON A MEMBER CANCEL'S CARD REFUND EVENT CARRIES,
 * and how the narrative finds that event again.
 *
 * The REFUNDED event is written by whichever close moves the cancel's card
 * refund row (`booking_cancel_refund_recovery_<booking>`) to `SUCCEEDED` - the
 * cancel's own close after its inline refund, or the recovery runner's after a
 * replay (`closeRefundRowRecordingEvent`). Both write this one sentence. The
 * runner rebuilds its figures from the cancel's CANCELLED snapshot, which froze
 * them with the decision.
 *
 * Pure: the booking narrative reads `isCancelCardRefundEvent`, and it must stay
 * importable without Prisma.
 */
import { BookingEventType } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

/**
 * #4125: the REFUNDED reason of a capacity race's card refund, written by the
 * close that made it. Here, not in `booking-events.ts`, so the pure narrative
 * can tell a capacity race's card parts by it (#4145).
 */
export const CAPACITY_RACE_REFUND_EVENT_REASON = "Automatic refund after lodge capacity was no longer available.";

/**
 * #3653: the reason of the one REFUNDED event that IS a cancellation - an organiser's group cancel releasing a joiner
 * whose settled beds it refunded writes it instead of a CANCELLED event (`group-cancel.ts`). Matched against stored
 * rows (#5197, `manual-refund-task-reopen.ts`), so a reword adds the old string beside it rather than replacing it.
 */
export const GROUP_CANCEL_SETTLED_REFUND_EVENT_REASON =
  "Group organiser cancelled the booking; the settled beds were refunded to the organiser.";

/** Every cancel card refund reason ends so, before #4145 and since. */
const CANCEL_CARD_REFUND_REASON_END = "refunded to the original payment method.";

/**
 * `refundPercentage` and `refundAmountCents` are the cancel's policy refund;
 * `cardRefundCents` what the card refund carries - less, on a card refund
 * shortfall (#4097), where the sentence says it is a part. With no policy
 * figures (a cancel whose CANCELLED snapshot is missing), it names the amount.
 */
export function cancelCardRefundEventReason({
  cardRefundCents,
  policy,
  shortfall,
  format,
}: {
  cardRefundCents: number;
  policy: { refundPercentage: number; refundAmountCents: number } | null;
  shortfall: boolean;
  format: ClubFormat;
}): string {
  if (!policy) return `${formatCents(cardRefundCents, format)} ${CANCEL_CARD_REFUND_REASON_END}`;
  return shortfall
    ? `${formatCents(cardRefundCents, format)} of the ${policy.refundPercentage}% refund (${formatCents(policy.refundAmountCents, format)}) ${CANCEL_CARD_REFUND_REASON_END}`
    : `${policy.refundPercentage}% ${CANCEL_CARD_REFUND_REASON_END}`;
}

/**
 * The member cancel's card refund event, told from the hand-back completions a
 * card refund shortfall also records as REFUNDED (`manual_refund_completed`).
 */
export function isCancelCardRefundEvent(event: { type: BookingEventType; reason: string | null }): boolean {
  return event.type === BookingEventType.REFUNDED && (event.reason?.endsWith(CANCEL_CARD_REFUND_REASON_END) ?? false);
}

/**
 * #4145 (`INV-PAY-134`): the snapshot a "Paid another way" close leaves on the
 * REFUNDED event it writes for the slices Stripe had already made - a member
 * cancel's or a capacity race's. The narrative splits a paid-another-way
 * refund only by an event carrying it: an up-front event a cancel wrote before
 * #4145 was written whatever became of the refund, and proves nothing.
 */
export const MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT = { kind: "card_refund_made_before_paid_another_way" } as const;

/** The REFUNDED event a "Paid another way" close wrote for the part Stripe had made. */
export function isMadeBeforePaidAnotherWayEvent(event: { type: BookingEventType; snapshot: unknown }): boolean {
  return (
    event.type === BookingEventType.REFUNDED &&
    typeof event.snapshot === "object" &&
    event.snapshot !== null &&
    (event.snapshot as { kind?: unknown }).kind === MADE_BEFORE_PAID_ANOTHER_WAY_SNAPSHOT.kind
  );
}
