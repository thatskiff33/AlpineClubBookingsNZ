/**
 * #5433 PR 4: the officers' alert for a member notice the confirm-pending job
 * owed and that did not reach the booking's owner: the requester's "booking
 * released" email, the member's "guests' place cancelled" email, the guests'
 * payment link, or the "save a new card" email. The owed notice is then
 * cleared unsent, and this alert, sent once per notice
 * (`alertOfficersOncePastCutoff`), is how a Booking Officer learns the owner
 * may not know. The note says which (`booking-notice-unsent-note.ts`).
 * Sender: `src/lib/email/admin-alerts-booking-notice-unsent.ts`.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout } from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import { BOOKING_NOTICE_UNSENT_NOTE, type BookingNoticeUnsent } from "@/lib/booking-notice-unsent-note";

export function adminBookingNoticeUnsentTemplate(data: {
  notice: BookingNoticeUnsent;
  memberName: string;
  bookingId: string;
  bookingUrl: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Booking Email Not Sent")}
    ${alertBox(BOOKING_NOTICE_UNSENT_NOTE[data.notice], "warning")}
    ${infoTable([
      { label: "Owner", value: escapeHtml(data.memberName) },
      { label: "Booking", value: escapeHtml(formatBookingReference(data.bookingId)) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${button("Open Booking", data.bookingUrl, { sameOrigin: true })}
  `);
}
