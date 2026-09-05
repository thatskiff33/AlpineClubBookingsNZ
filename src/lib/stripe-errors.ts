/**
 * Structural readers for Stripe SDK errors.
 *
 * Kept apart from `stripe.ts` on purpose: that module is `server-only` and
 * constructs the SDK client, so every route test replaces it wholesale with a
 * `vi.mock` factory. A predicate that lived there would be mocked away with it
 * and never run under test. This module imports nothing, so a route can use the
 * real predicate while the provider calls beside it are doubles (#3266).
 *
 * The checks are structural (`code` on an object) rather than `instanceof
 * Stripe.errors.StripeError`, for the same reason `config-self-heal.ts` reads
 * Prisma's `P2002` structurally: the error may have crossed a module boundary
 * where the class identity is not the one this bundle holds, and a test double
 * has no class at all.
 */

/**
 * True when Stripe answered that the object does not exist — the
 * `resource_missing` error code (HTTP 404). A caller that asked about a
 * PaymentMethod and gets this has learned that Stripe no longer holds the
 * card; it has NOT learned anything from an outage, a bad key, or a rate limit,
 * all of which arrive as other codes and must be treated as "unknown", never
 * as "gone".
 */
export function isStripeResourceMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "resource_missing"
  );
}
