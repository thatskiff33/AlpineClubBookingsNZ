import { adminGroupJoinerStartedStayTemplate } from "@/lib/email-templates/admin-group-joiner-started-stay";
import { sendToAdmins } from "./admin-alerts-shared";
import { type AdminAlertSendResult } from "./admin-alert-send-result";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import { buildBookingDetailUrl } from "@/lib/booking-email-contract";

/**
 * #3672 (`INV-PAY-108`): a paid group's left-behind joiners whose stay has
 * started were switched to paying for themselves without an email, so the
 * treasurer collects by hand. Admin audience through `sendToAdmins` on the
 * `adminPaymentFailure` preference. It links the organiser's booking and each
 * joiner's, the booking detail page whose admin tools record a manual
 * payment. Returns what happened to each recipient, so the caller's
 * once-per-group claim is kept, deferred or given back accordingly.
 */
export async function sendAdminGroupJoinerStartedStayAlert(data: {
  organiserName: string;
  organiserBookingId: string;
  checkIn: Date;
  joiners: Array<{ name: string; bookingId: string }>;
}): Promise<AdminAlertSendResult> {
  const organiserBookingUrl = buildBookingDetailUrl(data.organiserBookingId);
  const joiners = data.joiners.map((joiner) => ({
    name: joiner.name,
    bookingUrl: buildBookingDetailUrl(joiner.bookingId),
  }));

  return sendToAdmins({
    subject: "Group joiners mid-stay now pay for themselves",
    html: await renderEmailHtml(() =>
      adminGroupJoinerStartedStayTemplate({
        organiserName: data.organiserName,
        organiserBookingId: data.organiserBookingId,
        organiserBookingUrl,
        checkIn: data.checkIn,
        joiners,
      }),
    ),
    templateName: "admin-group-joiner-started-stay",
    templateData: {
      organiserName: data.organiserName,
      bookingReference: formatBookingReference(data.organiserBookingId),
      checkIn: emailCalendarDay(data.checkIn),
      joinerBookingLinks: joiners
        .map((joiner) => `${joiner.name}: ${joiner.bookingUrl}`)
        .join("\n"),
      organiserBookingUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}
