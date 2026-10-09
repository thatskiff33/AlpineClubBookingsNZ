import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

/**
 * #3809: the sentence a member reads when a change gave back account credit
 * the booking had used - one home for the HTML "Booking Modified" email and its
 * admin-editable flat body (`{{paymentNote}}`), so the two cannot disagree
 * about the member's money (`INV-SSOT`). Empty where nothing came back, so it
 * composes into the note without a dangling sentence.
 */
export function appliedCreditGiveBackNote(givenBackCents: number, format: ClubFormat): string {
  return givenBackCents > 0
    ? `${formatCents(givenBackCents, format)} of the account credit used for this booking has been returned to your account credit.`
    : "";
}

/**
 * #3954 (review round 4): the sentence for an edit whose price drop cancelled
 * the member's unpaid extra payment outright - the one outcome no other note
 * names, so the member is told the request they may still be holding is gone.
 * One home for the HTML template and the admin-editable body. A SHRUNK ask is
 * the ordinary "an additional payment of $X is required" note, at its new figure.
 */
export function unpaidAskCancelledNote(cancelled: boolean): string {
  return cancelled ? "The extra payment we asked for has been cancelled." : "";
}
