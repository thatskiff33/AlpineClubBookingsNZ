import {
  adminStripeDisputeTemplate,
  type StripeDisputeAlertFields,
} from "@/lib/email-templates/admin-stripe-dispute";
import { STRIPE_DISPUTE_HOLD_NOTE, stripeDisputeSubjectLabel } from "@/lib/stripe-dispute-note";
import { renderEmailHtml } from "@/lib/email-theme";
import { type UnmuteableAdminAlertOutcome } from "./admin-alert-send-result";
import { sendUnmuteableAdminAlert } from "./admin-alerts-shared";

/**
 * #4911 (`INV-PAY-151`): a cardholder's dispute of a Stripe payment, once when
 * it opens and once when it closes. Through the UNMUTEABLE sender and
 * delivery-locked, for #4170's reason: Stripe moved the money outside the app,
 * nothing reaches Xero, and a missed response deadline loses the dispute, so
 * this mail is the whole notice. Once ever per dispute and stage - the caller
 * claims it through `sendAdminAlertOnceEverWithTakeover` (`stripe-dispute.ts`).
 * The fields arrive rendered; this module only addresses and sends them.
 */
export async function sendAdminStripeDisputeAlert(
  fields: StripeDisputeAlertFields,
): Promise<UnmuteableAdminAlertOutcome> {
  const disputeSubjectLabel = stripeDisputeSubjectLabel(fields.stage, fields.outcome);
  return sendUnmuteableAdminAlert({
    subject: `${disputeSubjectLabel}: ${fields.amount}`,
    html: await renderEmailHtml(() => adminStripeDisputeTemplate(fields)),
    templateName: "admin-stripe-dispute",
    // The composed phrases an admin's saved subject and body render (#4911).
    templateData: { ...fields, disputeHoldNote: STRIPE_DISPUTE_HOLD_NOTE, disputeSubjectLabel },
    // The people who reconcile the club's money own it, as every finance alert.
    requirement: { area: "finance", level: "edit" },
  });
}
