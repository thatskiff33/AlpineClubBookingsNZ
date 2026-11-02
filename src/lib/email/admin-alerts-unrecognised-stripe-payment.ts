import {
  adminUnmatchedAppStripePaymentTemplate,
  adminUnrecognisedStripePaymentTemplate,
  type UnmatchedAppStripePaymentAlertFields,
  type UnrecognisedStripePaymentAlertFields,
} from "@/lib/email-templates/admin-unrecognised-stripe-payment";
import {
  UNMATCHED_APP_STRIPE_PAYMENT_NOTE,
  UNRECOGNISED_STRIPE_PAYMENT_NOTE,
} from "@/lib/unrecognised-stripe-payment-note";
import { renderEmailHtml } from "@/lib/email-theme";
import { type UnmuteableAdminAlertOutcome } from "./admin-alert-send-result";
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
): Promise<UnmuteableAdminAlertOutcome> {
  return sendUnmuteableAdminAlert({
    subject: `Stripe payment the app did not create - code it in Xero: ${fields.amount}`,
    html: await renderEmailHtml(() => adminUnrecognisedStripePaymentTemplate(fields)),
    templateName: "admin-unrecognised-stripe-payment",
    templateData: { ...fields, unrecognisedPaymentNote: UNRECOGNISED_STRIPE_PAYMENT_NOTE },
    // The people who reconcile the club's money own it, as every finance alert.
    requirement: { area: "finance", level: "edit" },
  });
}

/**
 * #4624 (`INV-INT-033`): a succeeded card payment the app started for a booking
 * that matches no payment the booking is waiting on. The same unmuteable,
 * delivery-locked path and Finance-editor audience as the alert above, for the
 * same reason - a member was charged and nothing the app shows says so - and
 * the same once-ever claim per PaymentIntent (`unrecognised-stripe-payment.ts`).
 */
export async function sendAdminUnmatchedAppStripePaymentAlert(
  fields: UnmatchedAppStripePaymentAlertFields,
): Promise<UnmuteableAdminAlertOutcome> {
  return sendUnmuteableAdminAlert({
    subject: `Booking card payment the app could not match - check it: ${fields.amount}`,
    html: await renderEmailHtml(() => adminUnmatchedAppStripePaymentTemplate(fields)),
    templateName: "admin-unmatched-app-stripe-payment",
    templateData: { ...fields, unmatchedAppPaymentNote: UNMATCHED_APP_STRIPE_PAYMENT_NOTE },
    requirement: { area: "finance", level: "edit" },
  });
}
