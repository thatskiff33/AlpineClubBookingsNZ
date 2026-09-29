/**
 * #3663 (`INV-PAY-016`): the admin alert for an expired internet banking hold
 * the hold-release job left alone because the stay has started. Its own file,
 * split from `./admin-finance` for size; same layout helpers, same sender
 * family (`src/lib/email/admin-alerts-internet-banking-started-stay.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, formatCents, heading, infoTable, layout } from "./layout";
import { emailCalendarDay, emailClubDateTime } from "@/lib/email-templates-club-time";
import { formatBookingReference } from "@/lib/booking-reference";
import type { ClubFormat } from "@/lib/club-format";

/**
 * The instruction paragraph; `email-message-audit-defaults.ts` repeats it as
 * editable copy. The amount is the invoice's, not a balance (#3635 C1): the
 * cron does not read Xero for a started stay, and the app records no part
 * payment of an Internet Banking invoice locally, so it cannot know what is
 * still owed.
 */
const INTERNET_BANKING_HOLD_STARTED_STAY_NOTE =
  "This booking's internet banking payment deadline passed without the app seeing it paid, but its check-in has already arrived, so it was NOT cancelled automatically. The invoice amount below is the amount on the invoice, before any payment the app has not seen: the member may already have paid part or all of it by bank transfer. Check the bank account and Xero for the member's transfer and record it, or cancel the booking by hand.";

export function adminInternetBankingHoldStartedStayTemplate(data: {
  memberName: string;
  bookingId: string;
  checkIn: Date;
  holdUntil: Date | null;
  amountOwingCents: number;
  reviewUrl: string;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Overdue Internet Banking Hold on a Stay That Has Started")}
    ${alertBox(INTERNET_BANKING_HOLD_STARTED_STAY_NOTE, "warning")}
    ${infoTable([
      {
        label: "Booking",
        value: `${escapeHtml(formatBookingReference(data.bookingId))} (${escapeHtml(data.bookingId)})`,
      },
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      {
        label: "Hold deadline",
        value: data.holdUntil ? emailClubDateTime(data.holdUntil) : "none",
      },
      { label: "Invoice amount", value: formatCents(data.amountOwingCents, format) },
    ])}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}
