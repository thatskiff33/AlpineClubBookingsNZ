/**
 * #3827 (owner decision D-3813-6, `INV-PAY-117`): the refund half of a
 * "Booking Modified" email's money note, ONE wording for the HTML template and
 * the admin-editable body (`INV-SSOT`). A card refund has already been made by
 * the time the email goes; a bank-transfer refund is an officer task the club
 * has still to carry out, so it is promised rather than reported.
 */
export function bookingModifiedRefundSentence(
  amount: string,
  refundByBankTransfer: boolean,
  /**
   * #3916: a joiner's booking the group organiser paid for by card refunds its
   * reduction to the ORGANISER's card (#3653), not to anything the joiner paid
   * with. The edit's own settlement answer (`organiserChildRefund !== null`),
   * never recomputed here. Such a refund is a Stripe one, so never by hand.
   */
  refundReturnedToOrganiser: boolean,
): string {
  if (refundReturnedToOrganiser) {
    return `A refund of ${amount} has been processed to the group organiser's card, because the group organiser paid for this booking.`;
  }
  return refundByBankTransfer
    ? `The club will refund ${amount} to you by bank transfer.`
    : `A refund of ${amount} has been processed to your original payment method.`;
}

/**
 * #3827 (owner decision D-3813-7, `INV-PAY-118`): the refund sentence of a
 * "Refund Appeal Approved" email, ONE wording for the HTML template and the
 * admin-editable body's `{{refundSentence}}` (`INV-SSOT`). The part a card
 * refund carries is on its way; the part the club sends by bank transfer is an
 * officer task still to be done, so it is promised, the same way as an edit's.
 * `bankTransferCents` is the part of `approvedCents` the club sends by hand
 * (0 when the card carries it all).
 */
export function refundRequestApprovedRefundSentence(
  approvedCents: number,
  bankTransferCents: number,
  formatAmount: (cents: number) => string,
): string {
  const cardCents = approvedCents - bankTransferCents;
  if (bankTransferCents <= 0) {
    return `A refund of ${formatAmount(approvedCents)} will be processed to your original payment method.`;
  }
  if (cardCents <= 0) {
    return `The club will refund ${formatAmount(bankTransferCents)} to you by bank transfer.`;
  }
  return `A refund of ${formatAmount(cardCents)} will be processed to your original payment method, and the club will refund the remaining ${formatAmount(bankTransferCents)} to you by bank transfer.`;
}
