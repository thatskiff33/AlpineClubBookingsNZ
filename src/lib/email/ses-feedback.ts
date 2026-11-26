import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  normalizeEmailAddress,
  recordSesEmailFeedback,
  type SesEmailFeedbackEvent,
} from "@/lib/email-suppression";

type SesSnsNotification = {
  Type?: string;
  Message?: string;
  notificationType?: string;
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string }>;
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{ emailAddress?: string }>;
  };
  mail?: {
    destination?: string[];
    messageId?: string;
    // Present only when the SES identity's notifications include the original
    // headers. The Message-ID here is the one we sent, before SES replaced it.
    headers?: Array<{ name?: string; value?: string }>;
    commonHeaders?: { messageId?: string };
  };
};

function parseSesSnsNotification(payload: unknown): SesSnsNotification | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const envelope = payload as SesSnsNotification;
  if (typeof envelope.Message === "string") {
    try {
      return parseSesSnsNotification(JSON.parse(envelope.Message));
    } catch {
      return null;
    }
  }

  return envelope;
}

function getSesFeedbackRecipients(
  notification: SesSnsNotification,
  kind: "bounce" | "complaint",
) {
  const recipients =
    kind === "bounce"
      ? notification.bounce?.bouncedRecipients?.map(
          (entry) => entry.emailAddress,
        )
      : notification.complaint?.complainedRecipients?.map(
          (entry) => entry.emailAddress,
        );

  return (recipients ?? notification.mail?.destination ?? []).filter(
    (email): email is string => Boolean(email),
  );
}

/**
 * #5469: THE ONE ANSWER TO "WHICH EMAIL IS THIS FEEDBACK ABOUT", as the
 * `EmailLog.messageId` values that name it. A bounce or complaint marks only
 * that email and leaves the rest of the address's history as it was (owner
 * decision, option A, 27 Nov 2026).
 *
 * What the row stores is the Message-ID header the mail library generated
 * and returned on a successful send (`<random@sender-domain>`). SES replaces
 * that header on the way out and names the message in `mail.messageId` by an
 * id of its own, so the stored value is found only in the original headers
 * (`mail.headers`, `mail.commonHeaders`), which SES includes only when the
 * identity's notifications are set to include them (`CONFIGURATION.md`).
 * `mail.messageId` is offered too, so a row that ever stores SES's own id is
 * matched by the same rule.
 *
 * Each id is offered bare and in angle brackets, so the form a header or SES
 * uses does not decide the match. The id alone decides, not the address: it
 * names one message, and the contact form logs a label in place of the
 * address. An empty list means the feedback names no email we can find:
 * nothing is marked. Either way, further sends to the address are stopped by
 * its suppression record, not by any row's status: the email core and the
 * retry job check it before every send. A complaint or a permanent bounce
 * suppresses at once; a temporary bounce from the second one on
 * (`email-suppression.ts`).
 */
function emailLogMessageIdsNamedByFeedback(
  mail: SesSnsNotification["mail"],
): string[] {
  const raw = [
    mail?.messageId,
    mail?.commonHeaders?.messageId,
    ...(mail?.headers ?? [])
      .filter((header) => header.name?.trim().toLowerCase() === "message-id")
      .map((header) => header.value),
  ];
  const ids = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const bare = value.trim().replace(/^<\s*/, "").replace(/\s*>$/, "").trim();
    if (!bare) continue;
    ids.add(bare);
    ids.add(`<${bare}>`);
  }
  return Array.from(ids);
}

/**
 * Statuses a feedback notification may move to `BOUNCED`. A row already
 * `BOUNCED` is not matched, so a repeat of the same notification writes
 * nothing (`INV-INT-039`); a withheld row was never sent and keeps saying so.
 */
const FEEDBACK_MARKABLE_STATUSES = ["QUEUED", "SENT", "FAILED"] as const;

export async function ingestSesSnsEmailFeedback(payload: unknown) {
  const notification = parseSesSnsNotification(payload);
  if (!notification) {
    return { handled: false as const };
  }
  const notificationType = notification.notificationType?.toLowerCase();
  if (notificationType !== "bounce" && notificationType !== "complaint") {
    return { handled: false as const };
  }

  const recipients = getSesFeedbackRecipients(notification, notificationType);
  if (recipients.length === 0) {
    return { handled: false as const };
  }
  const normalizedRecipients = recipients.map(normalizeEmailAddress);

  // Only the email this notification names, matched by its message id and
  // nothing else: the address alone would rewrite every earlier email to it.
  const namedMessageIds = emailLogMessageIdsNamedByFeedback(notification.mail);
  const marked =
    namedMessageIds.length === 0
      ? { count: 0 }
      : await prisma.emailLog.updateMany({
          where: {
            messageId: { in: namedMessageIds },
            status: { in: [...FEEDBACK_MARKABLE_STATUSES] },
          },
          data: {
            status: "BOUNCED",
            errorMessage: `SES ${notificationType} received via SNS`,
          },
        });

  const suppressionResult = await recordSesEmailFeedback(
    normalizedRecipients.map(
      (email): SesEmailFeedbackEvent => ({
        email,
        reason: notificationType === "complaint" ? "COMPLAINT" : "BOUNCE",
        eventType: notificationType,
        sesMessageId: notification.mail?.messageId ?? null,
        bounceType: notification.bounce?.bounceType ?? null,
        bounceSubType: notification.bounce?.bounceSubType ?? null,
        complaintFeedbackType:
          notification.complaint?.complaintFeedbackType ?? null,
      }),
    ),
  );

  logger.warn(
    {
      sesNotificationType: notificationType,
      sesMessageId: notification.mail?.messageId ?? null,
      recipients: normalizedRecipients,
      emailLogsMarked: marked.count,
      suppressionsProcessed: suppressionResult.processed,
      suppressionsActive: suppressionResult.suppressed,
    },
    "Processed SES/SNS email delivery feedback",
  );

  return {
    handled: true as const,
    notificationType,
    recipients: normalizedRecipients,
    emailLogsMarked: marked.count,
    suppressionsProcessed: suppressionResult.processed,
    suppressionsActive: suppressionResult.suppressed,
  };
}
