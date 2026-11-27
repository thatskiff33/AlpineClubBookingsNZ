import { applyDeliveryFeedback, type DeliveryFeedbackEvent, type DeliveryFeedbackKind } from "./delivery-feedback";

/**
 * #5469: THE SES ADAPTER. Turns an SES bounce or complaint notification, as
 * the SNS webhook delivers it, into the service-neutral `DeliveryFeedbackEvent`
 * that `applyDeliveryFeedback` acts on. Nothing SES-specific reaches the rule.
 *
 * Which email a notification is about: `mail.messageId` is the id SES gave the
 * message and returned in its reply to the send, which the app now stores
 * (`provider-message-id.ts`). The Message-ID header the app sent is replaced by
 * SES on the way out and appears only in `mail.headers` and
 * `mail.commonHeaders`, which SES includes only when the identity's
 * notifications are set to include the original headers; the rule uses them
 * for rows that stored no id (AWS, "Amazon SNS notification contents for
 * Amazon SES", mail object).
 */
type SesSnsNotification = {
  Type?: string;
  Message?: string;
  notificationType?: string;
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: Array<{ emailAddress?: string }>;
    feedbackId?: string;
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: Array<{ emailAddress?: string }>;
    feedbackId?: string;
  };
  mail?: {
    destination?: string[];
    messageId?: string;
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

/** SES's `Permanent` is a permanent bounce; `Transient`, `Undetermined` or none is a temporary one, as the suppression rule has always read them. */
function sesBounceKind(bounceType: string | undefined): DeliveryFeedbackKind {
  return bounceType?.toLowerCase() === "permanent" ? "permanent-bounce" : "temporary-bounce";
}

/** The Message-ID headers the app sent, from whichever original-header field SES included. */
function sesSentMessageIds(mail: SesSnsNotification["mail"]): string[] {
  return [
    mail?.commonHeaders?.messageId,
    ...(mail?.headers ?? [])
      .filter((header) => header.name?.trim().toLowerCase() === "message-id")
      .map((header) => header.value),
  ].filter((value): value is string => typeof value === "string");
}

/** The neutral event for an SES notification, or null for one this adapter does not handle. */
export function sesNotificationToDeliveryFeedback(payload: unknown): DeliveryFeedbackEvent | null {
  const notification = parseSesSnsNotification(payload);
  if (!notification) return null;
  const notificationType = notification.notificationType?.toLowerCase();
  if (notificationType !== "bounce" && notificationType !== "complaint") return null;

  const recipients = getSesFeedbackRecipients(notification, notificationType);
  if (recipients.length === 0) return null;

  const complaint = notificationType === "complaint";
  return {
    service: "aws-ses",
    kind: complaint ? "complaint" : sesBounceKind(notification.bounce?.bounceType),
    recipients,
    providerMessageId: notification.mail?.messageId?.trim() || null,
    sentMessageIds: sesSentMessageIds(notification.mail),
    reportId: (complaint ? notification.complaint?.feedbackId : notification.bounce?.feedbackId)?.trim() || null,
    providerDetail: {
      bounceType: notification.bounce?.bounceType ?? null,
      bounceSubType: notification.bounce?.bounceSubType ?? null,
      complaintFeedbackType: notification.complaint?.complaintFeedbackType ?? null,
    },
  };
}

export async function ingestSesSnsEmailFeedback(payload: unknown) {
  const event = sesNotificationToDeliveryFeedback(payload);
  if (!event) {
    return { handled: false as const };
  }
  const outcome = await applyDeliveryFeedback(event);
  return {
    handled: true as const,
    notificationType: event.kind === "complaint" ? ("complaint" as const) : ("bounce" as const),
    ...outcome,
  };
}
