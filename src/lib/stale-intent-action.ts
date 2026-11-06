/**
 * The one reading of whether a Stripe intent is unpaid, for the currency re-issue
 * (`additional-intent-currency.ts`, #3567), an ordinary ask's refused replay
 * (`ordinary-ask-request.ts`, #4036) and a recovery replay's carried ask, which
 * it waits on unless this says `reissue` (`carriedAskPaymentWait`, #4015). A
 * module of its own so a pure caller need not import the re-issue's database
 * and Stripe writers.
 *
 * The member's pay door keeps its own list (`PROVIDER_CAPTURED_INTENT_STATUSES`
 * in `additional-payment-chase.ts`): identical on every documented status, it
 * stays payable on an unknown one where this fails safe (`gone`).
 */

/**
 * What may be done with an intent in another currency (#3567 re-review), read
 * off Stripe's status — never assumed from the ledger, which lags the webhook:
 *
 * - `reissue`: the member has not paid (`requires_payment_method`,
 *   `requires_confirmation`, `requires_action`). Superseding it is safe.
 * - `in_flight`: `succeeded` or `processing` — the member HAS paid, or is paying,
 *   and the webhook has not landed yet (a 3DS return, a refresh). Re-issuing
 *   would queue the paid intent for cancellation, whose processor finds it
 *   captured and REFUNDS it, and then ask the member to pay again.
 * - `gone`: `canceled` (or `requires_capture`, which this product never asks
 *   for) — nothing to hand back and nothing to re-issue.
 */
export type StaleIntentAction = "reissue" | "in_flight" | "gone";

/**
 * The states of an intent nobody has paid or retired. #4036: also the only ones
 * an ordinary ask's refused replay may adopt (`isIntentForOrdinaryAskPlan`).
 */
const REISSUABLE_STATUSES: ReadonlySet<string> = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

export function staleIntentAction(intent: { status: string }): StaleIntentAction {
  if (REISSUABLE_STATUSES.has(intent.status)) return "reissue";
  if (intent.status === "succeeded" || intent.status === "processing") return "in_flight";
  return "gone";
}
