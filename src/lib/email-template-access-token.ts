/**
 * Whether an email template carries a one-time `{{token}}` link (sign-in,
 * password reset, verification, invitation), read from the registry's
 * required-token table. An AI app connection may not change such a template:
 * its body decides where that link goes, which is `sign-in-access` and
 * website-only (ALP-724).
 */
import { getEmailTemplateDefinition } from "@/lib/email-message-registry";

export function emailTemplateCarriesAccessToken(templateName: string): boolean {
  return getEmailTemplateDefinition(templateName)?.requiredTokens.includes("token") ?? false;
}
