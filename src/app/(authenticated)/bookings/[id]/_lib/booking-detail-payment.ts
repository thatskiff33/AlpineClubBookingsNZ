import type { FeatureFlags } from "@/config/schema";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";
import {
  bookingAmountOwedCents,
  bookingWorthCents,
  hasCapturedPayment,
  recordedChangeFeeCents,
} from "@/lib/booking-payment-state";
import { refundAppealCeiling } from "@/lib/manual-refund-task-settlement-rules";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import {
  getNetCollectedCashParts,
  netCollectedPaymentTookMoney,
} from "@/lib/payment-net-collected";
import { savedPaymentMethodForBooking } from "@/lib/saved-payment-method";
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
  // #3924: a payment of money (`hasCapturedPayment`) that Net Collected's
  // capture rule also says took it (`netCollectedPaymentTookMoney`), the rule
  // the retained line below reads - not the status alone. A never-paid
  // Internet Banking payment a Xero credit note folded to PARTIALLY_REFUNDED
  // has no captured ledger row and took no money.
  const originalPaymentCaptured =
    booking.payment !== null &&
    hasCapturedPayment(booking.payment) &&
    netCollectedPaymentTookMoney(booking.payment);
  // #3811: what the club kept of what was paid is this booking's cash part of
  // Net Collected (`getNetCollectedCashParts`), so it can never read higher
  // than Net Collected counts: an open hand-back refund is taken off straight
  // away (owner decision on #3372, 3 Oct 2026), and shown beside the line.
  const retainedCash = booking.payment
    ? getNetCollectedCashParts({ ...booking.payment, booking })
    : null;
  const retainedAfterCancellationCents = retainedCash?.heldCashCents ?? 0;
  const handBackOwedAfterCancellationCents = retainedCash?.handBackOwedCents ?? 0;
  // #3924: the note that a refund is still being paid back by hand is for the
  // booker and officers, not a linked guest viewing the booking.
  const showHandBackOwedNote =
    handBackOwedAfterCancellationCents > 0 &&
    (isBookingOwner || canManageBooking || nonOwnerAdminViewer);
  const latestRefundAppeal = booking.refundRequests[0] ?? null;
  // #3827 (`INV-PAY-118`): net of every hand-back still promised back by bank
  // transfer and of the credit minted from late cash - the figure the appeal
  // route caps at.
  const maxRefundableCents = refundAppealCeiling(booking.payment, booking.creditsFromCancellation);
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
  // Shown exactly when the auto-charge cron would find nothing to charge
  // (#3266, #3269, epic #3270): `savedPaymentMethodForBooking` is the ONE answer
  // to "may this booking be charged off-session?" — the booking's own row first,
  // then its split parent's, each needing customer, card AND SetupIntent
  // (`INV-PAY-053`). Keyed on that rather than on "no SetupIntent yet" or on the
  // card column alone: an abandoned replacement or a card retired after a
  // Stripe refusal (#3268) leaves an intent id behind with nothing chargeable,
  // and a legacy split child can carry a copied card that was never saved
  // through a SetupIntent — both must show the form. The same const is returned
  // for the admin "Confirm pending guests" button's will-charge wording
  // (rendered by `_components/booking-admin-tools-section.tsx`), so the page can
  // never promise a charge while asking for a card, or the reverse.
  const savedCard = savedPaymentMethodForBooking({
    payment: booking.payment,
    parentBooking: booking.parentBooking,
  });
  const showSavePaymentMethodCard =
    isBookingOwner &&
    !isDeleted &&
    !internetBankingPayment &&
    booking.status === "PENDING" &&
    savedCard === null;
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
  // #3750: through the one home, so a change fee recorded on the payment is
  // part of what the page says is due.
  const amountDueAfterCreditCents = Math.max(
    bookingAmountOwedCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment?.changeFeeCents ?? null,
      appliedCreditCents: creditAppliedCents,
    }),
    0
  );
  // #3955 review F8: a change fee recorded on an unpaid booking's payment is
  // owed with the price, so the card shows it as its own row and the
  // breakdown adds up to the amount due.
  const changeFeeOwedCents =
    isPaymentOwedBookingStatus(booking.status) && booking.payment?.status !== "SUCCEEDED"
      ? recordedChangeFeeCents(booking.payment)
      : 0;
  const showAmountBreakdown = showCreditApplied || changeFeeOwedCents > 0;
  // What the pay card charges: net of credit only where the card says so.
  const cardAmountDueCents = showCreditApplied
    ? amountDueAfterCreditCents
    : bookingWorthCents({
        finalPriceCents: booking.finalPriceCents,
        changeFeeCents: booking.payment?.changeFeeCents ?? null,
      });

  return {
    cancellationSettlement,
    paymentDisplay,
    internetBankingPayment,
    canSwitchToInternetBanking,
    originalPaymentCaptured,
    retainedAfterCancellationCents,
    handBackOwedAfterCancellationCents,
    showHandBackOwedNote,
    latestRefundAppeal,
    maxRefundableCents,
    showGuestPaymentLinkStandalone,
    savedCard,
    showSavePaymentMethodCard,
    showPaymentOnHoldNotice,
    showCompletePaymentCard,
    creditAppliedCents,
    showCreditApplied,
    changeFeeOwedCents,
    showAmountBreakdown,
    amountDueAfterCreditCents,
    cardAmountDueCents,
  };
}

export type BookingDetailPayment = ReturnType<typeof resolveBookingDetailPayment>;
