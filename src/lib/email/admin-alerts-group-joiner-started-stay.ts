import { adminGroupJoinerStartedStayTemplate } from "@/lib/email-templates/admin-group-joiner-started-stay";
import { sendToAdmins } from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";

/**
 * #3672 (`INV-PAY-108`): a paid group's left-behind joiners whose stay has
 * started were switched to paying for themselves without an email, so the
 * treasurer collects by hand. Admin audience through `sendToAdmins` on the
 * `adminPaymentFailure` preference, linking the payments board like the other
 * reconcile-by-hand notices. Returns how many admins it reached, so the
 * caller's once-per-group claim can be given back when nobody was told.
 */
export async function sendAdminGroupJoinerStartedStayAlert(data: {
  organiserName: string;
  organiserBookingId: string;
  checkIn: Date;
  joinerNames: string;
}): Promise<number> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;

  return sendToAdmins({
    subject: "Group joiners mid-stay now pay for themselves",
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
