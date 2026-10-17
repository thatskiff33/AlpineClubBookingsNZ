/**
 * #4210 (`INV-PAY-136`): the admin alert for a card refund Stripe failed after
 * a "Paid another way" close had already settled it. Its own template and an
 * honest subject, never the generic payment-failure mail: the member has
 * usually had the money once already, and paying them again pays them twice.
 * The sentence that says what was decided is shared with the
 * `{{paidAnotherWayFailedLaterNote}}` token (`card-refund-failed-later-paid-another-way-note.ts`).
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-card-refund.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, formatCents, heading, infoTable, layout, paragraph } from "./layout";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

export function adminCardRefundFailedAfterPaidAnotherWayTemplate(
  data: {
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    bookingId: string;
    amountCents: number;
    note: string;
    reviewUrl: string;
  },
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Card Refund Failed After It Was Paid Back Another Way")}
    ${alertBox("Stripe failed a card refund on a booking whose card refund the treasurer had closed as paid another way. Check before paying the member anything more.", "warning")}
    ${paragraph(escapeHtml(data.note))}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Card refund that failed", value: formatCents(data.amountCents, format) },
    ])}
    ${button("Open Stuck States", data.reviewUrl, { sameOrigin: true })}
  `);
}
