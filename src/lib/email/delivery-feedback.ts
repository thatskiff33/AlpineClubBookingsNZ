import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  getActiveEmailSuppression,
  normalizeEmailAddress,
  recordEmailFeedbackSuppression,
  type EmailFeedbackSuppressionEvent,
} from "@/lib/email-suppression";
import { MAIL_SERVICE_LABEL, type MailService } from "./provider-message-id";

/**
 * #5469: THE ONE RULE FOR A BOUNCE OR COMPLAINT REPORT, whichever mail service
 * sent it (`INV-INT-043`). Each service has an adapter that turns its own
 * report into a `DeliveryFeedbackEvent` (SES: `ses-feedback.ts`, reached from
 * the SNS webhook); this module is the only place the event is acted on.
 * Adding a service is an adapter, a route and a `provider-message-id.ts`
 * entry; nothing here changes.
 *
 * - Suppression, as before: a complaint or a permanent bounce suppresses the
 *   address at once, a temporary bounce from the second one
 *   (`email-suppression.ts`). Further sends are stopped by that record, which
 *   the email core and the retry job check before every send, not by any row's
 *   status.
 * - A bounce marks `BOUNCED` only the email the report names (owner decision,
 *   option A, 27 Nov 2026): the row whose stored server id matches, or else
 *   the one whose Message-ID header the report carries. Every other row to the
 *   address keeps its status. A report that names no email we can find marks
 *   nothing.
 * - A complaint marks nothing (owner decision D3, 27 Nov 2026): the email
 *   arrived, so its row keeps saying sent. Officers are told once per report,
 *   for each address it names, instead (`alertOfficersOfComplaint`, D4, D6).
 * - A "not spam" report (owner decision D5, 28 Nov 2026), the recipient
 *   moving a club email out of their spam folder, changes nothing: no block,
 *   no mark, no alert.
 */

/**
 * A complaint's type in the app's own words, mapped from the service's by its
 * adapter: `not-given` when the report carries none, `unrecognised` when it
 * carries one the app does not know.
 */
export type ComplaintType = "abuse" | "fraud" | "virus" | "auth-failure" | "other" | "not-given" | "unrecognised";

/** What every report carries, whatever it says happened. */
type DeliveryFeedbackReport = {
  service: MailService;
  /** The addresses the report is about, as the service gave them. */
  recipients: string[];
  /** The id the service gave the message when it accepted it (`EmailLog.providerMessageId`). */
  providerMessageId: string | null;
  /** Message-ID headers the app sent, when the report carries the original headers. */
  sentMessageIds: string[];
  /** The service's own id for this report, which makes one complaint one alert. */
  reportId: string | null;
  /** The service's own labels, recorded on the suppression for operators to read; never decides anything. */
  providerDetail: {
    bounceType: string | null;
    bounceSubType: string | null;
    complaintFeedbackType: string | null;
  };
};

/**
 * What a report says happened, one shape per kind, so a complaint type on a
 * bounce cannot be built. A service's "undetermined" bounce is a temporary
 * one, as the suppression rule has always read it.
 */
export type DeliveryFeedbackEvent = DeliveryFeedbackReport &
  (
    | { kind: "permanent-bounce" | "temporary-bounce" }
    | { kind: "complaint"; complaintType: ComplaintType }
    | { kind: "not-spam-report" }
  );

export type ComplaintFeedbackEvent = Extract<DeliveryFeedbackEvent, { kind: "complaint" }>;

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
 * THE ONE ANSWER TO "WHICH EMAIL IS THIS REPORT ABOUT": the newest row whose
 * stored server id matches; failing that, the newest whose Message-ID header
 * the report carries (a Message-ID names one message), whatever id that row
 * stored. A header match on a row whose stored id differs from the report's
 * means the stored id is not the id the service reports by, so it is logged
 * as a warning. The address never decides: the contact form logs a label in
 * place of it. Null when the report names nothing we can find.
 */
