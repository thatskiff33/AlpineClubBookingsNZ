import type { BoundClubTime } from "@/lib/club-time";
import type { FeatureFlags } from "@/config/schema";
import type { EmailMessageSettings } from "@/lib/email-message-settings";
import type { EffectiveBookingMessageMap } from "@/lib/booking-message-settings";
import type { getCancellationSettlementBreakdown } from "@/lib/payment-status-display";
import { renderBookingMessageTemplate } from "@/lib/booking-message-definitions";
import { formatCents } from "@/lib/utils";
import {
  calendarDateOfDateOnlyInstant,
  formatClubLongDate,
} from "@/lib/club-time";
import type { BookingDetailRecord } from "./load-booking-detail";

/**
 * THE CLUB'S OWN WORDS ON THIS PAGE (#2958): the merge data a booking message
 * may insert — every token `booking-message-merge-data-contract.test.ts` says a
 * message is allowed to use — and the five rendered bodies the page places. Pure
 * formatting: it takes the figures the payment projection already derived and
 * renders the templates the page already loaded. The lodge tokens come from THIS
 * booking's lodge (#2919), not the club default.
 *
 * Moved verbatim from `page.tsx`, comments included.
 */
export function renderBookingDetailMessages({
  booking,
  club,
  modules,
  bookingMessages,
  bookingLodgeEmailSettings,
  amountDueAfterCreditCents,
  cancellationSettlement,
  retainedAfterCancellationCents,
  internetBankingPayment,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
  modules: FeatureFlags;
  bookingMessages: EffectiveBookingMessageMap;
  bookingLodgeEmailSettings: EmailMessageSettings;
  amountDueAfterCreditCents: number;
  cancellationSettlement: ReturnType<
    typeof getCancellationSettlementBreakdown
  > | null;
  retainedAfterCancellationCents: number;
  internetBankingPayment: BookingDetailRecord["payment"] | null;
}) {
  const bookingMessageData = {
    bookerFirstName: booking.member.firstName,
    bookerFullName: `${booking.member.firstName} ${booking.member.lastName}`,
    // Member-facing: these two land in the booking messages and the emails
    // built from them, so they keep the long "16 April 2026" form the club has
    // always sent (owner decision, #2264; INV-DATE-016).
    //
    // They are LODGE NIGHTS — `@db.Date` calendar days — so they take no zone:
    // the kernel decodes the UTC-midnight encoding back to the day it encodes
    // and formats it pinned to `UTC`, which is the identity for every club.
    // `formatNZLongDate` projected them through `APP_TIME_ZONE`, so a club west
    // of Greenwich put the night BEFORE the stay into the member's email.
    checkIn: formatClubLongDate(calendarDateOfDateOnlyInstant(booking.checkIn)),
    checkOut: formatClubLongDate(calendarDateOfDateOnlyInstant(booking.checkOut)),
    guestCount: booking.guests.length,
    amountDue: formatCents(amountDueAfterCreditCents),
    amountPaid: booking.payment ? formatCents(booking.payment.amountCents) : "",
    refundAmount: cancellationSettlement
      ? formatCents(cancellationSettlement.refundToOriginalMethodCents)
      : "",
    creditAmount: cancellationSettlement
      ? formatCents(cancellationSettlement.accountCreditCents)
      : "",
    creditRestored: cancellationSettlement
      ? formatCents(cancellationSettlement.restoredAppliedCreditCents)
      : "",
    retainedAmount: cancellationSettlement
      ? formatCents(retainedAfterCancellationCents)
      : "",
    changeFee: booking.payment ? formatCents(booking.payment.changeFeeCents) : "",
    paymentReference: internetBankingPayment?.reference ?? "",
    xeroInvoiceNumber: internetBankingPayment?.xeroInvoiceNumber ?? "",
    holdUntil: internetBankingPayment?.internetBankingHoldUntil
      ? club.instantDateTime(internetBankingPayment.internetBankingHoldUntil)
      : "",
    holdDays: "",
    minimumDaysBeforeCheckIn: "",
    bookingStatus: booking.status,
    // #2919: the four club-level tokens the admin preview renders and this page
    // supplied none of, so an inserted {{CLUB_LODGE_NAME}} showed a lodge name
    // in preview and a blank to the member. Resolved from THIS booking's lodge.
    CLUB_LODGE_NAME: bookingLodgeEmailSettings.lodgeName,
    CLUB_NAME: bookingLodgeEmailSettings.clubName,
    BASE_URL: bookingLodgeEmailSettings.publicUrl,
    SUPPORT_EMAIL: bookingLodgeEmailSettings.supportEmail,
  };
  const renderBookingMessage = (key: keyof typeof bookingMessages) =>
    renderBookingMessageTemplate(bookingMessages[key], bookingMessageData);
  const paymentRequiredDescription = renderBookingMessage(
    "booking.detail.paymentRequired.description",
  );
  // #2263: only the Xero-on wording may claim an invoice was emailed. With the
  // module off nothing raises one, so the member is told the club will send it —
  // which is exactly what the delivery-locked manual-invoice admin alert asks an
  // officer to do. The reference and amount are true either way.
  const internetBankingPendingDescription = renderBookingMessage(
    modules.xeroIntegration
      ? "booking.detail.internetBanking.pending"
      : "booking.detail.internetBanking.pendingNoXero",
  );
  const switchToInternetBankingDescription = renderBookingMessage(
    "booking.detail.switchToInternetBanking",
  );
  /*
    #3033: the club's own explanation, beneath the banner's structural sentences.

    Two messages and not one duplicate, and the split is enforced by the wording
    on each side rather than merely asserted here. The narrative owns the FACTS —
    your change saved, these are your dates, the club will confirm the amount,
    nothing has moved, there is nothing to do about it — which are the same for
    every club, are shared with the public payment-link page, and live once in
    `booking-financial-review-copy.ts`. This key owns only the club's
    EXPLANATION of why the amount is being worked out by a person, which is the
    part the owner said has to be "honest without being alarming" and therefore
    the part a club must be able to soften without a release. It restates none
    of the facts; an earlier draft of it repeated two of them, which is what a
    second home looks like.
  */
  const financialReviewPendingDescription = renderBookingMessage(
    "booking.detail.financialReviewPending",
  );
  const refundAppealDescription = renderBookingMessage(
    "cancellation.refundAppeal.description",
  );

  return {
    paymentRequiredDescription,
    internetBankingPendingDescription,
    switchToInternetBankingDescription,
    financialReviewPendingDescription,
    refundAppealDescription,
  };
}
