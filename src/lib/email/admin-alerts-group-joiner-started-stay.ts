import { adminGroupJoinerStartedStayTemplate } from "@/lib/email-templates/admin-group-joiner-started-stay";
import { sendToAdmins } from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";

/**
 * #3672 (`INV-PAY-108`): a paid group's left-behind joiners were not switched
 * to paying for themselves because the stay has started. Admin audience
 * through `sendToAdmins` on the `adminPaymentFailure` preference, like the
 * other reconcile-by-hand notices; the caller sends it at most once per group.
 */
export async function sendAdminGroupJoinerStartedStayAlert(data: {
  organiserName: string;
  organiserBookingId: string;
  checkIn: Date;
  joinerNames: string;
}): Promise<void> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/bookings`;

  await sendToAdmins({
    subject: "Unpaid group joiners on a stay that has started",
    html: await renderEmailHtml(() =>
      adminGroupJoinerStartedStayTemplate({ ...data, reviewUrl }),
    ),
    templateName: "admin-group-joiner-started-stay",
    templateData: {
      organiserName: data.organiserName,
      bookingReference: formatBookingReference(data.organiserBookingId),
      checkIn: emailCalendarDay(data.checkIn),
      joinerNames: data.joinerNames,
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}
