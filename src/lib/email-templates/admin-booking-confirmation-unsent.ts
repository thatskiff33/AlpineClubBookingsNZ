/**
 * #5433 (owner decision D1, 23 Nov 2026): the officers' alert for a paid
 * booking whose confirmation email did not reach the member: it could not be
 * sent in time (by the end of the check-in day), it failed or bounced, or the
 * owner has no address that can be emailed. The owed confirmation is then
 * cleared unsent, and this alert, sent once per paid booking
 * (`alertOfficersOncePastCutoff`), is how a Booking Officer learns the member
 * may not know. Sender: `src/lib/email/admin-alerts-booking-confirmation-unsent.ts`.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout } from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import { BOOKING_CONFIRMATION_UNSENT_NOTE } from "@/lib/booking-confirmation-unsent-note";

export function adminBookingConfirmationUnsentTemplate(data: {
  memberName: string;
  bookingId: string;
  bookingUrl: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Booking Confirmation Not Sent")}
    ${alertBox(BOOKING_CONFIRMATION_UNSENT_NOTE, "warning")}
    ${infoTable([
      { label: "Owner", value: escapeHtml(data.memberName) },
      { label: "Booking", value: escapeHtml(formatBookingReference(data.bookingId)) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${button("Open Booking", data.bookingUrl, { sameOrigin: true })}
  `);
}
