/**
 * #3638: the admin alert for a booking a card payment settled and Xero then
 * reported paid as well. Split from `admin-alerts-finance.ts` by size; the
 * barrel (`./admin-alerts`) re-exports it with the rest of the family.
 */
import { adminSecondInstrumentSettlementConflictTemplate } from "@/lib/email-templates/admin-finance";
import { secondInstrumentConflictOutcomeParagraph } from "../email-message-notes";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendUnmuteableAdminAlert } from "./admin-alerts-shared";
import { stampXeroOrganisation } from "./admin-alert-xero-links";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3638 (`INV-PAY-102`): a card payment settled the booking and Xero then
 * reported its Internet Banking invoice paid as well — the club may hold the
 * price twice. It first shipped as a generic "Payment Failed" mail through
 * `sendAdminPaymentFailureAlert`, which misdescribed the event (#2761's
 * finding) and let the `adminPaymentFailure` checkbox mute it.
 *
 * ITS OWN SUBJECT, naming the double payment. NOT GATED ON A NOTIFICATION
 * PREFERENCE, and delivery-locked in the registry, through
 * `sendUnmuteableAdminAlert` — the #2774 reasoning: this is the one thing that
 * pulls a person to reconcile money the club may hold twice, and the system
 * refunds nothing on its own. Same audience as its siblings: whoever can edit
 * finance.
 *
 * Repeat sends are throttled by the caller with a cross-instance AlertCooldown
 * claim keyed on (payment, invoice). #2262's sibling alert
 * (`sendAdminManualSettlementConflictAlert`) is unchanged: its registry entry
 * records a deliberate decision not to lock it.
 */
export async function sendAdminSecondInstrumentSettlementConflictAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  bookingStatus: string;
  conflictKind: "settled" | "cancelledAfterCard" | "cancelledAfterRefund";
  invoiceAmountCents: number;
  cardHeldCents: number;
  cardPaymentIntentId: string | null;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
},
  format: ClubFormat,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}/admin/payments`;
  const bookingUrl = `${baseUrl}/bookings/${data.bookingId}`;
  const xeroInvoiceUrl = await stampXeroOrganisation(data.xeroInvoiceUrl);

  await sendUnmuteableAdminAlert({
    subject: `Booking may have been paid twice — card and Xero: ${data.memberName}`,
    html: await renderEmailHtml(() =>
      adminSecondInstrumentSettlementConflictTemplate(
        { ...data, xeroInvoiceUrl, bookingUrl, reviewUrl },
        format,
      ),
    ),
    templateName: "admin-second-instrument-settlement-conflict",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingId: data.bookingId,
      status: data.bookingStatus,
      amount: formatMoneyCents(data.invoiceAmountCents, format),
      paidAmount: formatMoneyCents(data.cardHeldCents, format),
      paymentIntentId: data.cardPaymentIntentId ?? "",
      xeroInvoiceNumber: data.xeroInvoiceNumber ?? "",
      xeroObjectUrl: xeroInvoiceUrl ?? "",
      bookingUrl,
      reviewUrl,
      // The same sentence the hand-built HTML renders, so an admin's saved
      // default cannot describe the other case (#2268 convention).
      secondInstrumentConflictNote: secondInstrumentConflictOutcomeParagraph(
        data.conflictKind,
      ),
    },
    requirement: { area: "finance", level: "edit" },
  });
}
