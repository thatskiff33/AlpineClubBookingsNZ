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
import { refundRequestStripeMetadata } from "@/lib/refund-slice-evidence";

type Stripe = typeof StripeModule;
type StripeRefund = Awaited<ReturnType<Stripe["processRefund"]>>;

/**
 * #4359 (INV-PAY-145): every refund a case's `refund` hook answered with, by
 * intent, as Stripe itself keeps them. A charge-backed recovery reads Stripe's
 * refunds for the intent before it sends again; a case that doubles the refunds
 * Stripe makes but not that list is answered with these, which is what the real
 * list would return. Only a hooked `refund` writes here.
 */
const refundsMadeByIntent = new Map<string, Map<string, StripeRefund>>();

function recordRefundMade(paymentIntentId: string, refund: unknown): void {
  if (!refund || typeof refund !== "object" || typeof (refund as { id?: unknown }).id !== "string") return;
  const made = refundsMadeByIntent.get(paymentIntentId) ?? new Map<string, StripeRefund>();
  made.set((refund as StripeRefund).id, refund as StripeRefund);
  refundsMadeByIntent.set(paymentIntentId, made);
}

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
  /** #4357: a saved card's off-session charge, which every saved-card door makes. */
  charge: null | ((args: Parameters<Stripe["chargePaymentMethod"]>[0]) => Promise<unknown>);
  /** #4532: the Checkout Session a payment the app did not create went through. */
  checkoutSession: null | ((paymentIntentId: string) => Promise<unknown>);
} = { update: null, get: null, create: null, findByMetadata: null, list: null, cancel: null, refund: null, listRefunds: null, listChargeRefunds: null, customer: null, charge: null, checkoutSession: null };

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
  stripeRaceHooks.charge = null;
  stripeRaceHooks.checkoutSession = null;
  refundsMadeByIntent.clear();
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
    processRefund: (async (args: Parameters<Stripe["processRefund"]>[0]) => {
      if (!stripeRaceHooks.refund) return actual.processRefund(args);
      // #4510 (INV-PAY-147): a case's hook answers for Stripe, so it is handed
      // the metadata Stripe receives - the slice-key evidence stamped in.
      const refund = await stripeRaceHooks.refund({ ...args, metadata: refundRequestStripeMetadata(args) });
      recordRefundMade(args.paymentIntentId, refund);
      return refund;
    }) as Stripe["processRefund"],
    listRefundsForPaymentIntent: (async (...args: Parameters<Stripe["listRefundsForPaymentIntent"]>) => {
      if (stripeRaceHooks.listRefunds) return stripeRaceHooks.listRefunds(args[0]);
      // A case doubling Stripe's refunds is answered with the ones it made.
      if (stripeRaceHooks.refund) return [...(refundsMadeByIntent.get(args[0])?.values() ?? [])];
      return actual.listRefundsForPaymentIntent(...args);
    }) as Stripe["listRefundsForPaymentIntent"],
    listRefundsForCharge: ((...args: Parameters<Stripe["listRefundsForCharge"]>) =>
      stripeRaceHooks.listChargeRefunds
        ? stripeRaceHooks.listChargeRefunds(args[0])
        : actual.listRefundsForCharge(...args)) as Stripe["listRefundsForCharge"],
    findOrCreateCustomer: ((args: Parameters<Stripe["findOrCreateCustomer"]>[0]) =>
      stripeRaceHooks.customer ? stripeRaceHooks.customer(args) : actual.findOrCreateCustomer(args)) as Stripe["findOrCreateCustomer"],
    chargePaymentMethod: ((args: Parameters<Stripe["chargePaymentMethod"]>[0]) =>
      stripeRaceHooks.charge ? stripeRaceHooks.charge(args) : actual.chargePaymentMethod(args)) as Stripe["chargePaymentMethod"],
    findCheckoutSessionForPaymentIntent: ((paymentIntentId: string) =>
      stripeRaceHooks.checkoutSession
        ? stripeRaceHooks.checkoutSession(paymentIntentId)
        : actual.findCheckoutSessionForPaymentIntent(paymentIntentId)) as Stripe["findCheckoutSessionForPaymentIntent"],
  };
}
