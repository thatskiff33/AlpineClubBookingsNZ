/**
 * Why an AI app connection may not change an email template's wording, or `null` when it may
 * (ALP-724). Two kinds of template stay website-only; resetting either to its default stays open:
 *
 *  - one carrying a one-time sign-in, reset or invitation link, whose body decides where that
 *    link points (`sign-in-access`);
 *  - one printing the club's bank-transfer instructions, which a body without the token could
 *    replace with a fixed account (`club-setup`).
 */
import { EMAIL_TEMPLATE_PAYMENT_INSTRUCTIONS_WEBSITE_ONLY } from "@/lib/booking-message-definitions";
import { emailTemplateCarriesAccessToken } from "@/lib/email-template-access-token";
import { emailTemplateCarriesPaymentInstructions } from "@/lib/email-template-payment-instructions";

const ACCESS_TOKEN_WEBSITE_ONLY =
  "This email carries a one-time sign-in, reset or invitation link, so its wording is changed on the club website.";

export function emailTemplateConnectionEditRefusal(templateName: string): string | null {
  if (emailTemplateCarriesAccessToken(templateName)) return ACCESS_TOKEN_WEBSITE_ONLY;
  if (emailTemplateCarriesPaymentInstructions(templateName)) return EMAIL_TEMPLATE_PAYMENT_INSTRUCTIONS_WEBSITE_ONLY;
  return null;
}
