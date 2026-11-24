import { adminWaitlistNoticeUnsentTemplate } from "@/lib/email-templates/admin-waitlist-notice-unsent";
import { WAITLIST_NOTICE_UNSENT_NOTE, type WaitlistNoticeUnsent } from "@/lib/waitlist-notice-unsent-note";
import { sendToAdmins } from "./admin-alerts-shared";
import type { AdminAlertRecipientsResult } from "./admin-alert-send-result";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import { buildBookingDetailUrl } from "@/lib/booking-email-contract";

/**
 * #5433: a waitlist email owed to a member passed its cut-off unsent (the
 * offer, owner decision D2, or the offer-expired notice). Admin audience
 * through `sendToAdmins` on the `adminWaitlistOffer` preference, the officers
 * who follow waitlist offers. Returns what happened to each recipient, so the
 * caller's once-per-notice claim (`alertOfficersOncePastCutoff`) is kept,
 * held or given back accordingly.
 */
export async function sendAdminWaitlistNoticeUnsentAlert(data: {
  notice: WaitlistNoticeUnsent;
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
}): Promise<AdminAlertRecipientsResult> {
  const bookingUrl = buildBookingDetailUrl(data.bookingId);
  return sendToAdmins({
    subject: `Waitlist email not sent: ${data.memberName}`,
    html: await renderEmailHtml(() => adminWaitlistNoticeUnsentTemplate({ ...data, bookingUrl })),
    templateName: "admin-waitlist-notice-unsent",
    templateData: {
      noticeNote: WAITLIST_NOTICE_UNSENT_NOTE[data.notice],
      memberName: data.memberName,
      bookingReference: formatBookingReference(data.bookingId),
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingUrl,
    },
    preferenceKey: "adminWaitlistOffer",
  });
}
