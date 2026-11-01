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

/**
 * #4624 (`INV-INT-033`): what the treasurer does about a succeeded card payment
 * the app DID start for a booking but cannot match to a payment it is waiting
 * on - the passage shared by the hand-built HTML
 * (`email-templates/admin-unrecognised-stripe-payment.ts`) and the
 * `{{unmatchedAppPaymentNote}}` token, for the same reason as the note above.
 */
export const UNMATCHED_APP_STRIPE_PAYMENT_NOTE =
  "The card was charged, but the app did not mark the booking paid and sent nothing to Xero, so the booking, Xero and the Stripe clearing account do not show this money. " +
  "Open the booking and the payment in Stripe and work out whether the booking still owes it. " +
  "The money belongs to that booking: do not record it as a cash payment or code it in Xero as a donation or other income. " +
  "Ask whoever supports your booking system to match it to the booking, or refund it in Stripe if the booking does not owe it. " +
  "The app has recorded it and will not alert about this payment again.";
