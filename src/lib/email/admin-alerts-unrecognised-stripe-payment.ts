import {
  adminUnrecognisedStripePaymentsPausedTemplate,
  adminUnrecognisedStripePaymentTemplate,
  type UnrecognisedStripePaymentAlertFields,
  type UnrecognisedStripePaymentsPausedAlertFields,
} from "@/lib/email-templates/admin-unrecognised-stripe-payment";
import {
  UNRECOGNISED_STRIPE_PAYMENT_NOTE,
  UNRECOGNISED_STRIPE_PAYMENTS_PAUSED_NOTE,
} from "@/lib/unrecognised-stripe-payment-note";
import { renderEmailHtml } from "@/lib/email-theme";
import { sendUnmuteableAdminAlert } from "./admin-alerts-shared";

/**
 * #4532 (`INV-INT-032`): a succeeded Stripe payment the app did not create.
 * Through the UNMUTEABLE sender and delivery-locked, for #4170's reason: money
 * moved with no record the app wrote in Xero and no screen that lists it, so
 * this mail is the whole notice. The caller (`unrecognised-stripe-payment.ts`)
 * claims it once ever per PaymentIntent and caps it per hour. The fields arrive
 * rendered; this module only addresses and sends them.
 */
export async function sendAdminUnrecognisedStripePaymentAlert(
  fields: UnrecognisedStripePaymentAlertFields,
): Promise<void> {
  await sendUnmuteableAdminAlert({
    subject: `Stripe payment the app did not create - code it in Xero: ${fields.amount}`,
    html: await renderEmailHtml(() => adminUnrecognisedStripePaymentTemplate(fields)),
    templateName: "admin-unrecognised-stripe-payment",
    templateData: { ...fields, unrecognisedPaymentNote: UNRECOGNISED_STRIPE_PAYMENT_NOTE },
    // The people who reconcile the club's money own it, as every finance alert.
    requirement: { area: "finance", level: "edit" },
  });
}

/**
 * #4532: the one alert per rolling hour that stands in for single-payment
 * alerts once the hourly cap is reached - a burst such as card testing. Same
 * sender, lock and audience.
 */
export async function sendAdminUnrecognisedStripePaymentsPausedAlert(
  fields: UnrecognisedStripePaymentsPausedAlertFields,
): Promise<void> {
  await sendUnmuteableAdminAlert({
    subject: "More Stripe payments the app did not create - check Stripe",
    html: await renderEmailHtml(() => adminUnrecognisedStripePaymentsPausedTemplate(fields)),
    templateName: "admin-unrecognised-stripe-payments-paused",
    templateData: { ...fields, unrecognisedPaymentsPausedNote: UNRECOGNISED_STRIPE_PAYMENTS_PAUSED_NOTE },
    requirement: { area: "finance", level: "edit" },
  });
}
