import type Stripe from "stripe";

// Test-only provider seam (#4908): a test can hand the app an in-memory Stripe
// client (src/test/providers/stripe-transport.ts). No environment variable or
// request can set it, and it refuses to serve outside NODE_ENV=test, so a
// changed environment cannot retain it. Its own module, as the Xero seam is
// (xero-test-client-override.ts), so `getStripe` reads it in one call.
let testStripeClient: Stripe | null = null;

export function setStripeClientForTests(client: Stripe | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Stripe client override is test-only");
  testStripeClient = client;
}

export function resetStripeClientForTests(): void {
  testStripeClient = null;
}

/** The installed test client, or null. Throws if one is somehow set outside a test. */
export function stripeTestClientOverride(): Stripe | null {
  if (testStripeClient && process.env.NODE_ENV !== "test") throw new Error("Stripe client override is test-only");
  return testStripeClient;
}
