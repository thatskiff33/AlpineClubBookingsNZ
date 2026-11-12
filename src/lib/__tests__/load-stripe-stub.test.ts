/**
 * The load harness's Stripe stub (#4940) against the real Stripe SDK.
 *
 * The stub is only useful if the app's unmodified Stripe client accepts its
 * answers and the app's webhook route accepts its signed events. So this drives
 * the stub with the same `stripe` package the app uses, over loopback HTTP, and
 * verifies the signed event with the SDK's own `constructEvent`, the call the
 * webhook route makes (`constructWebhookEvent` in src/lib/stripe.ts).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStripeStub,
  parseStripeForm,
  signStripePayload,
} from "../../../load/stripe-stub/server.mjs";

const SECRET_KEY = "sk_test_loadstub_0123456789abcdef0123456789";
const WEBHOOK_SECRET = "whsec_loadstub_0123456789abcdef";

let api: http.Server;
let control: http.Server;
let stripe: Stripe;
let controlUrl = "";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function sdk(key: string, port: number) {
  return new Stripe(key, {
    apiVersion: Stripe.API_VERSION as Stripe.LatestApiVersion,
    host: "127.0.0.1",
    port,
    protocol: "http",
    maxNetworkRetries: 0,
    telemetry: false,
  });
}

let apiPort = 0;

beforeAll(async () => {
  const stub = createStripeStub({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET });
  api = http.createServer((req, res) => void stub.apiHandler(req, res));
  control = http.createServer((req, res) => void stub.controlHandler(req, res));
  apiPort = await listen(api);
  controlUrl = `http://127.0.0.1:${await listen(control)}`;
  stripe = sdk(SECRET_KEY, apiPort);
});

afterAll(async () => {
  await new Promise((resolve) => api.close(resolve));
  await new Promise((resolve) => control.close(resolve));
});

describe("load Stripe stub (#4940)", () => {
  it("serves the card-payment calls the app makes, through the real SDK", async () => {
    expect((await stripe.customers.list({ email: "load-00001@demo.alpineclub.test", limit: 100 })).data).toEqual([]);
    const customer = await stripe.customers.create({
      email: "load-00001@demo.alpineclub.test",
      name: "Load Member",
      metadata: { memberId: "m1" },
    });
    expect((await stripe.customers.list({ email: customer.email!, limit: 100 })).data.map((c) => c.id)).toEqual([
      customer.id,
    ]);

    const params = {
      amount: 4500,
      currency: "nzd",
      customer: customer.id,
      metadata: { bookingId: "b1", type: "booking" },
      automatic_payment_methods: { enabled: true },
    };
    const intent = await stripe.paymentIntents.create(params, { idempotencyKey: "load-key-1" });
    expect(intent).toMatchObject({ amount: 4500, currency: "nzd", status: "requires_payment_method", livemode: false });
    expect(intent.client_secret).toMatch(new RegExp(`^${intent.id}_secret_`));
    // A replayed idempotency key answers with the original intent, as Stripe does.
    expect((await stripe.paymentIntents.create(params, { idempotencyKey: "load-key-1" })).id).toBe(intent.id);

    await stripe.paymentIntents.update(intent.id, { metadata: { mintKey: "k" } });
    const fetched = await stripe.paymentIntents.retrieve(intent.id, { expand: ["latest_charge"] });
    expect(fetched.metadata).toEqual({ bookingId: "b1", type: "booking", mintKey: "k" });
    const listed: string[] = [];
    for await (const pi of stripe.paymentIntents.list({ customer: customer.id, limit: 100 })) listed.push(pi.id);
    expect(listed).toEqual([intent.id]);
    expect((await stripe.refunds.list({ payment_intent: intent.id, limit: 100 })).data).toEqual([]);
  });

  it("signs a succeeded event that the SDK's webhook verification accepts", async () => {
    const intent = await stripe.paymentIntents.create({ amount: 9000, currency: "nzd", metadata: { bookingId: "b2" } });
    const res = await fetch(`${controlUrl}/control/payment_intents/${intent.id}/succeed`, { method: "POST" });
    expect(res.status).toBe(200);
    const { payload, signature } = (await res.json()) as { payload: string; signature: string };

    const event = stripe.webhooks.constructEvent(payload, signature, WEBHOOK_SECRET);
    expect(event.type).toBe("payment_intent.succeeded");
    expect(event.livemode).toBe(false);
    const paid = event.data.object as Stripe.PaymentIntent;
    expect(paid).toMatchObject({ id: intent.id, amount: 9000, status: "succeeded", metadata: { bookingId: "b2" } });
    expect(typeof paid.payment_method).toBe("string");

    // The app reads the method the intent was paid with.
    const method = await stripe.paymentMethods.retrieve(paid.payment_method as string);
    expect(method.card?.last4).toBe("4242");
    expect((await stripe.paymentIntents.retrieve(intent.id)).status).toBe("succeeded");

    // The signature binds the payload and the secret: anything else is refused.
    expect(() => stripe.webhooks.constructEvent(payload.replace("9000", "1"), signature, WEBHOOK_SECRET)).toThrow();
    expect(() => stripe.webhooks.constructEvent(payload, signature, "whsec_someone_else")).toThrow();
  });

  it("refuses a live key, any key but its own, and endpoints it does not serve", async () => {
    await expect(sdk("sk_live_should_never_be_here_000000", apiPort).customers.list()).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringMatching(/refuses live keys/),
    });
    await expect(sdk("sk_test_another_key_00000000000000", apiPort).customers.list()).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(stripe.subscriptions.list()).rejects.toMatchObject({ statusCode: 404, code: "resource_missing" });
    expect(() => createStripeStub({ secretKey: "sk_live_x", webhookSecret: WEBHOOK_SECRET })).toThrow(/sk_test_/);
    expect(() => createStripeStub({ secretKey: SECRET_KEY, webhookSecret: "secret" })).toThrow(/whsec_/);
  });

  it("parses Stripe's bracketed form encoding", () => {
    expect(parseStripeForm("amount=10&metadata[a]=1&metadata[b]=2&expand[0]=x&expand[1]=y&flags[]=z")).toEqual({
      amount: "10",
      metadata: { a: "1", b: "2" },
      expand: ["x", "y"],
      flags: ["z"],
    });
    expect(signStripePayload("{}", "whsec_x", 1)).toMatch(/^t=1,v1=[0-9a-f]{64}$/);
  });
});
