import {
  bookingRequestVerificationTemplate,
} from "@/lib/email-templates/booking-requests";
import {
  groupJoinCancelledTemplate,
  groupJoinPaySelfTemplate,
  groupJoinReleasedTemplate,
  groupJoinSettledTemplate,
  groupOrganiserExtraInvoiceTemplate,
  groupOrganiserJoinerRefundTemplate,
  groupSettlementExpiredTemplate,
  groupSettlementReceiptTemplate,
} from "@/lib/email-templates/groups";
import { organiserExtraInvoiceSentence, organiserJoinerAppealRefundSentence } from "@/lib/booking-modified-email-copy";
import { CLUB_NAME } from "@/config/club-identity";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendEmail } from "./core";
import {
  classifyBookingOwnerContext,
  type BookingEmailSourceContext,
} from "@/lib/booking-email-contract";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

/**
 * Verification email for a non-member joining a group booking. Reuses the
 * booking-request verification template but points the link at the group-join
 * verify page (/join/verify/[token]) rather than the booking-request one.
 */
export async function sendGroupBookingJoinVerificationEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  token: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expiresAt: Date;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/join/verify/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: `Confirm your group booking spot — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => bookingRequestVerificationTemplate({
      firstName: params.firstName,
      verifyUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      expiresAt: params.expiresAt,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-booking-join-verification",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      verifyUrl,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
      expiresAt: emailClubDateTime(params.expiresAt),
    },
  });
}

/** Receipt to the organiser after they settle an ORGANISER_PAYS group bill. */
export async function sendGroupSettlementReceiptEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
},
  format: ClubFormat,
) {
  await sendEmail({
    to: params.email,
    subject: `Your group booking is settled — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupSettlementReceiptTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      joinerCount: params.joinerCount,
      totalCents: params.totalCents,
    }, format)),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-settlement-receipt",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      joinerCount: params.joinerCount,
      total: formatMoneyCents(params.totalCents, format),
    },
  });
}

/** Confirmation to a joiner whose spot the organiser has settled for them. */
export async function sendGroupJoinSettledEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your spot is confirmed — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupJoinSettledTemplate({
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-join-settled",
    templateData: {
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
    },
  });
}

/**
 * #3672: joiner notice that the organiser's paid bill did not include them, so
 * their booking is now theirs to pay.
 */
export async function sendGroupJoinPaySelfEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Please pay for your place — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupJoinPaySelfTemplate({
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-join-pay-self",
    templateData: {
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
  });
}

/** Organiser notice that their abandoned combined payment released the beds. */
export async function sendGroupSettlementExpiredEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  joinerCount: number;
  totalCents: number;
},
  format: ClubFormat,
) {
  await sendEmail({
    to: params.email,
    subject: `Your group payment expired — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupSettlementExpiredTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      joinerCount: params.joinerCount,
      totalCents: params.totalCents,
    }, format)),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-settlement-expired",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      joinerCount: params.joinerCount,
      total: formatMoneyCents(params.totalCents, format),
    },
  });
}

/** Joiner notice that the organiser's abandoned payment released their bed. */
export async function sendGroupJoinReleasedEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your held spot has been released — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupJoinReleasedTemplate({
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-join-released",
    templateData: {
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
  });
}

/**
 * Joiner notice that their reaped organiser-pays place reached its terminal
 * state (#1094): the group settlement was never retried, so the pending
 * booking has been cancelled.
 */
export async function sendGroupJoinCancelledEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  organiserName: string;
  checkIn: Date;
  checkOut: Date;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your group booking has been cancelled — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupJoinCancelledTemplate({
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-join-cancelled",
    templateData: {
      firstName: params.firstName,
      organiserName: params.organiserName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
  });
}

/**
 * #3956 (`INV-PAY-123`): the organiser's notice that a joiner's approved refund
 * appeal is being refunded to the card they paid for the group with. Scoped to
 * the organiser's own booking, so its "No emails" switch withholds it.
 */
export async function sendGroupOrganiserJoinerRefundEmail(params: {
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  joinerName: string;
  amountCents: number;
  checkIn: Date;
  checkOut: Date;
},
  format: ClubFormat,
) {
  const amount = formatMoneyCents(params.amountCents, format);
  await sendEmail({
    to: params.email,
    subject: `A refund to your card for your group booking — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupOrganiserJoinerRefundTemplate({
      firstName: params.firstName,
      joinerName: params.joinerName,
      amountCents: params.amountCents,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    }, format)),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-organiser-joiner-refund",
    templateData: {
      firstName: params.firstName,
      joinerName: params.joinerName,
      amount,
      refundSentence: organiserJoinerAppealRefundSentence(amount, params.joinerName),
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
  });
}

/**
 * #4299 (`INV-PAY-142`, decision 2): the organiser's notice of an extra invoice
 * for a joiner's place they paid for by Internet Banking. Scoped to the
 * organiser's own booking, so its "No emails" switch withholds it.
 */
export async function sendGroupOrganiserExtraInvoiceEmail(params: {
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  joinerName: string;
  amountCents: number;
  invoiceNumber: string;
  combinedInvoiceNumber: string | null;
  changeSummary: string;
  checkIn: Date;
  checkOut: Date;
},
  format: ClubFormat,
) {
  const amount = formatMoneyCents(params.amountCents, format);
  await sendEmail({
    to: params.email,
    subject: `An extra invoice for your group booking — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => groupOrganiserExtraInvoiceTemplate({
      firstName: params.firstName,
      joinerName: params.joinerName,
      amountCents: params.amountCents,
      invoiceNumber: params.invoiceNumber,
      combinedInvoiceNumber: params.combinedInvoiceNumber,
      changeSummary: params.changeSummary,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    }, format)),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "group-organiser-extra-invoice",
    templateData: {
      firstName: params.firstName,
      joinerName: params.joinerName,
      amount,
      invoiceNumber: params.invoiceNumber,
      changeSummary: params.changeSummary,
      extraInvoiceSentence: organiserExtraInvoiceSentence({
        amount,
        joinerName: params.joinerName,
        invoiceNumber: params.invoiceNumber,
        combinedInvoiceNumber: params.combinedInvoiceNumber,
      }),
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
  });
}
