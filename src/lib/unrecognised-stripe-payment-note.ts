/**
 * #4532 (`INV-INT-032`): what the treasurer does about a Stripe payment the app
 * did not create - one passage shared by the hand-built HTML
 * (`email-templates/admin-unrecognised-stripe-payment.ts`) and the
 * `{{unrecognisedPaymentNote}}` token an admin's saved body renders, so the two
 * cannot say different things about money. A leaf module: the registry imports
 * it without loading the email layout.
 */
export const UNRECOGNISED_STRIPE_PAYMENT_NOTE =
  "The money is in the club's Stripe balance but nothing in Xero explains it, so the Stripe clearing account will not reconcile until it is coded. " +
  "Find the payment in Stripe by the reference below, decide what it is (a donation, or income and its GST treatment) and record it in Xero by hand against the Stripe clearing account. " +
  "The app has recorded it and will not alert about this payment again.";
