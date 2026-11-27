import { adminBookingMoneyCensusTemplate } from "@/lib/email-templates/admin-booking-money-census";
import { sendToAdmins } from "./admin-alerts-shared";
import type { AdminAlertRecipientsResult } from "./admin-alert-send-result";
import { adminHref } from "@/lib/admin-hubs";
import {
  bookingMoneyCensusClassFindings,
  bookingMoneyCensusClassLine,
  describeBookingMoneyCensusClass,
  type BookingMoneyCensusClassSummary,
} from "@/lib/booking-money-census-summary";
import { renderEmailHtml } from "@/lib/email-theme";

/**
 * #4910 (`INV-PAY-163`): the nightly booking money check found something it
 * has not reported before. Admin audience through `sendToAdmins` on the
 * `adminPaymentFailure` preference, like the other reconcile-by-hand finance
 * alerts. `classes` is already cut to the ids one class may name, so the email
 * stays bounded however many findings a first run reports. Returns what
 * happened to each recipient, so the caller's once-ever claim is kept, held or
 * given back accordingly.
 */
export async function sendAdminBookingMoneyCensusAlert(data: {
  newFindings: number;
  classes: readonly BookingMoneyCensusClassSummary[];
}): Promise<AdminAlertRecipientsResult> {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const reviewUrl = `${baseUrl}${adminHref("stuck-states")}`;
  return sendToAdmins({
    subject: `Booking money check: ${data.newFindings} new`,
    html: await renderEmailHtml(() =>
      adminBookingMoneyCensusTemplate({
        newFindings: data.newFindings,
        classes: data.classes.map((entry) => ({
          label: describeBookingMoneyCensusClass(entry),
          findings: bookingMoneyCensusClassFindings(entry),
        })),
        reviewUrl,
      }),
    ),
    templateName: "admin-booking-money-census",
    templateData: {
      count: String(data.newFindings),
      details: data.classes.map(bookingMoneyCensusClassLine).join("\n"),
      reviewUrl,
    },
    preferenceKey: "adminPaymentFailure",
  });
}
