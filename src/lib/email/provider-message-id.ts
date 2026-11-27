/**
 * #5469 (owner decision D2, 27 Nov 2026): WHICH ID DID THE MAIL SERVER GIVE
 * THIS EMAIL. A bounce or complaint report names the message by the id the
 * server assigned, not by the Message-ID header the app built (a server may
 * replace that header, as SES does), so both send paths store this id on the
 * email's row (`EmailLog.providerMessageId`) and the feedback rule
 * (`delivery-feedback.ts`) finds the email by it.
 *
 * One entry per mail service the app recognises. Adding a service is one entry
 * here (how its reply names the message) plus, for its reports, an adapter and
 * a route that build a `DeliveryFeedbackEvent`; the rule itself does not change.
 * A server the app does not recognise yields no id, and the send is unaffected.
 *
 * WHICH SERVICE: read from the delivery mode the club already configures
 * (`USE_AWS_SES` selects `aws-ses`, `resolveEmailDeliveryConfig`), never guessed
 * from the reply alone, so another server's reply that happens to look like
 * SES's is not stored as an id. An SMTP relay (`USE_SMTP_RELAY`) and a capture
 * mailbox are not recognised services, even when the relay forwards to SES.
 */

/** A mail service whose reply to a send names the message. Today only SES. */
export type MailService = "aws-ses";

/** How officers see each service named, for example in an email's error note. */
export const MAIL_SERVICE_LABEL: Readonly<Record<MailService, string>> = {
  "aws-ses": "Amazon SES",
};

type DeliveryModeName = "aws-ses" | "smtp-relay" | "local-capture" | "invalid";

const MAIL_SERVICE_FOR_DELIVERY_MODE: Readonly<Record<DeliveryModeName, MailService | null>> = {
  "aws-ses": "aws-ses",
  "smtp-relay": null,
  "local-capture": null,
  invalid: null,
};

/**
 * Amazon SES over SMTP answers an accepted message with `250 Ok <MessageID>`,
 * where the MessageID is the id SES uses for it and later sends as
 * `mail.messageId` in its bounce and complaint notifications (AWS, "Amazon SES
 * SMTP issues", SMTP response codes; "Amazon SNS notification contents for
 * Amazon SES", mail object).
 */
const SES_ACCEPTED_REPLY = /^250 Ok ([^\s<>]+)$/;

const READ_ID_FROM_REPLY: Readonly<Record<MailService, (reply: string) => string | null>> = {
  "aws-ses": (reply) => SES_ACCEPTED_REPLY.exec(reply)?.[1] ?? null,
};

/** The recognised mail service behind a delivery mode, or null. */
export function mailServiceForDeliveryMode(mode: string): MailService | null {
  return MAIL_SERVICE_FOR_DELIVERY_MODE[mode as DeliveryModeName] ?? null;
}

/**
 * The id the mail server gave an accepted message, from the mail library's
 * send result (`response` is the server's final reply), or null for a server
 * the app does not recognise or a reply that names no id. Never throws.
 */
function providerMessageIdFromSendResult(
  mailService: MailService | null,
  result: { response?: unknown } | null | undefined,
): string | null {
  if (!mailService || typeof result?.response !== "string") return null;
  return READ_ID_FROM_REPLY[mailService](result.response.trim());
}

/**
 * The two ids a `SENT` row stores for an accepted message, written by both
 * send paths (`sendEmail` and the retry job) from one definition: the
 * Message-ID header the mail library generated, and the mail server's own id.
 */
export function sentEmailIdsFromResult(
  mailService: MailService | null,
  result: { messageId?: unknown; response?: unknown },
): { messageId: string | null; providerMessageId: string | null } {
  return {
    messageId: typeof result.messageId === "string" && result.messageId ? result.messageId : null,
    providerMessageId: providerMessageIdFromSendResult(mailService, result),
  };
}
