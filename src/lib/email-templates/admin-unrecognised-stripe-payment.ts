/**
 * #4532 (`INV-INT-032`): the admin alert for a succeeded Stripe payment the app
 * did not create — a Stripe Payment Link, a Checkout page or a dashboard
 * charge. The app has no booking for it and sends nothing to Xero, so this mail
 * is what tells the treasurer to code it by hand.
 *
 * Part of the finance/money-event family (`src/lib/email/admin-alerts-unrecognised-stripe-payment.ts`).
 */
import { escapeHtml } from "./escape";
import { alertBox, button, heading, infoTable, layout, paragraph } from "./layout";
import {
  UNMATCHED_APP_STRIPE_PAYMENT_NOTE,
  UNRECOGNISED_STRIPE_PAYMENT_NOTE,
} from "@/lib/unrecognised-stripe-payment-note";

/** What the alert names, already rendered: the amount in the payment's own currency, the time in the club's. */
export type UnrecognisedStripePaymentAlertFields = {
  amount: string;
  receivedAt: string;
  description: string;
  paymentIntentId: string;
  chargeId: string;
  checkoutSessionId: string;
  paymentLinkId: string;
  stripeDashboardUrl: string;
};

export function adminUnrecognisedStripePaymentTemplate(data: UnrecognisedStripePaymentAlertFields): string {
  return layout(`
    ${heading("Stripe Payment the App Did Not Create")}
    ${alertBox(
      "A payment was taken on the club's Stripe account outside the app - through a Stripe Payment Link, a Checkout page or the Stripe dashboard. The app has no booking for it and has sent nothing to Xero.",
      "warning",
    )}
    ${paragraph(UNRECOGNISED_STRIPE_PAYMENT_NOTE)}
    ${infoTable([
      { label: "Amount", value: escapeHtml(data.amount) },
      { label: "Received", value: escapeHtml(data.receivedAt) },
      { label: "Description", value: escapeHtml(data.description) },
      { label: "Stripe payment", value: escapeHtml(data.paymentIntentId) },
      { label: "Charge", value: escapeHtml(data.chargeId) },
      { label: "Checkout session", value: escapeHtml(data.checkoutSessionId) },
      { label: "Payment Link", value: escapeHtml(data.paymentLinkId) },
    ])}
    ${button("Open in Stripe", data.stripeDashboardUrl)}
  `);
}

/**
 * #4624 (`INV-INT-033`): what the alert for an app-started booking payment with
 * no matching payment record names, already rendered.
 */
export type UnmatchedAppStripePaymentAlertFields = {
  amount: string;
  receivedAt: string;
  bookingId: string;
  /** What the app found for the payment: no record, or a record of another kind. */
  ledgerMatch: string;
  paymentIntentId: string;
  chargeId: string;
  stripeDashboardUrl: string;
};

/**
 * #4624 (`INV-INT-033`): the admin alert for a succeeded card payment the app
 * started for a booking (its PaymentIntent carries the booking id) that matches
 * no payment the booking is waiting on, so the booking was not settled.
 */
export function adminUnmatchedAppStripePaymentTemplate(data: UnmatchedAppStripePaymentAlertFields): string {
  return layout(`
    ${heading("Booking Card Payment the App Could Not Match")}
    ${alertBox(
      "A card payment the app started for a booking went through in Stripe, but the app has no matching payment on that booking, so it did not mark the booking paid and has sent nothing to Xero.",
      "warning",
    )}
    ${paragraph(UNMATCHED_APP_STRIPE_PAYMENT_NOTE)}
    ${infoTable([
      { label: "Amount", value: escapeHtml(data.amount) },
      { label: "Received", value: escapeHtml(data.receivedAt) },
      { label: "Booking", value: escapeHtml(data.bookingId) },
      { label: "Found in the app", value: escapeHtml(data.ledgerMatch) },
      { label: "Stripe payment", value: escapeHtml(data.paymentIntentId) },
      { label: "Charge", value: escapeHtml(data.chargeId) },
    ])}
    ${button("Open in Stripe", data.stripeDashboardUrl)}
  `);
}
