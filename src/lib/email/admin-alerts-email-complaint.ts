import { sendReplayableAdminAlertOnceEver, type EmailComplaintReplayAlert } from "@/lib/admin-alert-once-replayable";
import { adminHref } from "@/lib/admin-hubs";
import { getAppBaseUrl } from "@/lib/app-url";
import {
  EMAIL_COMPLAINT_BLOCK_NOTE,
  emailComplaintEmailNote,
  emailComplaintMemberNames,
  emailComplaintTypeLabel,
} from "@/lib/email-complaint-note";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import { adminEmailComplaintTemplate } from "@/lib/email-templates/admin-email-complaint";
import { emailClubDateTime } from "@/lib/email-templates-club-time";
import { renderEmailHtml } from "@/lib/email-theme";
import logger from "@/lib/logger";
import { shouldSendAdminSystemEmail } from "@/lib/notification-delivery-policies";
import { prisma } from "@/lib/prisma";
import { getAdminAlertEmails, sendToAdmins } from "./admin-alerts-shared";
import type { AdminAlertRecipientsResult } from "./admin-alert-send-result";
import type { DeliveryFeedbackEvent } from "./delivery-feedback";

const EMAIL_COMPLAINT_TEMPLATE_NAME = "admin-email-complaint";

/** The officers who receive it: "Reported issues", Support & System edit (owner decision D4). */
const EMAIL_COMPLAINT_PREFERENCE = "adminIssueReport" as const;

/** At most this many member names are listed; the rest are counted. */
const MAX_MEMBER_NAMES = 5;

/**
 * THE ONE PLACE THE ALERT'S ONCE-ONLY KEY IS MADE: one alert per complaint
 * report, keyed on the address's suppression row (never the address itself,
 * which must not sit in `AlertCooldown`) and the service's id for the report.
 * One alert per blocked address instead is this line without the report part
 * (owner question, #5469 round 3 item 4).
 */
function emailComplaintAlertKey(suppressionId: string, event: DeliveryFeedbackEvent): string {
  return `email-complaint:${suppressionId}:${event.reportId ?? event.providerMessageId ?? "no-report-id"}`;
}

/**
 * #5469 (owner decision D3, 27 Nov 2026): tell officers once that a recipient
 * complained about a club email (usually by marking it as spam), now that the
 * address is blocked. The caller has written the suppression and read it
 * active, outside any transaction.
 *
 * A muted template or an audience nobody is in is final: nothing is stored or
 * sent. Otherwise the alert goes through `sendReplayableAdminAlertOnceEver`,
 * which stores it first and lets the payments cron's sweep re-send it until an
 * officer has it (`INV-INT-042`), so a send that fails, reaches nobody for a
 * passing reason, or whose claim cannot be given back is not lost; a
 * redelivered report finds the claim kept and sends nothing. Never throws.
 */
export async function alertOfficersOfComplaint({
  event,
  suppressionId,
  complainedEmailLogId,
}: {
  event: DeliveryFeedbackEvent;
  suppressionId: string;
  complainedEmailLogId: string | null;
}): Promise<void> {
  const context = { mailService: event.service, reportId: event.reportId, suppressionId };
  try {
    const delivery = await shouldSendAdminSystemEmail({ templateName: EMAIL_COMPLAINT_TEMPLATE_NAME });
    if (!delivery.send || (await getAdminAlertEmails(EMAIL_COMPLAINT_PREFERENCE)).length === 0) {
      logger.info({ ...context, deliveryMode: delivery.mode }, "No officer receives email complaint alerts; none raised");
      return;
    }
  } catch (err) {
    // The replayable send below asks the same questions and keeps the alert for the sweep.
    logger.error({ ...context, err }, "Failed to read who receives email complaint alerts");
  }
  await sendReplayableAdminAlertOnceEver({
    key: emailComplaintAlertKey(suppressionId, event),
    label: "email complaint alert",
    context,
    alert: {
      kind: "email-complaint",
      suppressionId,
      complaintType: event.complaintType ?? "unknown",
      complainedEmailLogId,
    },
  });
}

/** What a send to nobody reports: kept for the sweep, as a passing reason. */
const NOT_SENT: AdminAlertRecipientsResult = {
  deliveryAllowed: true,
  recipients: 0,
  sent: 0,
  queuedForRetry: 0,
  notDelivered: 0,
  failedBeforeLogged: 0,
};

async function memberNamesForAddress(recipient: string): Promise<string> {
  const where = { email: { equals: recipient, mode: "insensitive" as const } };
  const [members, total] = await Promise.all([
    prisma.member.findMany({
      where,
      select: { firstName: true, lastName: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: MAX_MEMBER_NAMES,
    }),
    prisma.member.count({ where }),
  ]);
  return emailComplaintMemberNames(
    members.map((member) => `${member.firstName} ${member.lastName}`.trim()),
    total,
  );
}

/**
 * Build and send the alert from its stored ids, on the first attempt and on
 * every re-send by the sweep. The address is read from the suppression row
 * now; if the block has been lifted meanwhile, every sentence about it would
 * be false, so nothing is sent (and the sweep stops trying after 7 days).
 */
export async function sendAdminEmailComplaintAlert(alert: EmailComplaintReplayAlert): Promise<AdminAlertRecipientsResult> {
  const suppression = await prisma.emailSuppression.findUnique({
    where: { id: alert.suppressionId },
    select: { email: true, suppressedAt: true, clearedAt: true },
  });
  if (!suppression?.suppressedAt || suppression.clearedAt) return NOT_SENT;

  const complainedEmail = alert.complainedEmailLogId
    ? await prisma.emailLog.findUnique({
        where: { id: alert.complainedEmailLogId },
        select: { templateName: true, sentAt: true },
      })
    : null;
  const recipient = suppression.email;
  const data = {
    recipientEmail: recipient,
    complaintType: emailComplaintTypeLabel(alert.complaintType),
    memberNames: await memberNamesForAddress(recipient),
    emailNote: emailComplaintEmailNote(
      complainedEmail && {
        label: getEmailTemplateDefinition(complainedEmail.templateName)?.label ?? complainedEmail.templateName,
        sentAt: complainedEmail.sentAt ? emailClubDateTime(complainedEmail.sentAt) : null,
      },
    ),
    blockNote: EMAIL_COMPLAINT_BLOCK_NOTE,
    deliverabilityUrl: `${getAppBaseUrl()}${adminHref("email-deliverability")}`,
  };
  return sendToAdmins({
    subject: `Complaint about a club email: ${recipient}`,
    html: await renderEmailHtml(() => adminEmailComplaintTemplate(data)),
    templateName: EMAIL_COMPLAINT_TEMPLATE_NAME,
    templateData: data,
    preferenceKey: EMAIL_COMPLAINT_PREFERENCE,
  });
}
