import { adminInternetBankingHoldKeptTemplate } from "@/lib/email-templates/admin-finance";
import {
  internetBankingHoldKeptParagraph,
  type InternetBankingHoldKeptReason,
} from "../email-message-notes";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendToAdmins } from "./admin-alerts-shared";
import { stampXeroOrganisation } from "./xero-org-stamp";
import { renderEmailHtml } from "@/lib/email-theme";
import {
  emailCalendarDay,
  emailClubDateTime,
} from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3643 (`INV-PAY-107`): the hold-expiry job kept an internet banking booking
 * it would otherwise have cancelled, because Xero shows money against its
 * invoice or could not be read. Admin audience through `sendToAdmins` on the
 * `adminPaymentFailure` preference, like the other reconcile-by-hand notices:
 * no money moved, the booking simply stays held. The caller claims a
 * per-hold, per-reason cooldown first, so this is once per situation.
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
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const xeroInvoiceUrl = await stampXeroOrganisation(data.xeroInvoiceUrl);
  const unknown = "unknown";

  await sendToAdmins({
    subject: `Internet banking hold kept, booking not cancelled: ${data.memberName}`,
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
