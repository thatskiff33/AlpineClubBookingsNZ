/**
 * #4211 (`INV-PAY-043`): the admin alert for a card capture the duplicate-capture
 * guard KEPT on a paid booking because it has no usable record of which payment
 * settled it - while another payment on the booking still holds money, or with
 * a recorded settler that no longer holds money and nothing else holding any,
 * when this payment may now be the one paying for the booking.
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-settlement.ts`
 * sends it); its own module for size.
 */
import { escapeHtml } from "./escape";
import { alertBox, button, formatCents, heading, infoTable, layout, paragraph } from "./layout";
import {
  DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK,
  duplicateCaptureKeptAction,
  duplicateCaptureKeptParagraph,
  type DuplicateCaptureKeptReason,
} from "@/lib/duplicate-capture-kept-note";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

// ---- #4211: Admin Alert — booking may have been paid twice, check by hand ----
//
// Its OWN template, not the generic payment-failure mail it first shipped as:
// nothing failed, and a payment may be held twice (#2761's finding about that
// subject). Nothing was refunded, so this mail is what pulls a person to it.
export function adminDuplicateCaptureKeptTemplate(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  bookingId: string;
  reason: DuplicateCaptureKeptReason;
  /** The capture that arrived and was kept. */
  amountCents: number;
  paymentIntentId: string;
  /** The other payment holding money; null for a cash or bank payment. */
  otherPaymentIntentId: string | null;
  /** False when nothing else holds money (a released settler, this payment alone). */
  otherHoldsMoney?: boolean;
  bookingUrl: string;
  reviewUrl: string;
},
  format: ClubFormat,
): string {
  return layout(`
    ${heading("Booking May Have Been Paid Twice — Check By Hand")}
    ${alertBox(
      "A card payment was kept on a booking that was already paid. Nothing was refunded automatically — please check.",
      "warning"
    )}
    ${
      // The SAME sentence the {{duplicateCaptureKeptNote}} token renders (#2268).
      paragraph(
        duplicateCaptureKeptParagraph({
          reason: data.reason,
          otherPaymentIntentId: data.otherPaymentIntentId,
          otherHoldsMoney: data.otherHoldsMoney,
        }),
      )
    }
    ${paragraph(duplicateCaptureKeptAction({ otherHoldsMoney: data.otherHoldsMoney }))}
    ${paragraph(DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK)}
    ${infoTable([
      { label: "Member", value: escapeHtml(data.memberName) },
      { label: "Check-in", value: emailCalendarDay(data.checkIn) },
      { label: "Check-out", value: emailCalendarDay(data.checkOut) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Payment kept", value: formatCents(data.amountCents, format) },
      { label: "Stripe PI", value: escapeHtml(data.paymentIntentId) },
    ])}
    ${button("Open Booking", data.bookingUrl, { sameOrigin: true })}
    ${button("View Payments", data.reviewUrl, { sameOrigin: true })}
  `);
}
