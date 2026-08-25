import {
  bookingRequestApprovedTemplate,
  bookingRequestDeclinedTemplate,
  bookingRequestPaymentExpiredTemplate,
  bookingRequestQuoteTemplate,
  bookingRequestVerificationTemplate,
  schoolAttendeeConfirmationTemplate,
  splitGuestPaymentLinkTemplate,
} from "@/lib/email-templates/booking-requests";
import {
  composeOptionalEmailLine,
} from "../email-message-notes";
import { CLUB_NAME } from "@/config/club-identity";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendEmail, type EmailSendOutcome } from "./core";
import {
  classifyBookingOwnerContext,
  type BookingEmailSourceContext,
} from "@/lib/booking-email-contract";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";

// ---- Public booking request flow (issue #707) ----

export async function sendBookingRequestVerificationEmail(params: {
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
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const verifyUrl = `${baseUrl}/booking-requests/verify/${params.token}`;

  await sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Confirm your booking request — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => bookingRequestVerificationTemplate({
      firstName: params.firstName,
      verifyUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      expiresAt: params.expiresAt,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "booking-request-verification",
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

export async function sendBookingRequestApprovedEmail(params: {
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
  priceCents: number;
  bookingReference: string;
  expiresAt: Date;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}): Promise<EmailSendOutcome> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const payUrl = `${baseUrl}/pay/${params.token}`;

  // Return the send outcome so callers can tell a delivered email from a
  // suppressed one (F25, #1885) instead of assuming the mail went out.
  return sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Your booking request has been approved — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => bookingRequestApprovedTemplate({
      firstName: params.firstName,
      payUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      priceCents: params.priceCents,
      expiresAt: params.expiresAt,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "booking-request-approved",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      payUrl,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
      priceCents: params.priceCents,
      price: formatMoneyCents(params.priceCents),
      bookingReference: params.bookingReference,
      // PERSISTED zone, matching the HTML body two blocks up (#2870, CT-4).
      // A saved body override re-renders the WHOLE email from this object
      // (`email-message-renderer.ts` -> `prepareEmailMessage`), and the shipped
      // default body for this template already contains `{{expiresAt}}` — so
      // `formatNZDateTime` here spelled the payment deadline in the CONTAINER's
      // zone for any club that has edited the wording, while the default body
      // spelled the same instant in the club's. On a divergent deployment those
      // two readings named different times, and in the club-behind direction a
      // different DAY. `emailClubDateTime` is the same accessor the default body
      // uses, so the override and the default can no longer disagree.
      expiresAt: emailClubDateTime(params.expiresAt),
    },
  });
}

/**
 * Split-booking guest-portion payment link (#1967). Emails the member a secure
 * `/pay/<token>` link so they can settle their non-member guests' portion when
 * the split child reached its hold deadline with no card on file. Returns the
 * send outcome so callers can distinguish a delivered email from a suppressed
 * one (F25, #1885).
 */
export async function sendSplitGuestPaymentLinkEmail(params: {
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
  priceCents: number;
  bookingReference: string;
  expiresAt: Date;
  lodgeId?: string | null;
}): Promise<EmailSendOutcome> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const payUrl = `${baseUrl}/pay/${params.token}`;

  return sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Pay for your guests to confirm their place — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => splitGuestPaymentLinkTemplate({
      firstName: params.firstName,
      payUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      priceCents: params.priceCents,
      expiresAt: params.expiresAt,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "split-guest-payment-link",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      payUrl,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
      priceCents: params.priceCents,
      price: formatMoneyCents(params.priceCents),
      bookingReference: params.bookingReference,
      // PERSISTED zone — see the identical note on `booking-request-approved`
      // above. Same value, same override branch, same defect.
      expiresAt: emailClubDateTime(params.expiresAt),
    },
  });
}

