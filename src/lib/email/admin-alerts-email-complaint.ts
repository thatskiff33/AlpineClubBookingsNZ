import { readOnceEverClaimState, sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { adminHref } from "@/lib/admin-hubs";
import { getAppBaseUrl } from "@/lib/app-url";
import {
  EMAIL_COMPLAINT_BLOCK_NOTE,
  emailComplaintEmailNote,
  emailComplaintMemberNames,
} from "@/lib/email-complaint-note";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import { adminEmailComplaintTemplate } from "@/lib/email-templates/admin-email-complaint";
import { emailClubDateTime } from "@/lib/email-templates-club-time";
import { renderEmailHtml } from "@/lib/email-theme";
import { prisma } from "@/lib/prisma";
import { sendToAdmins } from "./admin-alerts-shared";
import type { AdminAlertRecipientsResult } from "./admin-alert-send-result";
import type { DeliveryFeedbackEvent } from "./delivery-feedback";

const EMAIL_COMPLAINT_TEMPLATE_NAME = "admin-email-complaint";

/** At most this many member names are listed for one address. */
const MAX_MEMBER_NAMES = 5;

/** Thrown so the webhook answers with an error and the mail service delivers the report again. */
class EmailComplaintAlertNotSentError extends Error {
  constructor(key: string) {
    super(`The officers' alert for email complaint ${key} was not sent; the report will be delivered again`);
    this.name = "EmailComplaintAlertNotSentError";
  }
}

/** One complaint, one alert: the service, its id for the report (or the message), and the address. */
function emailComplaintAlertKey(event: DeliveryFeedbackEvent, recipient: string): string {
  const reportKey = event.reportId ?? event.providerMessageId ?? "no-report-id";
  return `email-complaint:${event.service}:${reportKey}:${recipient}`;
}

async function memberNamesForAddress(recipient: string): Promise<string[]> {
  const members = await prisma.member.findMany({
    where: { email: { equals: recipient, mode: "insensitive" } },
    select: { firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: MAX_MEMBER_NAMES,
  });
  return members.map((member) => `${member.firstName} ${member.lastName}`.trim());
}

/**
 * #5469 (owner decision D3, 27 Nov 2026): tell officers once that a recipient
 * complained about a club email (usually by marking it as spam), now that the
 * address is blocked. The caller has written the suppression and checked it is
 * active, outside any transaction.
 *
 * Audience: the `adminIssueReport` preference ("Reported issues", Support &
 * System edit), because that area owns the Email Deliverability page where a
 * block is seen and lifted, so everyone the alert reaches can act on it.
 *
 * Once per complaint through `sendAdminAlertOnceEver`, keyed on the report.
 * A redelivered report finds the claim kept and sends nothing. When the claim
 * was not kept and nothing holds it (the send threw, or reached nobody and
 * wrote no row the retry job could replay), this throws, so the webhook answers
 * with an error, releases its lease, and the mail service delivers the report
 * again; the suppression and the marking are idempotent, so only the alert is
 * retried. A claim deferred for a day because nobody can receive the alert is
 * left as it is.
 */
export async function alertOfficersOfComplaint({
  event,
  recipient,
  complainedEmail,
}: {
  event: DeliveryFeedbackEvent;
  recipient: string;
  complainedEmail: { templateName: string; sentAt: Date | null } | null;
}): Promise<void> {
  const key = emailComplaintAlertKey(event, recipient);
  const context = { mailService: event.service, reportId: event.reportId, providerMessageId: event.providerMessageId };
  const kept = await sendAdminAlertOnceEver({
    key,
    label: "email complaint alert",
    context,
    send: () => sendAdminEmailComplaintAlert({ recipient, complainedEmail }),
  });
  if (kept) return;
  const state = await readOnceEverClaimState(key, new Date());
  if (state === "none" || state === "awaiting-send") throw new EmailComplaintAlertNotSentError(key);
}

async function sendAdminEmailComplaintAlert({
  recipient,
  complainedEmail,
}: {
  recipient: string;
  complainedEmail: { templateName: string; sentAt: Date | null } | null;
}): Promise<AdminAlertRecipientsResult> {
  const memberNames = emailComplaintMemberNames(await memberNamesForAddress(recipient));
  const emailNote = emailComplaintEmailNote(
    complainedEmail && {
      label: getEmailTemplateDefinition(complainedEmail.templateName)?.label ?? complainedEmail.templateName,
      sentAt: complainedEmail.sentAt ? emailClubDateTime(complainedEmail.sentAt) : null,
    },
  );
  const deliverabilityUrl = `${getAppBaseUrl()}${adminHref("email-deliverability")}`;
  const data = {
    recipientEmail: recipient,
    memberNames,
    emailNote,
    blockNote: EMAIL_COMPLAINT_BLOCK_NOTE,
    deliverabilityUrl,
  };
  return sendToAdmins({
    subject: `Complaint about a club email: ${recipient}`,
    html: await renderEmailHtml(() => adminEmailComplaintTemplate(data)),
    templateName: EMAIL_COMPLAINT_TEMPLATE_NAME,
    templateData: data,
    preferenceKey: "adminIssueReport",
  });
}
