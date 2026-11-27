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
import type { EmailDeliveryMode } from "@/lib/email-delivery";

/** A mail service whose reply to a send names the message. Today only SES. */
export type MailService = "aws-ses";

/** How each service is named wherever officers or operators read it, the delivery mode's label included (#5469: one label). */
export const MAIL_SERVICE_LABEL: Readonly<Record<MailService, string>> = {
  "aws-ses": "AWS SES",
};

/** Every delivery mode, so a new one fails to compile here until it is classified. */
const MAIL_SERVICE_FOR_DELIVERY_MODE: Readonly<Record<EmailDeliveryMode | "invalid", MailService | null>> = {
  "aws-ses": "aws-ses",
  "smtp-relay": null,
  "local-capture": null,
  invalid: null,
};

/**
 * Amazon SES over SMTP answers an accepted message with `250 Ok <MessageID>`
 * (AWS, "Amazon SES SMTP issues", SMTP response codes); its notifications name
 * the message in `mail.messageId` (AWS, "Amazon SNS notification contents for
 * Amazon SES", whose example is `000001378603177f-7a5433e7-8edb-42ae-af10-f0181f34d6ee-000000`).
 * Only that shape is stored: hex groups joined by hyphens, at most
 * `MAX_PROVIDER_MESSAGE_ID_LENGTH` characters, lower-cased as the
 * notifications write it. Anything else, from a broken or hostile endpoint,
 * stores nothing, so a reply can never make the row's write fail.
 */
const SES_ACCEPTED_REPLY = /^250 Ok ([0-9a-f]+(?:-[0-9a-f]+)+)$/i;

/** Longest id stored; SES's are about 60 characters. */
export const MAX_PROVIDER_MESSAGE_ID_LENGTH = 128;

const READ_ID_FROM_REPLY: Readonly<Record<MailService, (reply: string) => string | null>> = {
  "aws-ses": (reply) => SES_ACCEPTED_REPLY.exec(reply)?.[1]?.toLowerCase() ?? null,
};

/** The recognised mail service behind a delivery mode, or null. */
export function mailServiceForDeliveryMode(mode: EmailDeliveryMode | "invalid"): MailService | null {
  return MAIL_SERVICE_FOR_DELIVERY_MODE[mode];
}

/**
 * The id the mail server gave an accepted message, from the mail library's
 * send result (`response` is the server's final reply), or null for a server
 * the app does not recognise, a reply that names no id, or one too long to be
 * an id. Never throws.
 */
function providerMessageIdFromSendResult(
  mailService: MailService | null,
  result: { response?: unknown } | null | undefined,
): string | null {
  if (!mailService || typeof result?.response !== "string") return null;
  const reply = result.response.trim();
  if (reply.length > MAX_PROVIDER_MESSAGE_ID_LENGTH + 16) return null;
  const id = READ_ID_FROM_REPLY[mailService](reply);
  return id && id.length <= MAX_PROVIDER_MESSAGE_ID_LENGTH ? id : null;
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
