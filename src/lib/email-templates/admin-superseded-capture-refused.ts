/**
 * #4300 (`INV-PAY-138`): the admin alert for a card payment the settle REFUSED
 * because an edit had replaced the payment it was made on - the superseded
 * machinery returns it, and the booking was not settled with it.
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-settlement.ts`
 * sends it); its own module for size.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, formatCents, heading, infoTable, layout, paragraph } from "./layout";
import { supersededCaptureRefusedAction, supersededCaptureRefusedParagraph } from "@/lib/superseded-capture-refused-note";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

// ---- #4300: Admin Alert — a payment on a replaced payment was not applied ----
//
// Its OWN template, not the generic payment-failure mail it first shipped as:
// nothing failed, and the subject must say which payment was not applied
// (#2761's finding about "Payment Failed").
export function adminSupersededCaptureRefusedTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  bookingCancelled: boolean;
  amountCents: number;
  paymentIntentId: string;
  bookingUrl: string;
  reviewUrl: string;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Card Payment On A Replaced Payment — Not Applied")}
    ${alertBox(
      "A card payment was taken on a payment that a later change to this booking had replaced, so it was not applied to the booking.",
      "warning"
    )}
    ${
      // The SAME sentence the {{supersededCaptureNote}} token renders (#2268).
      paragraph(supersededCaptureRefusedParagraph({ bookingCancelled: data.bookingCancelled }))
    }
    ${paragraph(supersededCaptureRefusedAction({ bookingCancelled: data.bookingCancelled }))}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Payment not applied", value: formatCents(data.amountCents, format) },
      { label: "Stripe PI", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("Open Booking", data.bookingUrl, { sameOrigin: true })}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}
