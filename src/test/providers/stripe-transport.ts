import Stripe from "stripe";
import { createReplayWriter } from "./replay-write";
import { strictTestClient } from "./transport-client";
import { StripeFake, StripeFakeError } from "./stripe-fake";

type Snapshot = ReturnType<StripeFake["snapshot"]>;
type FakeIntent = Snapshot["intents"][number];
type FakeRefund = Snapshot["refunds"][number];
type FakeObject = Snapshot["events"][number]["data"]["object"];

/**
 * An in-memory Stripe client over `StripeFake` (#4908). The app reaches it
 * only through `setStripeClientForTests`, so `getStripe()`'s callers run
 * unchanged. Every object leaves through one projection per type, used by
 * retrieve, list and `events()` alike, so a webhook payload and a read of the
 * same object agree. Fake refusals become the SDK's own error classes.
 * Unsupported operations fail closed, and so does any `expand` but an intent's
 * `latest_charge`. Times are Unix seconds from the (frozen) test clock.
 *
 * Not modelled: payment-method collection (an intent is authorised on create,
 * `confirm` or not), customers, Checkout, disputes, and refund fields beyond
 * amount, reason and metadata.
 */
export function stripeTransport(fake: StripeFake) {
  let sequence = 0;
  const key = (value?: string) => value ?? `transport:${++sequence}`;
  const intentInputs = new Map<string, Stripe.PaymentIntentCreateParams>();
  const refundInputs = new Map<string, Stripe.RefundCreateParams>();
  /** When each intent was created and, once captured, its charge. */
  const times = new Map<string, { created: number; captured?: number }>();
  const now = () => Math.floor(Date.now() / 1000);
  const write = createReplayWriter(() => new Stripe.errors.StripeIdempotencyError({ message: "Parameters differ from the original request" }));
  const invoke = <T>(fn: () => T): T => {
    try { return fn(); } catch (error) {
      if (error instanceof StripeFakeError) throw new Stripe.errors.StripeInvalidRequestError({ message: error.message, code: error.code });
      throw error;
    }
  };
  const currency = (intentId: string) => intentInputs.get(intentId)?.currency ?? "nzd";

  const intentWire = (i: FakeIntent) => ({
    ...i, object: "payment_intent", currency: currency(i.id), metadata: intentInputs.get(i.id)?.metadata ?? {},
    created: times.get(i.id)?.created ?? now(),
    latest_charge: i.amount_received ? `charge-${i.id}` : null,
  });
  // The expanded charge carries only what the app reads from it: its own time and amounts.
  const chargeWire = (i: FakeIntent) => ({
    id: `charge-${i.id}`, object: "charge", payment_intent: i.id, currency: currency(i.id),
    amount: i.amount, amount_captured: i.amount_received, created: times.get(i.id)?.captured ?? now(),
  });
  // A dashboard refund carries no metadata; an API refund carries what the app sent.
  const refundWire = (r: FakeRefund) => ({
    ...r, object: "refund", currency: currency(r.payment_intent), metadata: refundInputs.get(r.id)?.metadata ?? {},
    reason: refundInputs.get(r.id)?.reason ?? null,
  });
  const wire = (o: FakeObject) => {
    if ("amount_refunded" in o) return { ...o, object: "charge", currency: currency(o.payment_intent), refunds: { object: "list", data: o.refunds.data.map(refundWire), has_more: false } };
    if ("origin" in o) return refundWire(o);
    return intentWire(o);
  };

  const intent = (id: string, expand: string[] = []) => {
    const i = fake.snapshot().intents.find(i => i.id === id);
    if (!i) throw new Stripe.errors.StripeInvalidRequestError({ code: "resource_missing", message: "No such payment_intent" });
    const unknown = expand.filter(field => field !== "latest_charge");
    if (unknown.length) throw new Error(`The Stripe test transport does not model expand ${unknown.join(", ")}`);
    const wire = intentWire(i);
    return expand.length && wire.latest_charge ? { ...wire, latest_charge: chargeWire(i) } : wire;
  };
  const captured = (id: string) => { times.set(id, { created: times.get(id)?.created ?? now(), captured: now() }); };
  const methods = {
    paymentIntents: strictTestClient("Stripe", {
      create: async (params: Stripe.PaymentIntentCreateParams, options?: Stripe.RequestOptions) => invoke(() => write(key(options?.idempotencyKey), params, () => {
        const i = fake.createIntent(key(), String(params.metadata?.memberId ?? "test-member"), params.amount);
        intentInputs.set(i.id, structuredClone(params));
        times.set(i.id, { created: now() });
        if (params.confirm && params.capture_method !== "manual") { fake.capture(key(), i.id, params.amount); captured(i.id); }
        return intent(i.id);
      })),
      retrieve: async (id: string, params?: Stripe.PaymentIntentRetrieveParams) => intent(id, params?.expand),
      capture: async (id: string, params?: Stripe.PaymentIntentCaptureParams, options?: Stripe.RequestOptions) => invoke(() => {
        const before = intent(id).amount_received;
        fake.capture(key(options?.idempotencyKey), id, params?.amount_to_capture ?? intent(id).amount);
        // A replayed capture keeps the first capture's time.
        if (!before) captured(id);
        return intent(id);
      }),
      cancel: async (id: string) => invoke(() => { fake.cancel(id); return intent(id); }),
    }),
    refunds: strictTestClient("Stripe", {
      // A replayed key returns the original refund; a reused key with other parameters is refused.
      create: async (params: Stripe.RefundCreateParams, options?: Stripe.RequestOptions) => invoke(() => write(key(options?.idempotencyKey), params, () => {
        const id = params.payment_intent ?? fake.snapshot().intents.find(i => `charge-${i.id}` === params.charge)?.id;
        if (!id) throw new Error("A refund needs a known intent or charge");
        // Without an amount Stripe refunds what is left: the capture less every refund not failed.
        const left = intent(id).amount_received - fake.snapshot().refunds.filter(r => r.payment_intent === id && r.status !== "failed").reduce((n, r) => n + r.amount, 0);
        if (params.amount === undefined && left === 0) throw new StripeFakeError("charge_already_refunded", "Charge has already been refunded");
        const r = fake.refund(key(), id, params.amount ?? left);
        refundInputs.set(r.id, structuredClone(params));
        return refundWire(r);
      })),
      retrieve: async (id: string) => {
        const r = fake.snapshot().refunds.find(r => r.id === id);
        if (!r) throw new Stripe.errors.StripeInvalidRequestError({ code: "resource_missing", message: "No such refund" });
        return refundWire(r);
      },
      list: (params: Stripe.RefundListParams) => {
        const data = fake.snapshot().refunds.filter(r => (!params.charge || r.charge === params.charge) && (!params.payment_intent || r.payment_intent === params.payment_intent)).map(refundWire);
        return Object.assign(Promise.resolve({ object: "list", data, has_more: false }), {
          async *[Symbol.asyncIterator]() { yield* data; },
        });
      },
    }),
  };
  return {
    client: strictTestClient<Stripe>("Stripe", methods),
    /** The fake's events as Stripe delivers them; each object keeps its point-in-time economic fields. */
    events: (): Stripe.Event[] => fake.snapshot().events.map(e => ({
      ...e, object: "event", livemode: false, created: Math.floor(Date.now() / 1000), api_version: Stripe.API_VERSION,
      data: { object: wire(e.data.object) },
    }) as unknown as Stripe.Event),
  };
}
