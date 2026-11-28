import { adminBookingNoticeUnsentTemplate } from "@/lib/email-templates/admin-booking-notice-unsent";
import { BOOKING_NOTICE_UNSENT_NOTE, type BookingNoticeUnsent } from "@/lib/booking-notice-unsent-note";
import { sendToAdmins } from "./admin-alerts-shared";
import type { AdminAlertRecipientsResult } from "./admin-alert-send-result";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import { buildBookingDetailUrl } from "@/lib/booking-email-contract";

/**
 * #5433 PR 4: a member notice the confirm-pending job owed did not reach the
 * booking's owner, and will not be sent automatically. Admin audience through
 * `sendToAdmins` on the `adminBookingReviewRequired` preference, the bookings
 * officers the "Booking confirmation not sent" alert already reaches. Returns
 * what happened to each recipient, so the caller's once-per-notice claim
 * (`alertOfficersOncePastCutoff`) is kept, held or given back accordingly.
 */
export async function sendAdminBookingNoticeUnsentAlert(data: {
  notice: BookingNoticeUnsent;
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
}): Promise<AdminAlertRecipientsResult> {
  const bookingUrl = buildBookingDetailUrl(data.bookingId);
  return sendToAdmins({
    subject: `Booking email not sent: ${data.memberName}`,
    html: await renderEmailHtml(() => adminBookingNoticeUnsentTemplate({ ...data, bookingUrl })),
    templateName: "admin-booking-notice-unsent",
    templateData: {
      unsentNote: BOOKING_NOTICE_UNSENT_NOTE[data.notice],
      memberName: data.memberName,
      bookingReference: formatBookingReference(data.bookingId),
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingUrl,
    },
    preferenceKey: "adminBookingReviewRequired",
  });
}
