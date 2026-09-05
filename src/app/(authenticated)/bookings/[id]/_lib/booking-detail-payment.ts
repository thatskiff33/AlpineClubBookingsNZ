import type { FeatureFlags } from "@/config/schema";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import type { BookingDetailRecord } from "./load-booking-detail";
import type { BookingDetailViewer } from "./booking-detail-viewer";
import type { BookingDetailEditAccess } from "./booking-detail-edit-access";
import type { BookingDetailLinkedParty } from "./booking-detail-linked-party";

/**
 * WHERE THE MONEY STANDS (#2958): the payment projection every payment card
 * and the cancellation outcome read — the settlement breakdown, the display
 * status, the internet-banking record, the switch-at-pay gate, the refundable
 * remainder, the applied credit and the amount due, and which of the member's
 * pay doors is open. Pure: every figure is derived from the loaded payment row
 * by the canonical helpers; nothing here settles, captures or refunds. The
 * server routes behind each card re-derive their own conditions.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export function resolveBookingDetailPayment({
  booking,
  modules,
  viewer,
  access,
  party,
}: {
  booking: BookingDetailRecord;
  modules: FeatureFlags;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
  party: BookingDetailLinkedParty;
}) {
  const { canManageBooking, isBookingOwner, nonOwnerAdminViewer } = viewer;
  const { isDeleted } = access;
  const { hasProvisionalChildren, isProvisionalChild, isFlaggedProvisional } =
    party;
  const cancellationSettlement = booking.payment
    ? getCancellationSettlementBreakdown(
        booking.payment.refundedAmountCents,
        booking.creditsFromCancellation
      )
    : null;
  const paymentDisplay = booking.payment
    ? getPaymentDisplayStatus({
        bookingStatus: booking.status,
        paymentStatus: booking.payment.status,
        refundedAmountCents: booking.payment.refundedAmountCents,
        credits: booking.creditsFromCancellation,
      })
    : null;
  const internetBankingPayment =
    booking.payment?.source === "INTERNET_BANKING" ? booking.payment : null;
  // Switch-at-pay: a card PAYMENT_PENDING booking can move to Internet Banking
  // when the module is on (an organiser-settled or already-IB booking cannot).
  const canSwitchToInternetBanking =
    modules.xeroIntegration &&
    modules.internetBankingPayments &&
    !isDeleted &&
    canManageBooking &&
    !internetBankingPayment &&
    booking.status === "PAYMENT_PENDING" &&
    !booking.organiserSettled &&
    booking.finalPriceCents > 0;
  const originalPaymentCaptured = hasCapturedPayment(booking.payment);
  const retainedAfterCancellationCents = booking.payment
    ? Math.max(
        booking.payment.amountCents - booking.payment.refundedAmountCents,
        0
      )
    : 0;
  const latestRefundAppeal = booking.refundRequests[0] ?? null;
  const maxRefundableCents = getRemainingRefundableCents(booking.payment);
  // #1967: once the member's own place is settled by Internet Banking there is
  // no card on file for the later guest charge, so keep the guest-payment-link
  // affordance visible AFTER the switch too (the pre-switch warning below only
  // renders while the switch button is still available). Owner-only: the copy
  // is second-person and the emailed link goes to the member.
  const showGuestPaymentLinkStandalone =
    !isDeleted &&
    isBookingOwner &&
    hasProvisionalChildren &&
    Boolean(internetBankingPayment) &&
    booking.status !== "CANCELLED";

  // Issue #777: a provisional/on-hold PENDING booking shows no pay control,
  // which left testers unsure whether one should exist. The "Save Payment
  // Method" card below already explains the save-card flow, so the on-hold
  // explanation is only needed when that card is not showing.
  // Member self-service "Save Payment Method" card (#1303): gated positively on
  // the booking owner so a non-owner admin never sees it. An admin entering
  // their own card on a member's booking is a footgun with no legitimate use,
  // and the owner-positive gate is robust to read-only admin viewers (#1289).
  const showSavePaymentMethodCard =
    isBookingOwner &&
    !isDeleted &&
    !internetBankingPayment &&
    booking.status === "PENDING" &&
    (!booking.payment || !booking.payment.stripeSetupIntentId);
  // Suppress when a more specific provisional banner already explains the
  // on-hold/no-charge state (the split-booking child and the bumped-guest
  // flagged-provisional notices both render near the top of the page). Also
  // suppress for any non-owner admin-type viewer: the notice is owner-second-
  // person ("your place/your guests/your stay"), so a Full Admin, Booking
  // Officer, or read-only admin viewing someone else's booking never sees it
  // (#1303/#1289). nonOwnerAdminViewer subsumes the earlier actingAsAdmin case.
  const showPaymentOnHoldNotice =
    !isDeleted &&
    !nonOwnerAdminViewer &&
    booking.status === "PENDING" &&
    !showSavePaymentMethodCard &&
    !isProvisionalChild &&
    !isFlaggedProvisional;

  // The Stripe payment card and the payment-required banner render under the
  // same condition so the banner can never point at a missing card. Member
  // self-service "Complete Payment" (#1303): gated positively on the booking
  // owner so a non-owner admin never sees the member pay/banner controls.
  const showCompletePaymentCard =
    isBookingOwner &&
    !isDeleted &&
    !internetBankingPayment &&
    isPaymentOwedBookingStatus(booking.status) &&
    (!booking.payment || booking.payment.status !== "SUCCEEDED");

  // Issue #778: surface auto-applied member credit (display only). Credit nets
  // off the booking price, so amount due = finalPriceCents - creditAppliedCents.
  const creditAppliedCents = booking.payment?.creditAppliedCents ?? 0;
  const showCreditApplied =
    canManageBooking &&
    creditAppliedCents > 0 &&
    isPaymentOwedBookingStatus(booking.status) &&
    booking.payment?.status !== "SUCCEEDED";
  const amountDueAfterCreditCents = Math.max(
    booking.finalPriceCents - creditAppliedCents,
    0
  );

  return {
    cancellationSettlement,
    paymentDisplay,
    internetBankingPayment,
    canSwitchToInternetBanking,
    originalPaymentCaptured,
    retainedAfterCancellationCents,
    latestRefundAppeal,
    maxRefundableCents,
    showGuestPaymentLinkStandalone,
    showSavePaymentMethodCard,
    showPaymentOnHoldNotice,
    showCompletePaymentCard,
    creditAppliedCents,
    showCreditApplied,
    amountDueAfterCreditCents,
  };
}

export type BookingDetailPayment = ReturnType<typeof resolveBookingDetailPayment>;
