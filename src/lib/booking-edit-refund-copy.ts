import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

/**
 * The sentence a member reads when an edit's reduction was refunded to a card -
 * one home for the HTML "Booking Modified" email and its admin-editable flat
 * body (`{{paymentNote}}`), so the two cannot disagree about where the member's
 * money went (`INV-SSOT`).
 *
 * #3916: a joiner's booking that the group organiser paid for by card refunds
 * its reduction to the ORGANISER's card (#3653), not to anything the joiner
 * paid with, so "your original payment method" would tell the joiner to expect
 * money that went to someone else. `refundReturnedToOrganiser` is the edit's own
 * settlement answer (`organiserChildRefund !== null`), never recomputed here.
 */
export function editRefundNote(
  refundCents: number,
  refundReturnedToOrganiser: boolean,
  format: ClubFormat,
): string {
  return refundReturnedToOrganiser
    ? `A refund of ${formatCents(refundCents, format)} has been processed to the group organiser's card, because the group organiser paid for this booking.`
    : `A refund of ${formatCents(refundCents, format)} has been processed to your original payment method.`;
}
