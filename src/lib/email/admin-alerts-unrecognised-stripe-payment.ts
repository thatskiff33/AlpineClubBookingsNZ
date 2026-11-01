import {
  adminUnrecognisedStripePaymentTemplate,
  type UnrecognisedStripePaymentAlertFields,
} from "@/lib/email-templates/admin-unrecognised-stripe-payment";
import { UNRECOGNISED_STRIPE_PAYMENT_NOTE } from "@/lib/unrecognised-stripe-payment-note";
import { renderEmailHtml } from "@/lib/email-theme";
import { sendUnmuteableAdminAlert } from "./admin-alerts-shared";

/**
 * #4532 (`INV-INT-032`): a succeeded Stripe payment the app did not create.
 * Through the UNMUTEABLE sender and delivery-locked, for #4170's reason: money
 * moved with no record the app wrote in Xero and no screen that lists it, so
 * this mail is the whole notice. Once ever per PaymentIntent - the caller
 * claims it through `sendAdminAlertOnceEver` (`unrecognised-stripe-payment.ts`).
 * The fields arrive rendered; this module only addresses and sends them.
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
