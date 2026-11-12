/**
 * #4532 (`INV-INT-032`): the admin alerts for succeeded Stripe payments the app
 * did not create - a Stripe Payment Link, a Checkout page or a dashboard
 * charge. The app has no booking for one and sends nothing to Xero, so the
 * single-payment alert is what tells the treasurer to code it by hand; the
 * "paused" alert replaces the single ones while a burst exceeds the hourly cap.
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-unrecognised-stripe-payment.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout, paragraph } from "./layout";
import {
  UNRECOGNISED_STRIPE_PAYMENT_NOTE,
  UNRECOGNISED_STRIPE_PAYMENTS_PAUSED_NOTE,
} from "@/lib/unrecognised-stripe-payment-note";

/** What the single-payment alert names, already rendered: the amount in the payment's own currency, the time in the club's. */
export type UnrecognisedStripePaymentAlertFields = {
  amount: string;
  paidAt: string;
  description: string;
  paymentIntentId: string;
  chargeId: string;
  checkoutSessionId: string;
  paymentLinkId: string;
  /** Empty unless another platform created the payment (`unrecognisedPaymentApplicationNote`). */
  applicationNote: string;
  stripeDashboardUrl: string;
};

export function adminUnrecognisedStripePaymentTemplate(data: UnrecognisedStripePaymentAlertFields): string {
  return layout(`
    ${heading("Stripe Payment the App Did Not Create")}
    ${alertBox(
      "A payment was taken on the club's Stripe account outside the app - through a Stripe Payment Link, a Checkout page or the Stripe dashboard. The app has no booking for it and has sent nothing to Xero.",
      "warning",
    )}
    ${data.applicationNote ? paragraph(escapeHtml(data.applicationNote)) : ""}
    ${paragraph(UNRECOGNISED_STRIPE_PAYMENT_NOTE)}
    ${infoTable([
      { label: "Amount", value: escapeHtml(data.amount) },
      { label: "Paid", value: escapeHtml(data.paidAt) },
      { label: "Description", value: escapeHtml(data.description) },
      { label: "Stripe payment", value: escapeHtml(data.paymentIntentId) },
      { label: "Charge", value: escapeHtml(data.chargeId) },
      { label: "Checkout session", value: escapeHtml(data.checkoutSessionId) },
      { label: "Payment Link", value: escapeHtml(data.paymentLinkId) },
    ])}
    ${button("Open in Stripe", data.stripeDashboardUrl)}
  `);
}

/** What the "paused" alert names, already rendered. */
export type UnrecognisedStripePaymentsPausedAlertFields = {
  /** Payments the app did not create recorded in the last hour. */
  paymentCount: string;
  /** When the hour ends, in the club's time. */
  pausedUntil: string;
  /** The account's payments list. */
  stripeDashboardUrl: string;
};

export function adminUnrecognisedStripePaymentsPausedTemplate(data: UnrecognisedStripePaymentsPausedAlertFields): string {
  return layout(`
    ${heading("More Stripe Payments the App Did Not Create")}
    ${alertBox(
      "Payments the app did not create are arriving faster than one email each can usefully report, so single-payment emails are paused for an hour.",
      "warning",
    )}
    ${paragraph(UNRECOGNISED_STRIPE_PAYMENTS_PAUSED_NOTE)}
    ${infoTable([
      { label: "Recorded in the last hour", value: escapeHtml(data.paymentCount) },
      { label: "Single-payment emails resume after", value: escapeHtml(data.pausedUntil) },
    ])}
    ${button("Open payments in Stripe", data.stripeDashboardUrl)}
  `);
}
