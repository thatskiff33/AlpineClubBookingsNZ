/**
 * ONE pass-through `@/lib/stripe` double for the #1881 real-PostgreSQL harness.
 *
 * A `vi.mock` in a file the harness imports is registered for the whole
 * harness process, and the LAST file to register a factory for a module wins.
 * So every realdb file that doubles a Stripe call registers this same factory
 * (`stripeRaceDouble`) and installs its hooks on this one shared object: the
 * double behaves the same whichever file registered last, and every call no
 * case has hooked runs the REAL function.
 */
import type * as StripeModule from "@/lib/stripe";

type Stripe = typeof StripeModule;

export const stripeRaceHooks: {
  update: null | ((id: string, amountCents: number) => Promise<unknown>);
  get: null | ((id: string) => Promise<unknown>);
  create: null | ((args: Parameters<Stripe["createPaymentIntent"]>[0]) => Promise<unknown>);
  findByMetadata: null | ((args: Parameters<Stripe["findRecentPaymentIntentByMetadata"]>[0]) => Promise<unknown>);
  /** #4036: the recent intents an ordinary ask's refused replay looks through. */
  list: null | ((args: Parameters<Stripe["listRecentPaymentIntentsMatching"]>[0]) => Promise<unknown>);
  cancel: null | ((id: string) => Promise<unknown>);
  /** #4096: a card refund's answer, e.g. one Stripe refused (`failed`). */
  refund: null | ((args: Parameters<Stripe["processRefund"]>[0]) => Promise<unknown>);
  /** #4149: the refunds Stripe lists for one intent, read to prove which door sent them. */
  listRefunds: null | ((paymentIntentId: string) => Promise<unknown>);
  /** #4170: the refunds Stripe lists for one charge, which `charge.refunded` records. */
  listChargeRefunds: null | ((chargeId: string) => Promise<unknown>);
  /** #4300: the Stripe customer a card door mints its intent for. */
  customer: null | ((args: Parameters<Stripe["findOrCreateCustomer"]>[0]) => Promise<unknown>);
} = { update: null, get: null, create: null, findByMetadata: null, list: null, cancel: null, refund: null, listRefunds: null, listChargeRefunds: null, customer: null };

export function resetStripeRaceHooks(): void {
  stripeRaceHooks.update = null;
  stripeRaceHooks.get = null;
  stripeRaceHooks.create = null;
  stripeRaceHooks.findByMetadata = null;
  stripeRaceHooks.list = null;
  stripeRaceHooks.cancel = null;
  stripeRaceHooks.refund = null;
  stripeRaceHooks.listRefunds = null;
  stripeRaceHooks.listChargeRefunds = null;
  stripeRaceHooks.customer = null;
}

export function stripeRaceDouble(actual: Stripe): Stripe {
  return {
    ...actual,
    updatePaymentIntentAmount: ((id: string, amountCents: number) =>
      stripeRaceHooks.update
        ? stripeRaceHooks.update(id, amountCents)
        : actual.updatePaymentIntentAmount(id, amountCents)) as Stripe["updatePaymentIntentAmount"],
    getPaymentIntent: ((...args: Parameters<Stripe["getPaymentIntent"]>) =>
      stripeRaceHooks.get ? stripeRaceHooks.get(args[0]) : actual.getPaymentIntent(...args)) as Stripe["getPaymentIntent"],
    createPaymentIntent: ((args: Parameters<Stripe["createPaymentIntent"]>[0]) =>
      stripeRaceHooks.create ? stripeRaceHooks.create(args) : actual.createPaymentIntent(args)) as Stripe["createPaymentIntent"],
    findRecentPaymentIntentByMetadata: ((args: Parameters<Stripe["findRecentPaymentIntentByMetadata"]>[0]) =>
      stripeRaceHooks.findByMetadata
        ? stripeRaceHooks.findByMetadata(args)
        : actual.findRecentPaymentIntentByMetadata(args)) as Stripe["findRecentPaymentIntentByMetadata"],
    listRecentPaymentIntentsMatching: ((args: Parameters<Stripe["listRecentPaymentIntentsMatching"]>[0]) =>
      stripeRaceHooks.list
        ? stripeRaceHooks.list(args)
        : actual.listRecentPaymentIntentsMatching(args)) as Stripe["listRecentPaymentIntentsMatching"],
    cancelPaymentIntentIfCancellableWithResult: ((...args: Parameters<Stripe["cancelPaymentIntentIfCancellableWithResult"]>) =>
      stripeRaceHooks.cancel
        ? stripeRaceHooks.cancel(args[0])
        : actual.cancelPaymentIntentIfCancellableWithResult(...args)) as Stripe["cancelPaymentIntentIfCancellableWithResult"],
    processRefund: ((args: Parameters<Stripe["processRefund"]>[0]) =>
      stripeRaceHooks.refund ? stripeRaceHooks.refund(args) : actual.processRefund(args)) as Stripe["processRefund"],
    listRefundsForPaymentIntent: ((...args: Parameters<Stripe["listRefundsForPaymentIntent"]>) =>
      stripeRaceHooks.listRefunds
        ? stripeRaceHooks.listRefunds(args[0])
        : actual.listRefundsForPaymentIntent(...args)) as Stripe["listRefundsForPaymentIntent"],
    listRefundsForCharge: ((...args: Parameters<Stripe["listRefundsForCharge"]>) =>
      stripeRaceHooks.listChargeRefunds
        ? stripeRaceHooks.listChargeRefunds(args[0])
        : actual.listRefundsForCharge(...args)) as Stripe["listRefundsForCharge"],
    findOrCreateCustomer: ((args: Parameters<Stripe["findOrCreateCustomer"]>[0]) =>
      stripeRaceHooks.customer ? stripeRaceHooks.customer(args) : actual.findOrCreateCustomer(args)) as Stripe["findOrCreateCustomer"],
  };
}
