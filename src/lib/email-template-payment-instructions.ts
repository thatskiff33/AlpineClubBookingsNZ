/**
 * Whether an email template prints the club's bank-transfer payment instructions (ALP-724).
 *
 * A template does when it allows a token rendered from a booking message flagged
 * `carriesPaymentInstructions`: the set is derived from the token-to-message declaration
 * beside the renderer and the messages' own flags, never a hand list of templates. An AI app
 * connection may not change such a template, since a body that dropped the token could print a
 * fixed account instead (`club-setup`, website-only); its reset to the default stays open.
 */
import { BOOKING_MESSAGE_DEFINITION_BY_KEY } from "@/lib/booking-message-definitions";
import { EMAIL_TOKENS_RENDERING_BOOKING_MESSAGES } from "@/lib/credit-release-bank-transfer";
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

/** The email tokens that render a payment-instruction booking message. */
export const PAYMENT_INSTRUCTION_EMAIL_TOKENS: ReadonlySet<string> = new Set(
  Object.entries(EMAIL_TOKENS_RENDERING_BOOKING_MESSAGES)
    .filter(([, messageKey]) => BOOKING_MESSAGE_DEFINITION_BY_KEY.get(messageKey)?.carriesPaymentInstructions)
    .map(([token]) => token),
);

export function emailTemplateCarriesPaymentInstructions(templateName: string): boolean {
  return (
    getEmailTemplateDefinition(templateName)?.allowedTokens.some((token) => PAYMENT_INSTRUCTION_EMAIL_TOKENS.has(token)) ??
    false
  );
}