async function findNamedEmailId(event: DeliveryFeedbackEvent): Promise<string | null> {
  const serverId = event.providerMessageId?.trim();
  if (serverId) {
    const byStoredId = await prisma.emailLog.findFirst({
      where: { providerMessageId: serverId },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (byStoredId) return byStoredId.id;
  }
  const headerIds = headerIdCandidates(event.sentMessageIds);
  if (headerIds.length === 0) return null;
  const byHeader = await prisma.emailLog.findFirst({
    where: { messageId: { in: headerIds } },
    select: { id: true, providerMessageId: true },
    orderBy: { createdAt: "desc" },
  });
  if (byHeader && serverId && byHeader.providerMessageId) {
    logger.warn(
      { mailService: event.service, emailLogId: byHeader.id, reportedId: serverId, storedId: byHeader.providerMessageId },
      "A delivery report's Message-ID matched an email whose stored server id differs from the report's; the stored id may not be the id the service reports by (#5469)",
    );
  }
  return byHeader?.id ?? null;
}

/** Mark the email a bounce names; 0 when it names none, or it is already marked. */
async function markBouncedEmail(event: DeliveryFeedbackEvent & { kind: "permanent-bounce" | "temporary-bounce" }): Promise<number> {
  const id = await findNamedEmailId(event);
  if (!id) return 0;
  const { count } = await prisma.emailLog.updateMany({
    where: { id, status: { in: [...BOUNCE_MARKABLE_STATUSES] } },
    data: {
      status: "BOUNCED",
      errorMessage: `${event.kind === "permanent-bounce" ? "Permanent" : "Temporary"} bounce reported by ${MAIL_SERVICE_LABEL[event.service]}`,
    },
  });
  return count;
}

/**
 * The suppression writer's input. Whether it suppresses at once follows the
 * event's kind alone; the service's labels ride along for display.
 */
function suppressionEvent(
  event: DeliveryFeedbackEvent & { kind: "permanent-bounce" | "temporary-bounce" | "complaint" },
  email: string,
): EmailFeedbackSuppressionEvent {
  const labels = {
    email,
    providerMessageId: event.providerMessageId,
    bounceType: event.providerDetail.bounceType,
    bounceSubType: event.providerDetail.bounceSubType,
    complaintFeedbackType: event.providerDetail.complaintFeedbackType,
  };
  return event.kind === "complaint"
    ? { ...labels, reason: "COMPLAINT", eventType: "complaint" }
    : { ...labels, reason: "BOUNCE", eventType: "bounce", permanentBounce: event.kind === "permanent-bounce" };
}

export async function applyDeliveryFeedback(event: DeliveryFeedbackEvent) {
  const recipients = Array.from(
    new Set(event.recipients.map(normalizeEmailAddress).filter(Boolean)),
  );

  if (event.kind === "not-spam-report") {
    logger.info(
      { mailService: event.service, providerMessageId: event.providerMessageId, reportId: event.reportId },
      "A recipient marked a club email as not spam; nothing changed (#5469 D5)",
    );
    return { recipients, emailLogsMarked: 0, suppressionsProcessed: 0, suppressionsActive: 0 };
  }

  const emailLogsMarked = event.kind === "complaint" ? 0 : await markBouncedEmail(event);

  const suppressionResult = await recordEmailFeedbackSuppression(
    recipients.map((email) => suppressionEvent(event, email)),
  );

  // After the suppression is written, outside any transaction (there is none
  // here), and only while it is active, so the alert never says an address is
  // blocked when it is not. One alert per report for each address it names.
  if (event.kind === "complaint") {
    const { alertOfficersOfComplaint } = await import("./admin-alerts-email-complaint");
    const complainedEmailLogId = await findNamedEmailId(event);
    for (const recipient of recipients) {
      const suppression = await getActiveEmailSuppression(recipient);
      if (!suppression) continue;
      await alertOfficersOfComplaint({ event, suppressionId: suppression.id, complainedEmailLogId });
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
