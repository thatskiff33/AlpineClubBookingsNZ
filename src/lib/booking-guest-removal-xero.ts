import type { RemoveBookingGuestResult } from "@/lib/booking-guest-removal-service";
import { queueXeroBookingEditSettlement } from "@/lib/xero-booking-edit-settlement";

/**
 * What a committed guest removal hands its Xero leg: the figures the removal's
 * own transaction decided, never a re-read.
 */
export type GuestRemovalXeroSettlement = Pick<
  RemoveBookingGuestResult,
  | "bookingModificationId"
  | "hasIssuedXeroInvoice"
  | "paymentStatus"
  | "priceDiffCents"
  | "xeroRefundAmountCents"
  | "settlementMethod"
  | "hasSucceededPayment"
  | "appliedCreditGivenBackCents"
  | "xeroAdditionalAmountCents"
  | "zeroDollarAutoPaid"
> & { bookingId: string };

export function guestRemovalXeroSettlement(result: RemoveBookingGuestResult): GuestRemovalXeroSettlement {
  return {
    bookingId: result.booking.id,
    bookingModificationId: result.bookingModificationId,
    hasIssuedXeroInvoice: result.hasIssuedXeroInvoice,
    paymentStatus: result.paymentStatus,
    priceDiffCents: result.priceDiffCents,
    xeroRefundAmountCents: result.xeroRefundAmountCents,
    settlementMethod: result.settlementMethod,
    hasSucceededPayment: result.hasSucceededPayment,
    appliedCreditGivenBackCents: result.appliedCreditGivenBackCents,
    xeroAdditionalAmountCents: result.xeroAdditionalAmountCents,
    zeroDollarAutoPaid: result.zeroDollarAutoPaid,
  };
}

/**
 * THE XERO LEG OF EVERY GUEST REMOVAL (#3809), after its commit: the member's
 * or an officer's own removal (`DELETE …/guests/[guestId]`) and a member
 * guest's consent decline or expiry alike, so a removal that lowers the price
 * reaches Xero whichever door it came through - the policy-limited reduction
 * note, the applied credit given back, the supplementary invoice of an increase.
 * Before #3809 the consent doors queued nothing, and Xero kept the old price.
 */
export function queueGuestRemovalXeroSettlement(
  settlement: GuestRemovalXeroSettlement,
  {
    createdByMemberId,
    additionalPaymentIntentId,
  }: {
    createdByMemberId: string | undefined;
    /** The additional PaymentIntent a Stripe-collected increase was minted, or null. */
    additionalPaymentIntentId: string | null;
  },
) {
  return queueXeroBookingEditSettlement({
    bookingId: settlement.bookingId,
    bookingModificationId: settlement.bookingModificationId,
    createdByMemberId,
    hasIssuedXeroInvoice: settlement.hasIssuedXeroInvoice,
    originalPaymentStatus: settlement.paymentStatus,
    priceDiffCents: settlement.priceDiffCents,
    changeFeeCents: 0,
    datesChanged: false,
    // Policy-limited settlement amount + method so a captured-payment
    // reduction issues the correct (card vs credit) modification credit
    // note; an unpaid issued invoice falls back to the full delta inside
    // classifyXeroBookingEditSettlement when this is null.
    settlementAmountCents: settlement.xeroRefundAmountCents,
    settlementMethod: settlement.settlementMethod,
    refundedThroughStripe: settlement.hasSucceededPayment,
    appliedCreditGiveBackCents: settlement.appliedCreditGivenBackCents,
    // A Stripe-collected increase must not double-bill through Xero: hold
    // the supplementary invoice's payment recording on the Stripe intent,
    // exactly as the batch flow does.
    requiresAdditionalStripePayment:
      settlement.xeroAdditionalAmountCents > 0 && settlement.hasSucceededPayment,
    additionalPaymentIntentId,
    createPrimaryInvoiceWhenMissing:
      settlement.zeroDollarAutoPaid && !settlement.hasIssuedXeroInvoice,
  });
}
