import { adminInternetBankingHoldStartedStayTemplate } from "@/lib/email-templates/admin-internet-banking-started-stay";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendToAdmins } from "./admin-alerts-shared";
import { type AdminAlertSendResult } from "./admin-alert-send-result";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3663 (`INV-PAY-016`): an expired internet banking hold whose stay has
 * started was left alone for reconciliation by hand. Admin audience through
 * `sendToAdmins` on the `adminPaymentFailure` preference, like the other
 * reconcile-by-hand notices. Returns what happened to each recipient, so the
 * caller's once-per-payment claim is kept, deferred or given back accordingly.
 */
export async function sendAdminInternetBankingHoldStartedStayAlert(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  holdUntil: Date | null;
  amountOwingCents: number;
},
  format: ClubFormat,
): Promise<AdminAlertSendResult> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;

  return sendToAdmins({
    subject: "Overdue internet-banking hold on a stay that has started",
    html: await renderEmailHtml(() =>
      adminInternetBankingHoldStartedStayTemplate({ ...data, reviewUrl }, format),
    ),
    templateName: "admin-internet-banking-hold-started-stay",
    templateData: {
      memberName: data.memberName,
      bookingReference: formatBookingReference(data.bookingId),
      bookingId: data.bookingId,
      checkIn: emailCalendarDay(data.checkIn),
      holdUntil: data.holdUntil ? emailClubDateTime(data.holdUntil) : "none",
      amountOwing: formatMoneyCents(data.amountOwingCents, format),
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}
