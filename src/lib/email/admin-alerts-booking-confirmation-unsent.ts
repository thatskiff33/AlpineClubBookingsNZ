import { adminBookingConfirmationUnsentTemplate } from "@/lib/email-templates/admin-booking-confirmation-unsent";
import { sendToAdmins } from "./admin-alerts-shared";
import type { AdminAlertRecipientsResult } from "./admin-alert-send-result";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import { buildBookingDetailUrl } from "@/lib/booking-email-contract";

/**
 * #5433 (owner decision D1): a paid booking's confirmation did not reach the
 * owner, and will not be sent automatically. Admin audience through
 * `sendToAdmins` on the `adminBookingReviewRequired` preference: the bookings
 * officers, on a key kept apart from routine new-booking alerts so muting
 * those does not silence this one. Returns what happened to each recipient,
 * so the caller's once-per-booking claim (`alertOfficersOncePastCutoff`) is
 * kept, held or given back accordingly.
 */
export async function sendAdminBookingConfirmationUnsentAlert(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
}): Promise<AdminAlertRecipientsResult> {
  const bookingUrl = buildBookingDetailUrl(data.bookingId);
  return sendToAdmins({
    subject: `Booking confirmation not sent: ${data.memberName}`,
    html: await renderEmailHtml(() => adminBookingConfirmationUnsentTemplate({ ...data, bookingUrl })),
    templateName: "admin-booking-confirmation-unsent",
    templateData: {
      memberName: data.memberName,
      bookingReference: formatBookingReference(data.bookingId),
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingUrl,
    },
    preferenceKey: "adminBookingReviewRequired",
  });
}
