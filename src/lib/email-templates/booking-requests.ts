/**
 * Emails for the public booking-request flow: verification, quote, approval,
 * decline, expiry, and the split/school payment links that follow one.
 *
 * The family boundary is `src/lib/email/booking-requests.ts`. The verification
 * template is also sent by `src/lib/email/groups.ts` for the group-booking join
 * code — one authoritative implementation, imported, never copied.
 */
import { escapeHtml } from "./escape";
import {
  alertBox,
  button,
  formatCents,
  heading,
  infoTable,
  layout,
  multilineBlock,
  muted,
  paragraph,
  supportContactSentence,
} from "./layout";
import { CLUB_NAME } from "@/config/club-identity";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";

// ---- Public booking request flow (issue #707) ----

export function bookingRequestVerificationTemplate(data: {
  firstName: string;
  verifyUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Confirm Your Booking Request")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thanks for your booking request for " + escapeHtml(CLUB_NAME) + "'s lodge.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
    ])}
    ${paragraph("Please confirm your email address so the club can review your request. Your request will not be reviewed until you confirm.")}
    ${button("Confirm My Email", data.verifyUrl)}
    ${muted("This link expires on " + escapeHtml(emailClubDateTime(data.expiresAt)) + ". If you did not make this request, you can safely ignore this email and the request will be deleted.")}
  `);
}

export function bookingRequestApprovedTemplate(data: {
  firstName: string;
  payUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  priceCents: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Your Booking Request Has Been Approved")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", good news — the club has approved your booking request.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Price", value: formatCents(data.priceCents) },
    ])}
    ${paragraph("Use the secure link below to pay and confirm your stay. You can pay by card, or by internet banking using the reference shown on the payment page.")}
    ${button("Pay for My Stay", data.payUrl)}
    ${alertBox("Until payment is received, club members keep priority for these dates and your booking may be bumped if the lodge fills.", "info")}
    ${muted("This payment link expires on " + escapeHtml(emailClubDateTime(data.expiresAt)) + ". If you have any questions, just reply to this email or contact the club.")}
  `);
}

/**
 * Split-booking guest-portion payment link (#1967). Sent to the member when the
 * provisional non-member child of a split booking reaches its hold deadline but
 * there is no card on file to auto-charge (the member paid their own place by
 * Internet Banking via the switch-at-pay path). Reuses the #707 tokenised
 * `/pay/<token>` PaymentLink so the member can settle their guests' portion.
 */
export function splitGuestPaymentLinkTemplate(data: {
  firstName: string;
  payUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  priceCents: number;
  expiresAt: Date;
}): string {
  return layout(`
    ${heading("Pay for Your Guests to Confirm Their Place")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", your own place is taken care of separately, but your non-member guests still need to be paid for before we can hold beds for them. Because there is no card on file for this part of your booking, please use the secure link below to pay for your guests.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      { label: "Amount due", value: formatCents(data.priceCents) },
    ])}
    ${paragraph("Use the secure link below to pay. You can pay by card, or by internet banking using the reference shown on the payment page.")}
    ${button("Pay for My Guests", data.payUrl)}
    ${alertBox("Until payment is received, no beds are held for your guests and their place may be bumped if the lodge fills for these dates.", "info")}
    ${muted("This payment link expires on " + escapeHtml(emailClubDateTime(data.expiresAt)) + ". If you have any questions, just reply to this email or contact the club.")}
  `);
}