export async function sendBookingRequestQuoteEmail(params: {
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
  requestType: string;
  schoolName?: string | null;
  options: Array<{ label: string; totalCents: number }>;
  message?: string | null;
  expiresAt: Date;
  isReminder?: boolean;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const respondUrl = `${baseUrl}/booking-requests/respond/${params.token}`;

  // RETURNS the mailer's outcome (#3035). It used to swallow it, so both callers
  // recorded a `success` audit row and told an officer the quote had gone out
  // when the environment-safety boundary had held it back. Both now inspect it.
  return sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: params.isReminder
      ? `Reminder: your booking quote expires soon — ${CLUB_NAME}`
      : `Your booking quote is ready — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => bookingRequestQuoteTemplate({
      firstName: params.firstName,
      respondUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      options: params.options,
      message: params.message,
      expiresAt: params.expiresAt,
      schoolName: params.schoolName,
      isReminder: params.isReminder,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "booking-request-quote",
    templateData: {
      firstName: params.firstName,
      token: params.token,
      respondUrl,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
      requestType: params.requestType,
      schoolName: params.schoolName ?? "",
      quoteOptions: params.options
        .map((option) => `${option.label}: ${formatMoneyCents(option.totalCents)}`)
        .join("\n"),
      expiresAt: emailClubDateTime(params.expiresAt),
    },
  });
}

export async function sendBookingRequestDeclinedEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  reason?: string | null;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Update on your booking request — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => bookingRequestDeclinedTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      reason: params.reason,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "booking-request-declined",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      reason: params.reason ?? "",
      // #2268: pre-composed optional line — a decline with no note must not
      // print a dangling "Note:".
      reasonNote: composeOptionalEmailLine("Note", params.reason),
    },
  });
}

/**
 * #2012 — member-facing terminal notice that the booking created from their
 * approved public booking request (#707) was released because it stayed unpaid
 * up to the check-in day. Distinct from sendBookingRequestDeclinedEmail (which
 * says the club could not accommodate the request): the request WAS approved
 * and priced, so this only reports the lapsed payment window and reassures
 * nothing was charged.
 */
export async function sendBookingRequestPaymentExpiredEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  // Lodge the request is for (multi-lodge): overlays that lodge's
  // identity via prepareEmailMessage; null keeps club-wide identity.
  lodgeId?: string | null;
}) {
  await sendEmail({
    to: params.email,
    lodgeId: params.lodgeId,
    subject: `Your booking was released — payment not received — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => bookingRequestPaymentExpiredTemplate({
      firstName: params.firstName,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "booking-request-payment-expired",
    templateData: {
      firstName: params.firstName,
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
    },
  });
}

/**
 * School attendee confirmation prompt (#1101): tokenized link, rotated on
 * every send, where the school contact renames placeholder attendees and
 * confirms the list before check-in.
 */
export async function sendSchoolAttendeeConfirmationEmail(params: {
  // Booking this message belongs to (#2258). Explicit union: pass the real
  // booking id so the per-booking "No emails" switch can withhold this message,
  // or `"none"` when the flow genuinely has no booking yet.
  bookingContext: BookingEmailSourceContext;
  email: string;
  firstName: string;
  schoolName: string | null;
  token: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  isReminder: boolean;
}) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const confirmUrl = `${baseUrl}/school-bookings/confirm/${params.token}`;

  await sendEmail({
    to: params.email,
    subject: params.isReminder
      ? `Reminder: confirm your attendee list — ${CLUB_NAME}`
      : `Confirm your attendee list — ${CLUB_NAME}`,
    html: await renderEmailHtml(() => schoolAttendeeConfirmationTemplate({
      firstName: params.firstName,
      schoolName: params.schoolName,
      confirmUrl,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestCount: params.guestCount,
      isReminder: params.isReminder,
    })),
    bookingContext: classifyBookingOwnerContext(params.bookingContext),
    templateName: "school-attendee-confirmation",
    templateData: {
      firstName: params.firstName,
      // Registered defaultBody references {{token}} for the confirm link, so an
      // admin override can render it (the hardcoded sender builds the link in HTML).
      token: params.token,
      // #2268: the same fallback the hand-built HTML uses, applied here so the
      // flat body's "{{schoolName}}'s stay" is never orphaned as "'s stay"
      // when the booking records no school name.
      schoolName: params.schoolName ?? "your school group",
      checkIn: emailCalendarDay(params.checkIn),
      checkOut: emailCalendarDay(params.checkOut),
      guestCount: params.guestCount,
      isReminder: params.isReminder,
    },
  });
}
