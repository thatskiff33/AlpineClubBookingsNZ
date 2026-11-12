/**
 * #4532 (`INV-INT-032`): the passages of the alerts about Stripe payments the
 * app did not create, each shared by its hand-built HTML
 * (`email-templates/admin-unrecognised-stripe-payment.ts`) and the token an
 * admin's saved body renders, so the two cannot say different things about
 * money. A leaf module: the registry imports it without loading the email layout.
 */

/** What the treasurer does about one payment: `{{unrecognisedPaymentNote}}`. */
export const UNRECOGNISED_STRIPE_PAYMENT_NOTE =
  "The money is in the club's Stripe balance. Unless another system already recorded it (for example a Xero invoice's Pay now), nothing in Xero explains it, so the Stripe clearing account will not reconcile until it is coded. " +
  "Find the payment in Stripe by the reference below, decide what it is (a donation, or income and its tax treatment) and record it in Xero by hand against the Stripe clearing account. " +
  "The app has recorded it and will not alert about this payment again.";

/**
 * `{{applicationNote}}`: said only when another platform connected to the
 * club's Stripe account created the payment (its PaymentIntent names a Connect
 * application), and empty otherwise.
 */
export function unrecognisedPaymentApplicationNote(applicationId: string | null): string {
  if (!applicationId) return "";
  return `Another platform connected to the club's Stripe account created this payment (Stripe application ${applicationId}). Check whether it already recorded the payment in Xero before you code it.`;
}

/** How many individual alerts a rolling hour carries before they pause. */
export const UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR = 5;

/** `{{unrecognisedPaymentsPausedNote}}`: why individual alerts stopped, and what to check. */
export const UNRECOGNISED_STRIPE_PAYMENTS_PAUSED_NOTE =
  `More than ${UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR} payments the app did not create arrived on the club's Stripe account within an hour, so the app has stopped sending one email per payment for now. It still records every one. ` +
  "A burst like this can be card testing - many small charges made with stolen card numbers - so check the payments list in Stripe now. " +
  "Each payment still needs coding in Xero, as the single-payment alert describes.";
