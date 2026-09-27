import { adminInternetBankingHoldKeptTemplate } from "@/lib/email-templates/admin-finance";
import {
  internetBankingHoldKeptParagraph,
  type InternetBankingHoldKeptReason,
} from "../email-message-notes";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { type AdminAlertSendOutcome, sendToAdmins } from "./admin-alerts-shared";
import { stampXeroOrganisation } from "./admin-alert-xero-links";
import { renderEmailHtml } from "@/lib/email-theme";
import {
  emailCalendarDay,
  emailClubDateTime,
} from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3643 (`INV-PAY-107`): the hold-expiry job could not simply release an
 * expired internet banking hold — Xero shows money against its invoice, or
 * could not be read (kept, or released at the bound). Admin audience through
 * `sendToAdmins` on the `adminPaymentFailure` preference, like the other
 * reconcile-by-hand notices. Returns what the send did: the caller holds a
 * once-only claim per hold and reason, and gives it back when nobody who could
 * have been reached was.
 */
export async function sendAdminInternetBankingHoldKeptAlert(data: {
  reason: InternetBankingHoldKeptReason;
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  holdUntil: Date;
  paidCents: number | null;
  amountOwingCents: number | null;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
},
  format: ClubFormat,
): Promise<AdminAlertSendOutcome> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const xeroInvoiceUrl = await stampXeroOrganisation(data.xeroInvoiceUrl);
  const unknown = "unknown";

  return sendToAdmins({
    subject: `Internet banking hold needs attention: ${data.memberName}`,
    html: await renderEmailHtml(() => adminInternetBankingHoldKeptTemplate({
      ...data,
      xeroInvoiceUrl,
      reviewUrl,
    }, format)),
    templateName: "admin-internet-banking-hold-kept",
    templateData: {
      holdKeptNote: internetBankingHoldKeptParagraph(data.reason),
      memberName: data.memberName,
      bookingReference: formatBookingReference(data.bookingId),
      bookingId: data.bookingId,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      holdUntil: emailClubDateTime(data.holdUntil),
      paidAmount:
        data.paidCents === null ? unknown : formatMoneyCents(data.paidCents, format),
      amountOwing:
        data.amountOwingCents === null
          ? unknown
          : formatMoneyCents(data.amountOwingCents, format),
      xeroInvoiceNumber: data.xeroInvoiceNumber ?? unknown,
      xeroObjectUrl: xeroInvoiceUrl ?? "",
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}