export function bookingRequestQuoteTemplate(data: {
  firstName: string;
  respondUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  options: Array<{ label: string; totalCents: number }>;
  message?: string | null;
  expiresAt: Date;
  schoolName?: string | null;
  isReminder?: boolean;
}): string {
  const optionRows = data.options.map((option) => ({
    label: option.label,
    value: formatCents(option.totalCents),
  }));

  return layout(`
    ${heading(data.isReminder ? "Reminder: Your Booking Quote Is Expiring Soon" : "Your Booking Quote Is Ready")}
    ${paragraph(
      data.isReminder
        ? "Hi " +
            escapeHtml(data.firstName) +
            ", this is a reminder that your lodge quote is still waiting and will expire soon. We have included a fresh secure link below so you do not need to find the original email."
        : "Hi " + escapeHtml(data.firstName) + ", the club has prepared a quote for your lodge request.",
    )}
    ${infoTable([
      ...(data.schoolName ? [{ label: "School", value: data.schoolName }] : []),
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Guests", value: String(data.guestCount) },
      ...optionRows,
    ])}
    ${data.message ? multilineBlock("<strong>Note from the club:</strong>\n" + escapeHtml(data.message)) : ""}
    ${paragraph("Use the secure link below to accept, cancel, request changes, or send a question about this quote.")}
    ${button("Respond to Quote", data.respondUrl)}
    ${muted("This quote link expires on " + escapeHtml(emailClubDateTime(data.expiresAt)) + ". If you have questions, just reply to this email or contact the club.")}
  `);
}

export function bookingRequestDeclinedTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
  reason?: string | null;
}): string {
  return layout(`
    ${heading("Update on Your Booking Request")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", thank you for your interest in staying at " + escapeHtml(CLUB_NAME) + "'s lodge.")}
    ${paragraph("Unfortunately the club is unable to accommodate your request for " + escapeHtml(emailCalendarDay(data.checkIn)) + " to " + escapeHtml(emailCalendarDay(data.checkOut)) + " at this time.")}
    ${data.reason ? multilineBlock("<strong>Note from the club:</strong>\n" + escapeHtml(data.reason)) : ""}
    ${paragraph("You are welcome to submit another request for different dates.")}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

/**
 * #2012 — member-facing terminal notice that the booking created from their
 * approved public booking request (#707) stayed unpaid up to the check-in day,
 * so the provisional booking was released. Distinct wording from
 * bookingRequestDeclinedTemplate ("unable to accommodate"): this request WAS
 * approved and priced — the payment window simply lapsed — so it must not
 * imply a refusal. Reassures that nothing was ever charged. No bearer token, so
 * this is not sensitive-log material.
 */
export function bookingRequestPaymentExpiredTemplate(data: {
  firstName: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Your Booking Was Released — Payment Not Received")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", the booking we approved from your request stayed unpaid up to the check-in day, so it has now been released. Nothing was ever charged.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${paragraph("If you still want to stay, you are welcome to submit a new booking request for these or other dates.")}
    ${supportContactSentence("If you have questions, contact the club at ")}
  `);
}

/**
 * School attendee confirmation prompt (#1101): tokenized link where the
 * school contact renames placeholder attendees and confirms the list.
 */
export function schoolAttendeeConfirmationTemplate(data: {
  firstName: string;
  schoolName: string | null;
  confirmUrl: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  isReminder: boolean;
}): string {
  const stayLabel = data.schoolName
    ? escapeHtml(data.schoolName) + "'s stay"
    : "your school group's stay";
  return layout(`
    ${heading(data.isReminder ? "Reminder: Confirm Your Attendee List" : "Confirm Your Attendee List")}
    ${paragraph("Hi " + escapeHtml(data.firstName) + ", " + stayLabel + " at " + escapeHtml(CLUB_NAME) + "'s lodge is coming up, and the booking currently lists placeholder attendee names. Please tell us who is coming so the lodge roster shows real names on arrival.")}
    ${infoTable([
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Attendees", value: String(data.guestCount) },
    ])}
    ${paragraph("Use the secure link below to update the names and confirm the list. You can come back and edit until you confirm; the link stays valid until check-in.")}
    ${button("Confirm Attendees", data.confirmUrl)}
    ${muted("Need to change how many people are coming, or their age groups? Contact the club instead — headcount changes go through a revised quote.")}
    ${supportContactSentence("If you have any questions, contact the club at ")}
  `);
}
