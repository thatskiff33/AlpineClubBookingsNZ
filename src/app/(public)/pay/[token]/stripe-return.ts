/**
 * #4955 (`INV-PAY-138`): a Stripe confirmation has two exits. The resolved
 * promise reaches the page through PaymentForm; a redirect method (a bank page,
 * a buy-now-pay-later provider) leaves the page and comes back to `return_url`
 * with the result in the query string. This reads that second exit.
 *
 * The parameters are untrusted text. `redirect_status` is only a hint of
 * whether to ask the server: a success is never decided here, only routed into
 * `checkCardSuccess` with an intent id of the shape Stripe issues. The client
 * secret Stripe adds is never read, only removed from the address bar.
 */

import type { CardConfirmation } from "./card-success-check";

export type StripeReturn =
  | { kind: "none" }
  | { kind: "check"; intentId: string; confirmation: CardConfirmation }
  | { kind: "failed" };

const RETURN_PARAMS = ["payment_intent", "payment_intent_client_secret", "redirect_status"] as const;
const INTENT_ID = /^pi_[A-Za-z0-9]+$/;
// `requires_payment_method` is what a payer cancelling at the provider leaves.
const FAILED_STATUSES = new Set(["failed", "canceled", "requires_payment_method"]);

export function readStripeReturn(search: string): StripeReturn {
  const params = new URLSearchParams(search);
  const status = params.get("redirect_status");
  if (status && FAILED_STATUSES.has(status)) return { kind: "failed" };
  if (status !== "succeeded" && status !== "processing") return { kind: "none" };
  const intentId = params.get("payment_intent") ?? "";
  return INTENT_ID.test(intentId) ? { kind: "check", intentId, confirmation: status } : { kind: "none" };
}

/**
 * Reads the return from the address bar and removes Stripe's parameters
 * (keeping every other parameter, the hash and the history state), so a reload
 * or a shared link is a plain load. Removing them first also makes a second
 * call - React strict mode running the mount effect twice - find nothing.
 */
export function takeStripeReturn(): StripeReturn {
  const url = new URL(window.location.href);
  if (!RETURN_PARAMS.some((name) => url.searchParams.has(name))) return { kind: "none" };
  const stripeReturn = readStripeReturn(url.search);
  for (const name of RETURN_PARAMS) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return stripeReturn;
}
