/**
 * #3643 (`INV-PAY-107`): the admin alert for an expired internet banking hold
 * the hold-expiry job could not simply release. Split from `./admin-finance`
 * for size; same layout helpers, same sender family
 * (`src/lib/email/admin-alerts-internet-banking.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, formatCents, heading, infoTable, layout } from "./layout";
import {
  internetBankingHoldKeptParagraph,
  type InternetBankingHoldKeptReason,
} from "@/lib/email-message-notes";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import type { ClubFormat } from "@/lib/club-format";

// ---- #3643: Admin Alert — expired internet banking hold kept ----
//
// The hold-expiry job could not simply release an expired hold: money may be
// paid against its invoice, or Xero could not be read (`INV-PAY-107`). The
// reason paragraph is the whole instruction; the table carries what the
// treasurer needs to find the money.
export function adminInternetBankingHoldKeptTemplate(data: {
  reason: InternetBankingHoldKeptReason;
  memberName: string;
  bookingId: string;
  checkIn: Date;
  checkOut: Date;
  holdUntil: Date;
  /** Null when Xero could not be read, so nobody knows. */
  paidCents: number | null;
  amountOwingCents: number | null;
  xeroInvoiceNumber: string | null;
  xeroInvoiceUrl: string | null;
  reviewUrl: string;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Internet Banking Hold Needs Attention")}
    ${alertBox(internetBankingHoldKeptParagraph(data.reason), "warning")}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      {
        label: "Booking",
        value: `${escapeHtml(formatBookingReference(data.bookingId))} (${escapeHtml(data.bookingId)})`,
      },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Hold deadline", value: emailClubDateTime(data.holdUntil) },
      {
        label: "Paid so far",
        value: data.paidCents === null ? "unknown" : formatCents(data.paidCents, format),
      },
      {
        label: "Still owing",
        value:
          data.amountOwingCents === null
            ? "unknown"
            : formatCents(data.amountOwingCents, format),
      },
      {
        label: "Xero invoice",
        value: data.xeroInvoiceNumber ? escapeHtml(data.xeroInvoiceNumber) : "unknown",
      },
    ])}
    ${data.xeroInvoiceUrl ? button("Open the invoice in Xero", data.xeroInvoiceUrl) : ""}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}
