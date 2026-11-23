/**
 * #5433: the officers' alert for a waitlist email that a committed change owed
 * the member and that could not be sent before its cut-off: the offer of a
 * place (owner decision D2), or the notice that an offer lapsed. The owed
 * notice is then cleared unsent, and this alert, sent once per notice
 * (`alertOfficersOncePastCutoff`), is how a Booking Officer learns the member
 * may not know. Owner decision D5 (24 Nov 2026) adds a third case: an offer
 * that lapsed before its email could ever be sent, whose turn has passed. Sender: `src/lib/email/admin-alerts-waitlist-notice-unsent.ts`.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout } from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import { WAITLIST_NOTICE_UNSENT_NOTE, type WaitlistNoticeUnsent } from "@/lib/waitlist-notice-unsent-note";

export function adminWaitlistNoticeUnsentTemplate(data: {
  notice: WaitlistNoticeUnsent;
  memberName: string;
  bookingId: string;
  bookingUrl: string;
  checkIn: Date;
  checkOut: Date;
}): string {
  return layout(`
    ${heading("Waitlist Email Not Sent")}
    ${alertBox(WAITLIST_NOTICE_UNSENT_NOTE[data.notice], "warning")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Booking", value: escapeHtml(formatBookingReference(data.bookingId)) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
    ])}
    ${button("Open Booking", data.bookingUrl, { sameOrigin: true })}
  `);
}
