import { CLUB_NAME } from "@/config/club-identity";
import { bookingOwnerEmailContext } from "@/lib/booking-email-contract";
import type { ClubFormat } from "@/lib/club-format";
import { sendEmail } from "@/lib/email/core";
import { escapeHtml } from "@/lib/email-templates/escape";
import {
  heading,
  infoTable,
  layout,
  paragraph,
  supportContactSentence,
} from "@/lib/email-templates/layout";
import { renderEmailHtml } from "@/lib/email-theme";
import type { OrganiserBilling } from "@/lib/organiser-billing";
import { formatCents } from "@/lib/utils";

/**
 * #4299: the organiser owes an extra invoice for a place in their Internet
 * Banking group. Attribution is to their own booking, never the joiner's
 * private booking: sendEmail persists that identity for retry-time authority.
 * Call this on invoice recovery too; an existing invoice proves no notice was
 * queued. The deterministic log id fences re-drives and concurrent callers.
 */
export async function sendOrganiserExtraInvoiceEmail(params: {
  billing: Pick<OrganiserBilling, "organiserMemberId" | "organiserBookingId"> & {
    organiser: Pick<OrganiserBilling["organiser"], "firstName" | "email">;
  };
  bookingModificationId: string;
  invoiceId: string;
  invoiceNumber?: string | null;
  amountCents: number;
  format: ClubFormat;
  placeName: string;
  changeDescription: string;
}) {
  const data = {
    firstName: params.billing.organiser.firstName,
    joinerName: params.placeName,
    changeSummary: params.changeDescription,
    additionalAmount: formatCents(params.amountCents, params.format),
    xeroInvoiceNumber: params.invoiceNumber || params.invoiceId,
  };
  return sendEmail({
    to: params.billing.organiser.email,
    subject: `Extra invoice for your group booking — ${CLUB_NAME}`,
    templateName: "group-organiser-extra-invoice",
    templateData: data,
    bookingContext: bookingOwnerEmailContext(
      params.billing.organiserBookingId,
      params.billing.organiserMemberId,
    ),
    idempotencyKey: params.bookingModificationId,
    deferDelivery: true,
    html: await renderEmailHtml(() => layout(`
      ${heading("Extra Invoice for Your Group Booking")}
      ${paragraph(`Hi ${escapeHtml(data.firstName)}, a change to a place in the group you paid for by internet banking has increased its cost. As the group organiser, you are responsible for this extra payment.`)}
      ${infoTable([
        { label: "Place", value: escapeHtml(data.joinerName) },
        { label: "Change", value: escapeHtml(data.changeSummary) },
        { label: "Extra amount to pay", value: escapeHtml(data.additionalAmount) },
        { label: "Invoice reference", value: escapeHtml(data.xeroInvoiceNumber) },
      ])}
      ${paragraph("Please pay this extra invoice by internet banking, quoting the invoice reference above.")}
      ${supportContactSentence("If you need the club's bank details or think this invoice is wrong, contact the club at ")}
    `)),
  });
}
