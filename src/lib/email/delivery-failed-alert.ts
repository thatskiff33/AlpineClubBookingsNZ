import { adminEmailDeliveryFailedTemplate } from "@/lib/email-templates/admin-ops";
import { renderEmailHtml } from "@/lib/email-theme";

/** The alert's own template: an alert about a failed alert is never raised. */
const DELIVERY_FAILED_ALERT_TEMPLATE = "admin-email-failure";

/**
 * Tell every officer that an email will not reach its recipient without them:
 * its retries ran out, or (#5298, INV-INT-043) a send interrupted by a crash
 * was found stranded. One writer for both, so the audience, the locked
 * template and the never-throw rule cannot drift apart.
 *
 * Never throws: it is called from a cron loop that must carry on. Skipped for
 * the alert's own template, so a failing alert cannot raise another.
 */
export async function alertOfficersOfUndeliveredEmail(params: {
  recipient: string;
  templateName: string;
  attemptCount: number;
  stranded?: "unconfirmed" | "never_sent";
}): Promise<void> {
  if (params.templateName === DELIVERY_FAILED_ALERT_TEMPLATE) return;
  try {
    // Imported dynamically: the mailer's barrel reaches the retry cron's callers.
    const { sendEmail, getAdminEmails } = await import("@/lib/email");
    // #2548: the shared resolver, so this system-failure alert reaches the
    // same audience as every other one - access-role resolved, with
    // definition-backed custom roles included.
    const admins = await getAdminEmails();
    for (const adminEmail of admins) {
      await sendEmail({
        to: adminEmail,
        subject:
          params.stranded === "unconfirmed"
            ? "Email delivery not confirmed"
            : "Email delivery permanently failed",
        html: await renderEmailHtml(() => adminEmailDeliveryFailedTemplate(params)),
        // Admin failure alert: never withheld by a booking flag (#2258).
        bookingContext: "none",
        templateName: DELIVERY_FAILED_ALERT_TEMPLATE,
        templateData: {
          originalRecipient: params.recipient,
          originalTemplateName: params.templateName,
          attemptCount: params.attemptCount,
        },
      }).catch(() => {}); // Don't let alert failure break the cron
    }
  } catch {
    // Non-critical
  }
}
