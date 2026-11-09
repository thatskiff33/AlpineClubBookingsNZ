import { adminLateCaptureHeldTemplate } from "@/lib/email-templates/admin-finance";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendToAdmins, sendUnmuteableAdminAlert } from "./admin-alerts-shared";
import { adminLateCaptureRefundedOutsideAppTemplate } from "@/lib/email-templates/admin-late-capture-outside-app";
import { LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE } from "@/lib/late-capture-outside-app-note";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";
import { adminHref } from "@/lib/admin-hubs";

/**
 * #3639 (delta D7): a late capture on a cancelled booking HELD for a treasurer's
 * approval instead of refunded. Sent once per payment intent - the caller
 * claims it through `sendAdminAlertOnceEver` (`late-capture-refund-hold.ts`),
 * which reads the returned result to keep, defer or give back the claim - through the same admin
 * channel and preference as the hand-back task alert it sits beside. It moves
 * no money; the task on the payments board is the record.
 */
export async function sendAdminLateCaptureHeldAlert(data: {
  memberName: string;
  checkIn: Date;
  checkOut: Date;
  amountCents: number;
  bookingId: string;
},
  format: ClubFormat,
) {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("payments")}`;

  return sendToAdmins({
    subject: `Late payment held for approval: ${data.memberName}`,
    html: await renderEmailHtml(() => adminLateCaptureHeldTemplate({ ...data, reviewUrl }, format)),
    templateName: "admin-late-capture-held",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      amount: formatMoneyCents(data.amountCents, format),
      bookingId: data.bookingId,
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}

/**
 * #4170 (`INV-ADDPAY-038`): a late capture refunded OUTSIDE the app (the Stripe
 * dashboard), named by `readUnrecordedLateCaptureRefund`. Its own template and
 * an honest subject, through the UNMUTEABLE sender: money left the club with no
 * record and no Xero note the app could raise, so muting it would leave nobody to
 * reconcile it (#2761). Once ever per capture - the caller claims it through
 * `sendAdminAlertOnceEver`, and the nightly self-heal raises a claim not held again.
 */
export async function sendAdminLateCaptureRefundedOutsideAppAlert(
  data: {
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    bookingId: string;
    paymentIntentId: string;
    refundedCents: number;
  },
  format: ClubFormat,
): Promise<void> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("payments")}`;
  await sendUnmuteableAdminAlert({
    subject: `Late payment refunded outside the app - check Xero: ${data.memberName}`,
    html: await renderEmailHtml(() => adminLateCaptureRefundedOutsideAppTemplate({ ...data, reviewUrl }, format)),
    templateName: "admin-late-capture-refunded-outside-app",
    templateData: {
      memberName: data.memberName,
      checkIn: emailCalendarDay(data.checkIn),
      checkOut: emailCalendarDay(data.checkOut),
      bookingId: data.bookingId,
      paymentIntentId: data.paymentIntentId,
      amount: formatMoneyCents(data.refundedCents, format),
      outsideAppRefundNote: LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE,
      reviewUrl,
    },
    // The people who reconcile the club's money own it, as every finance alert.
    requirement: { area: "finance", level: "edit" },
  });
}
