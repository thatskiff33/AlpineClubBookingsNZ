import type Stripe from "stripe";
import { createTestOnlyOverride } from "./test-only-override";

// Test-only provider seam (#4908): a test can hand the app an in-memory Stripe
// client (src/test/providers/stripe-transport.ts). The guard is the shared
// test-only override rule. Its own module, as the Xero seam is
// (xero-test-client-override.ts), so `getStripe` reads it in one call.
const override = createTestOnlyOverride<Stripe>("Stripe client");

export const setStripeClientForTests = override.set;
export const resetStripeClientForTests = override.reset;
/** The installed test client, or null. Throws if one is somehow set outside a test. */
export const stripeTestClientOverride = override.read;
