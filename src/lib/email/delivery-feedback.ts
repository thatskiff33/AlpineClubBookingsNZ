import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  getActiveEmailSuppression,
  normalizeEmailAddress,
  recordSesEmailFeedback,
  type SesEmailFeedbackEvent,
} from "@/lib/email-suppression";
import { MAIL_SERVICE_LABEL, type MailService } from "./provider-message-id";

/**
 * #5469: THE ONE RULE FOR A BOUNCE OR COMPLAINT REPORT, whichever mail service
 * sent it. Each service has an adapter that turns its own report into a
 * `DeliveryFeedbackEvent` (SES: `ses-feedback.ts`, reached from the SNS
 * webhook); this module is the only place the event is acted on. Adding a
 * service is an adapter, a route and a `provider-message-id.ts` entry; nothing
 * here changes.
 *
 * - Suppression, exactly as before: a complaint or a permanent bounce
 *   suppresses the address at once, a temporary bounce from the second one
 *   (`email-suppression.ts`). Further sends are stopped by that record, which
 *   the email core and the retry job check before every send, not by any row's
 *   status.
 * - A bounce marks `BOUNCED` only the email the report names (owner decision,
 *   option A, 27 Nov 2026): the row whose stored server id matches, or, for a
 *   row with no stored id, the one whose Message-ID header the report carries.
 *   Every other row to the address keeps its status. A report that names no
 *   email we can find marks nothing.
 * - A complaint marks nothing (owner decision D3, 27 Nov 2026): the email
 *   arrived, so its row keeps saying sent. Officers are told once instead
 *   (`alertOfficersOfComplaint`).
 */

/** What a report says happened. A service's "undetermined" bounce is a temporary one, as before. */
export type DeliveryFeedbackKind = "permanent-bounce" | "temporary-bounce" | "complaint";

export type DeliveryFeedbackEvent = {
  service: MailService;
  kind: DeliveryFeedbackKind;
  /** The addresses the report is about, as the service gave them. */
  recipients: string[];
  /** The id the service gave the message when it accepted it (`EmailLog.providerMessageId`). */
  providerMessageId: string | null;
  /** Message-ID headers the app sent, when the report carries the original headers. */
  sentMessageIds: string[];
  /** The service's own id for this report, which makes one complaint one alert. */
  reportId: string | null;
  /** The service's own labels, recorded on the suppression for operators. */
  providerDetail: {
    bounceType: string | null;
    bounceSubType: string | null;
    complaintFeedbackType: string | null;
  };
};

/**
 * Statuses a bounce may move to `BOUNCED`. A row already `BOUNCED` is not
 * matched, so a repeat of the same report writes nothing (`INV-INT-039`); a
 * withheld row was never sent and keeps saying so.
 */
const BOUNCE_MARKABLE_STATUSES = ["QUEUED", "SENT", "FAILED"] as const;

/**
 * Each header id bare and in angle brackets, so the form a report uses does
 * not decide the match. Blank values are dropped.
 */
function headerIdCandidates(sentMessageIds: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const value of sentMessageIds) {
    const bare = value.trim().replace(/^<\s*/, "").replace(/\s*>$/, "").trim();
    if (!bare) continue;
    ids.add(bare);
    ids.add(`<${bare}>`);
  }
  return Array.from(ids);
}

/**
 * THE ONE ANSWER TO "WHICH EMAIL IS THIS REPORT ABOUT", as `EmailLog` filters
 * tried in order: the stored server id, then (for a row that stored none: sent
 * before #5469, by the previous release, or through a server the app does not
 * recognise) the Message-ID header the app sent. The address never decides:
 * the ids name one message, and the contact form logs a label in place of the
 * address. Empty when the report names nothing usable.
 */
function emailLogFiltersNamedByReport(event: DeliveryFeedbackEvent) {
  const filters: Array<{ providerMessageId: string } | { providerMessageId: null; messageId: { in: string[] } }> = [];
  const serverId = event.providerMessageId?.trim();
  if (serverId) filters.push({ providerMessageId: serverId });
  const headerIds = headerIdCandidates(event.sentMessageIds);
  if (headerIds.length > 0) filters.push({ providerMessageId: null, messageId: { in: headerIds } });
  return filters;
}

/** Mark the email a bounce names, by the first filter that finds it. */
async function markBouncedEmail(event: DeliveryFeedbackEvent): Promise<number> {
  for (const filter of emailLogFiltersNamedByReport(event)) {
    const { count } = await prisma.emailLog.updateMany({
      where: { ...filter, status: { in: [...BOUNCE_MARKABLE_STATUSES] } },
      data: {
        status: "BOUNCED",
        errorMessage: `${event.kind === "permanent-bounce" ? "Permanent" : "Temporary"} bounce reported by ${MAIL_SERVICE_LABEL[event.service]}`,
      },
    });
    if (count > 0) return count;
  }
  return 0;
}

/** The email a complaint names, read and left as it is, or null. */
async function findComplainedEmail(event: DeliveryFeedbackEvent) {
  for (const filter of emailLogFiltersNamedByReport(event)) {
    const row = await prisma.emailLog.findFirst({
      where: filter,
      select: { templateName: true, sentAt: true },
      orderBy: { createdAt: "desc" },
    });
    if (row) return row;
  }
  return null;
}

/**
 * The suppression writer's input. Permanence follows the event's kind, so an
 * adapter decides it once; the service's own label is kept where it has one.
 */
function suppressionEvent(event: DeliveryFeedbackEvent, email: string): SesEmailFeedbackEvent {
  const complaint = event.kind === "complaint";
  return {
    email,
    reason: complaint ? "COMPLAINT" : "BOUNCE",
    eventType: complaint ? "complaint" : "bounce",
    sesMessageId: event.providerMessageId,
    bounceType:
      event.kind === "permanent-bounce" ? "Permanent" : complaint ? null : event.providerDetail.bounceType,
    bounceSubType: event.providerDetail.bounceSubType,
    complaintFeedbackType: event.providerDetail.complaintFeedbackType,
  };
}

export async function applyDeliveryFeedback(event: DeliveryFeedbackEvent) {
  const recipients = Array.from(
    new Set(event.recipients.map(normalizeEmailAddress).filter(Boolean)),
  );

  const emailLogsMarked = event.kind === "complaint" ? 0 : await markBouncedEmail(event);

  const suppressionResult = await recordSesEmailFeedback(
    recipients.map((email) => suppressionEvent(event, email)),
  );

  // After the suppression is written, outside any transaction (there is none
  // here), so the alert never says the address is blocked before it is.
  if (event.kind === "complaint") {
    const { alertOfficersOfComplaint } = await import("./admin-alerts-email-complaint");
    const complainedEmail = await findComplainedEmail(event);
    for (const recipient of recipients) {
      if (!(await getActiveEmailSuppression(recipient))) continue;
      await alertOfficersOfComplaint({ event, recipient, complainedEmail });
    }
  }

  logger.warn(
    {
      mailService: event.service,
      feedbackKind: event.kind,
      providerMessageId: event.providerMessageId,
      recipients,
      emailLogsMarked,
      suppressionsProcessed: suppressionResult.processed,
      suppressionsActive: suppressionResult.suppressed,
    },
    "Processed email delivery feedback",
  );

  return {
    recipients,
    emailLogsMarked,
    suppressionsProcessed: suppressionResult.processed,
    suppressionsActive: suppressionResult.suppressed,
  };
}
