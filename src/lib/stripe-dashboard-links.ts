/**
 * #4532 (`INV-SSOT`): THE Stripe dashboard links, in one plain module so a
 * server email and a client page build them the same way. The dashboard keeps
 * live and test data apart under a `/test` path segment, and a Stripe id does
 * not say which mode it belongs to (a test PaymentIntent's id is `pi_...` like a
 * live one), so every caller passes the mode it actually knows - an event's
 * `livemode`, for instance - and nothing guesses it from the id.
 */
export type StripeDashboardMode = "live" | "test";

function dashboardRoot(mode: StripeDashboardMode): string {
  return mode === "live" ? "https://dashboard.stripe.com/" : "https://dashboard.stripe.com/test/";
}

/** One payment's page. */
export function stripeDashboardPaymentUrl(paymentIntentId: string, mode: StripeDashboardMode): string {
  return `${dashboardRoot(mode)}payments/${encodeURIComponent(paymentIntentId)}`;
}

/** The account's payments list. */
export function stripeDashboardPaymentsUrl(mode: StripeDashboardMode): string {
  return `${dashboardRoot(mode)}payments`;
}
