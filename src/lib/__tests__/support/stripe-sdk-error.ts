import Stripe from "stripe";

/**
 * A thrown Stripe error built by the SDK's OWN factory from the raw API error
 * body, exactly as `RequestSender` does on a non-2xx response (#3268).
 *
 * The SDK picks the class from the HTTP status (`generateV1Error`), sets `type`
 * to the CLASS NAME (`StripeCardError`) and keeps the API type (`card_error`,
 * `invalid_request_error`) in `rawType` — which is the shape every reader of a
 * Stripe failure must handle. The first review of #3268 found the saved-card
 * classifier comparing `type` to `"card_error"`, a value the SDK never puts
 * there, so every production failure classified `retry` while a hand-built
 * `{ type: "card_error" }` fixture kept the tests green. Hence: tests that
 * throw a Stripe error throw the real thing, and they build it HERE — one
 * factory, so the status-for-type table and the shape live in one place
 * (`INV-SSOT-001`). Importers: `stripe-errors.test.ts`,
 * `saved-card-charge-failure.test.ts`, `cron-confirm-pending.test.ts`.
 *
 * `statusCode` may be given explicitly (a 404 `resource_missing`, a 503
 * `api_error`); otherwise it is the status the SDK maps that API type to.
 */
const SDK_STATUS_FOR_TYPE: Record<string, number> = {
  card_error: 402,
  invalid_request_error: 400,
  idempotency_error: 400,
  authentication_error: 401,
  rate_limit_error: 429,
  api_error: 500,
};

export interface StripeSdkErrorFields {
  /** The API error type — what the SDK exposes as `rawType`. */
  type: string;
  code?: string;
  decline_code?: string;
  advice_code?: string;
  param?: string;
  message?: string;
  statusCode?: number;
}

export function stripeSdkError(fields: StripeSdkErrorFields): Stripe.errors.StripeError {
  return Stripe.errors.StripeError.generate({
    ...fields,
    message: fields.message ?? `stripe ${fields.type}`,
    statusCode: fields.statusCode ?? SDK_STATUS_FOR_TYPE[fields.type] ?? 500,
  } as never);
}
