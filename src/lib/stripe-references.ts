/**
 * The id behind a Stripe reference.
 *
 * Stripe's SDK types every reference to another object — a PaymentIntent's
 * `payment_method`, a SetupIntent's `customer`, a Refund's `charge` — as
 * EITHER the bare id string OR the expanded object, depending on whether the
 * request asked for `expand`. Every reader therefore needs the same three-way
 * fold (string, object with `id`, nothing), and before #3266 that fold was
 * written out by hand in more than a dozen places. This module is its one home
 * (`INV-SSOT-001`); `getStripePaymentMethodId` in `payment-recovery.ts` is a
 * named derivation of it, kept so its callers did not all have to move at once.
 *
 * Deliberately imports nothing, so it can be used under test beside a
 * wholesale-mocked `@/lib/stripe` and never needs mocking itself.
 */

export type StripeReference =
  | string
  | { id?: string | null }
  | null
  | undefined;

export function stripeReferenceId(reference: StripeReference): string | null {
  if (typeof reference === "string") return reference;
  return reference?.id ?? null;
}
