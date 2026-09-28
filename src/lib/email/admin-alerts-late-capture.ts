import { adminLateCaptureHeldTemplate } from "@/lib/email-templates/admin-finance";
import { formatCents as formatMoneyCents } from "@/lib/utils";
import { sendToAdmins } from "./admin-alerts-shared";
import { renderEmailHtml } from "@/lib/email-theme";
import { emailCalendarDay } from "@/lib/email-templates-club-time";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3639 (delta D7): a late capture on a cancelled booking HELD for a treasurer's
 * approval instead of refunded. Sent once per payment intent - the caller
 * claims it first (`late-capture-refund-hold.ts`) - through the same admin
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
  const reviewUrl = `${baseUrl}/admin/payments`;

  await sendToAdmins({
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
