/**
 * The offer email's template name: its `EmailLog` rows, the durable row id an
 * owed offer notice reads (`waitlist-offer-notices.ts`, #5433), and the key the
 * email retry job's "still wanted?" check is registered under
 * (`email/retry-still-wanted.ts`). A leaf, so none of those loads a template.
 */
export const WAITLIST_OFFER_TEMPLATE_NAME = "waitlist-offer";
