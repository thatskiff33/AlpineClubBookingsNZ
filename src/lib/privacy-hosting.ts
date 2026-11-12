import { z } from "zod";

export const PRIVACY_HOSTING_TEXT_LIMIT = 120;
/**
 * One disclosure field: what the admin route stores, or a refusal. Checked
 * before trimming, so a newline at either end is refused, not silently dropped.
 */
export const privacyHostingTextSchema = z.string()
  .refine(value => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), "Use one line without control characters")
  .transform(value => value.trim())
  .pipe(z.string().max(PRIVACY_HOSTING_TEXT_LIMIT))
  .transform(value => value || null)
  .nullable();

export const privacyHostingSchema = z.object({
  hostingProvider: privacyHostingTextSchema,
  dataLocation: privacyHostingTextSchema,
}).strict();

export type PrivacyHostingValues = z.infer<typeof privacyHostingSchema>;
export const PRIVACY_HOSTING_DEFAULTS: PrivacyHostingValues = {
  hostingProvider: null, dataLocation: null,
};

/** Raw plain text; the public renderer escapes the whole sentence once. */
export function dataHostingSentence({ hostingProvider, dataLocation }: PrivacyHostingValues): string {
  if (hostingProvider && dataLocation) {
    return `${hostingProvider} hosts this System and its database; your information is held in ${dataLocation}.`;
  }
  if (hostingProvider) {
    return `${hostingProvider} hosts this System and its database. Ask our Privacy Officer in which country your information is held.`;
  }
  if (dataLocation) {
    return `The company that hosts this System and its database holds your information in ${dataLocation}. Ask our Privacy Officer which company this is.`;
  }
  return "A hosting company runs this System and its database. Ask our Privacy Officer which company this is and in which country your information is held.";
}
