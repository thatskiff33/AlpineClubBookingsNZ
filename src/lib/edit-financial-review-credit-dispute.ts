/**
 * #5061 follow-up (`INV-PAY-154`): an officer review's account-credit route
 * refuses a booking whose captured card payment is under an OPEN or LOST Stripe
 * dispute. The bank is taking that money back, so a credit would pay the member
 * twice, as a disputed edit or cancel mints no credit either.
 *
 * Lifted out of `edit-financial-review-settlement.ts`, which chooses the
 * route: this is one pre-claim refusal with its own read, run inside the
 * caller's transaction before anything is claimed (`INV-PAY-051`).
 */
import type { Prisma } from "@prisma/client";

import { hasCapturedPayment, type BookingPaymentState } from "@/lib/booking-payment-state";
import { REVIEW_CREDIT_DISPUTED_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { paymentDisputedCaptureCents } from "@/lib/stripe-dispute-hold";

/**
 * The payment an account-credit share is allocated against: the booking's own
 * payment when it holds captured money, else none. Throws a 409 when an OPEN or
 * LOST dispute holds that payment.
 */
export async function reviewCreditAllocationPaymentId(
  store: Prisma.TransactionClient,
  bookingPayment: (BookingPaymentState & { id: string }) | null | undefined,
): Promise<string | null> {
  if (!bookingPayment || !hasCapturedPayment(bookingPayment)) return null;
  const payment = await store.payment.findUnique({
    where: { id: bookingPayment.id },
    select: { id: true, stripePaymentIntentId: true, additionalPaymentIntentId: true },
  });
  if (payment && (await paymentDisputedCaptureCents(store, payment)).cents > 0) {
    throw new ManualBookingPaymentError(REVIEW_CREDIT_DISPUTED_MESSAGE, 409);
  }
  return bookingPayment.id;
}
