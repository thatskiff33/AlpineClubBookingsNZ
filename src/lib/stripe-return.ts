/**
 * #4955 (`INV-PAY-138`): a Stripe confirmation has two exits. The resolved
 * promise reaches the page through PaymentForm; a redirect method (a bank page,
 * a buy-now-pay-later provider) leaves the page and comes back to `return_url`
 * with the result in the query string. This reads that second exit.
 *
 * The parameters are untrusted text. `redirect_status` is only a hint of
 * whether to ask the server: a success is never decided here, only routed into
 * the surface's own server check with an intent id of the shape Stripe issues.
 * The client secret Stripe adds is never read, only removed from the address bar.
 *
 * ALP-569: the member booking page carries three card surfaces (the booking's
 * own payment, an additional payment, a group settlement), each confirming a
 * different intent. Each one's `return_url` names it (`stripeReturnUrl`), and a
 * surface takes only a return addressed to it, so no surface checks another's
 * intent. The emailed pay link is the one surface whose return is unnamed.
 */

/** How the Stripe confirmation resolved: the page asks the server either way. */
export type CardConfirmation = "succeeded" | "processing";

export type StripeReturn =
  | { kind: "none" }
  | { kind: "check"; intentId: string; confirmation: CardConfirmation }
  | { kind: "failed" };

export type StripeReturnSurface = "booking" | "additional-payment" | "group-settlement";

const RETURN_PARAMS = ["payment_intent", "payment_intent_client_secret", "redirect_status"] as const;
const SURFACE_PARAM = "stripe_return";
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
 * `href` as the `return_url` of a confirmation made on `surface`, less any
 * earlier return still in it, so Stripe's parameters are the only ones there.
 */
export function stripeReturnUrl(surface: StripeReturnSurface, href: string): string {
  const url = new URL(href);
  for (const name of RETURN_PARAMS) url.searchParams.delete(name);
  url.searchParams.set(SURFACE_PARAM, surface);
  return url.toString();
}

function addressedTo(url: URL, surface: StripeReturnSurface | undefined): boolean {
  return (url.searchParams.get(SURFACE_PARAM) ?? undefined) === surface;
}

/** Whether the address bar holds a Stripe return for `surface`, without taking it. */
export function hasStripeReturn(surface?: StripeReturnSurface): boolean {
  const url = new URL(window.location.href);
  return addressedTo(url, surface) && RETURN_PARAMS.some((name) => url.searchParams.has(name));
}

/**
 * Reads the return addressed to `surface` (unnamed: the pay link's) from the
 * address bar and removes Stripe's parameters and the surface's name (keeping
 * every other parameter, the hash and the history state), so a reload or a
 * shared link is a plain load. A return addressed to another surface is left
 * for it. Removing them first also makes a second call - React strict mode
 * running the mount effect twice - find nothing.
 */
export function takeStripeReturn(surface?: StripeReturnSurface): StripeReturn {
  const url = new URL(window.location.href);
  if (!addressedTo(url, surface)) return { kind: "none" };
  const named = surface !== undefined;
  if (!named && !RETURN_PARAMS.some((name) => url.searchParams.has(name))) return { kind: "none" };
  const stripeReturn = readStripeReturn(url.search);
  for (const name of RETURN_PARAMS) url.searchParams.delete(name);
  url.searchParams.delete(SURFACE_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return stripeReturn;
}
