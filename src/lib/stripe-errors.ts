/**
 * Structural readers for Stripe errors.
 *
 * Kept apart from `stripe.ts` on purpose: that module is `server-only` and
 * constructs the SDK client, so every route and cron test replaces it wholesale
 * with a `vi.mock` factory. A reader that lived there would be mocked away with
 * it and never run under test. This module imports nothing, so a caller can use
 * the real reader while the provider calls beside it are doubles.
 *
 * The one fact this module exists to get right (#3268): **the SDK does not put
 * the API error type where it looks like it does.** On a thrown
 * `Stripe.errors.StripeError`, `type` is the CLASS NAME (`"StripeCardError"`,
 * `"StripeInvalidRequestError"`) and the API's own type
 * (`"card_error"`, `"invalid_request_error"`) is `rawType` — see
 * `node_modules/stripe/esm/Error.js`, `this.type = type || this.constructor.name;
 * this.rawType = raw.type`. The raw API shape — the `error` object in a webhook
 * payload, or a PaymentIntent's `last_payment_error` — carries the API type in
 * `type` and has no `rawType`. Reading `rawType ?? type` is what makes both
 * shapes classify the same way; reading `type` alone classified every real SDK
 * error as unknown and left the #3268 fix inert against production.
 *
 * Every check is structural (`code` on an object), never `instanceof`, for the
 * same reason `config-self-heal.ts` reads Prisma's `P2002` structurally: the
 * error may have crossed a module boundary where the class identity is not the
 * one this bundle holds, and a test double has no class at all.
 */

/**
 * The API error type — `"card_error"`, `"invalid_request_error"`,
 * `"api_error"`, `"rate_limit_error"`, `"authentication_error"`,
 * `"idempotency_error"` — read from `rawType` when the SDK wrapped the error and
 * from `type` when it is the raw API object. `null` for a non-object, a
 * non-Stripe `Error`, and an SDK error that never reached the API
 * (`StripeConnectionError` carries a class-name `type` and no `rawType`; the
 * class name is deliberately NOT returned as if it were an API type).
 */
export function stripeErrorApiType(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const rawType = optionalString(err, "rawType");
  if (rawType !== null) return rawType;
  const type = optionalString(err, "type");
  // An SDK class name is not an API type. Raw API types are lower_snake_case.
  if (type !== null && /^[a-z_]+$/.test(type)) return type;
  return null;
}

/** The provider fields a caller decides on, read the same way from either shape. */
export interface StripeErrorFields {
  apiType: string | null;
  code: string | null;
  declineCode: string | null;
  param: string | null;
  adviceCode: string | null;
  message: string;
}

/**
 * Read the fields a failure decision is made on. Never throws; a non-object or
 * a non-Stripe error comes back with every provider field `null` and `message`
 * set to the error's own message (or its string form), so a caller can log it
 * and fall through to its default.
 */
export function readStripeErrorFields(err: unknown): StripeErrorFields {
  const fallbackMessage = err instanceof Error ? err.message : String(err);
  if (typeof err !== "object" || err === null) {
    return {
      apiType: null,
      code: null,
      declineCode: null,
      param: null,
      adviceCode: null,
      message: fallbackMessage,
    };
  }
  return {
    apiType: stripeErrorApiType(err),
    code: optionalString(err, "code"),
    declineCode: optionalString(err, "decline_code"),
    param: optionalString(err, "param"),
    adviceCode: optionalString(err, "advice_code"),
    message: optionalString(err, "message") ?? fallbackMessage,
  };
}

function optionalString(source: object, key: string): string | null {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
