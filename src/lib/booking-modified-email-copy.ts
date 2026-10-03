/**
 * #3827 (owner decision D-3813-6, `INV-PAY-113`): the refund half of a
 * "Booking Modified" email's money note, ONE wording for the HTML template and
 * the admin-editable body (`INV-SSOT`). A card refund has already been made by
 * the time the email goes; a bank-transfer refund is an officer task the club
 * has still to carry out, so it is promised rather than reported.
 */
export function bookingModifiedRefundSentence(amount: string, refundByBankTransfer: boolean): string {
  return refundByBankTransfer
    ? `The club will refund ${amount} to you by bank transfer.`
    : `A refund of ${amount} has been processed to your original payment method.`;
}
