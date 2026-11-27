import { bookingOwner } from "@/lib/booking-owner";
import type { BoundClubTime } from "@/lib/club-time";
import type { FeatureFlags } from "@/config/schema";
import type { EmailMessageSettings } from "@/lib/email-message-settings";
import type { EffectiveBookingMessageMap } from "@/lib/booking-message-settings";
import { renderBookingMessageTemplate } from "@/lib/booking-message-definitions";
import type { BoundClubFormat } from "@/lib/club-format-bound";
import {
  calendarDateOfDateOnlyInstant,
  formatClubLongDate,
} from "@/lib/club-time";
import type { BookingDetailRecord } from "./load-booking-detail";
import type { BookingDetailPayment } from "./booking-detail-payment";

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
  money,
  modules,
  bookingMessages,
  bookingLodgeEmailSettings,
  payment,
}: {
  booking: BookingDetailRecord;
  club: BoundClubTime;
  money: BoundClubFormat;
  modules: FeatureFlags;
  bookingMessages: EffectiveBookingMessageMap;
  bookingLodgeEmailSettings: EmailMessageSettings;
  payment: BookingDetailPayment;
}) {
  const {
    amountDueAfterCreditCents,
    cancellationSettlement,
    retainedAfterCancellationCents,
    internetBankingPayment,
  } = payment;
  const bookingMessageData = {
    bookerFirstName: bookingOwner(booking).member.firstName,
    bookerFullName: `${bookingOwner(booking).member.firstName} ${bookingOwner(booking).member.lastName}`,
    // Member-facing: these two land in the booking messages and the emails
    // built from them, so they keep the long "16 April 2026" form the club has
    // always sent (owner decision, #2264; INV-DATE-016).
    //
    // They are LODGE NIGHTS — `@db.Date` calendar days — so they take no zone:
    // the kernel decodes the UTC-midnight encoding back to the day it encodes
    // and formats it pinned to `UTC`, which is the identity for every club.
    // `formatNZLongDate` projected them through `APP_TIME_ZONE`, so a club west
    // of Greenwich put the night BEFORE the stay into the member's email.
    checkIn: formatClubLongDate(calendarDateOfDateOnlyInstant(booking.checkIn), club.format),
    checkOut: formatClubLongDate(calendarDateOfDateOnlyInstant(booking.checkOut), club.format),
    guestCount: booking.guests.length,
    amountDue: money.cents(amountDueAfterCreditCents),
    amountPaid: booking.payment ? money.cents(booking.payment.amountCents) : "",
    refundAmount: cancellationSettlement
      ? money.cents(cancellationSettlement.refundToOriginalMethodCents)
      : "",
    creditAmount: cancellationSettlement
      ? money.cents(cancellationSettlement.accountCreditCents)
      : "",
    creditRestored: cancellationSettlement
      ? money.cents(cancellationSettlement.restoredAppliedCreditCents)
      : "",
    retainedAmount: cancellationSettlement
      ? money.cents(retainedAfterCancellationCents)
      : "",
    changeFee: booking.payment ? money.cents(booking.payment.changeFeeCents) : "",
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
  // #4019: an approved whole-lodge booking is already CONFIRMED and held, so
  // the ordinary sentence's promise to confirm it after the transfer would be
  // untrue; the club edits that case's wording under its own key.
  const isConfirmedWholeLodge = booking.wholeLodgeHold && booking.status === "CONFIRMED";
  const switchToInternetBankingDescription = renderBookingMessage(
    isConfirmedWholeLodge
      ? "booking.detail.switchToInternetBankingWholeLodge"
      : "booking.detail.switchToInternetBanking",
  );
  const switchToInternetBankingConfirmDescription = renderBookingMessage(
    isConfirmedWholeLodge
      ? "booking.detail.switchToInternetBankingConfirmWholeLodge"
      : "booking.detail.switchToInternetBankingConfirm",
  );
  const refundAppealDescription = renderBookingMessage(
    "cancellation.refundAppeal.description",
  );

  return {
    paymentRequiredDescription,
    internetBankingPendingDescription,
    switchToInternetBankingDescription,
    switchToInternetBankingConfirmDescription,
    refundAppealDescription,
  };
}

export type BookingDetailMessages = ReturnType<typeof renderBookingDetailMessages>;
