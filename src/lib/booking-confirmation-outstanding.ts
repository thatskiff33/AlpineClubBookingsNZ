/**
 * #2397: a settled booking whose upward change the club has not yet collected,
 * as a booking confirmation states it ("Still Owing"). Without it a
 * confirmation rendered from the booking as it stands would say the member
 * paid the new, higher worth in full.
 *
 * One rule for the two confirmations rendered from the booking as it is NOW
 * (`INV-SSOT-001`): an officer's fresh copy (`booking-fresh-email-copy.ts`)
 * and the paid confirmation, which since #5433 may go hours after the payment
 * when it is recovered by a later run (`paid-booking-confirmation-email.ts`).
 * Not payable online: the club's own chase sends the member to the right door,
 * so the confirmation under-promises rather than naming one that may not open.
 */
import { isAdditionalPaymentOwed, type AdditionalPaymentOwedInput } from "@/lib/additional-payment-chase";

export function confirmationOutstandingBalance(booking: {
  status: AdditionalPaymentOwedInput["bookingStatus"];
  payment: AdditionalPaymentOwedInput["payment"];
}): { amountCents: number; payableOnline: false } | null {
  if (!isAdditionalPaymentOwed({ bookingStatus: booking.status, payment: booking.payment })) return null;
  const amountCents = booking.payment?.additionalAmountCents ?? 0;
  return amountCents > 0 ? { amountCents, payableOnline: false } : null;
}
