/**
 * Local Stripe stub for the load harness's payment path (#4940).
 *
 * The app talks to Stripe only through the official SDK, which dials
 * `https://api.stripe.com`. On the load stack the stub's container answers to
 * that name on the compose network (`load/compose.stripe-stub.yml`), and the
 * app trusts the stub's throwaway CA through `NODE_EXTRA_CA_CERTS`, so the app
 * runs unmodified and no request can leave for the real Stripe. Nothing here is
 * a product path; it exists so a k6 run can measure the app's own work on a
 * card payment, which a live or test-mode Stripe account would rate-limit and
 * bill for.
 *
 * Two listeners:
 *
 *   API      the subset of Stripe's REST API the app calls on a card payment
 *            (customers, payment intents, payment methods, refunds). It
 *            answers only the one throwaway `sk_test_` key it was started
 *            with and refuses any `sk_live_` key outright.
 *   CONTROL  loopback-published HTTP for the k6 script:
 *            `POST /control/payment_intents/<id>/succeed` marks an intent paid
 *            and returns `{ payload, signature }`, a `payment_intent.succeeded`
 *            event signed exactly as Stripe signs one (`t=<ts>,v1=<HMAC-SHA256
 *            of "<ts>.<payload>">`), for the script to deliver to the app's
 *            webhook route. The app verifies it with the SDK's own
 *            `constructEvent`, the same check a real delivery passes.
 *
 * Plain Node with no dependencies, so the pinned Node image runs it as-is and
 * `src/lib/__tests__/load-stripe-stub.test.ts` drives it with the real SDK.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

// Only labels the signed event; neither `constructEvent` nor the app's
// handlers read it.
const STUB_API_VERSION = "2026-10-28.endive";

function stripeError(status, type, message, code) {
  return {
    status,
    body: { error: { type, message, ...(code ? { code } : {}) } },
  };
}

/**
 * Stripe's form encoding (`metadata[bookingId]=x`, `expand[0]=a`,
 * `expand[]=a`) back into an object. Array indices become array entries.
 */
export function parseStripeForm(text) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(text || "")) {
    const parts = rawKey.split("[").map((part, i) => (i === 0 ? part : part.replace(/]$/, "")));
    if (parts.some((part) => ["__proto__", "constructor", "prototype"].includes(part))) {
      throw new Error("Unsafe Stripe form key");
    }
    let node = out;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(parts[i + 1]);
      if (Array.isArray(node)) {
        if (last) node.push(value);
        else {
          const index = part === "" ? node.length : Number(part);
          node[index] ??= nextIsIndex ? [] : {};
          node = node[index];
        }
      } else if (last) {
        node[part] = value;
      } else {
        node[part] ??= nextIsIndex ? [] : {};
        node = node[part];
      }
    }
  }
  return out;
}

/** The `Stripe-Signature` header Stripe sends with `payload` at `timestamp`. */
export function signStripePayload(payload, secret, timestamp) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/**
 * The stub's state and request handlers, without listeners, so a test can
 * mount them on an ephemeral port.
 */
export function createStripeStub({ secretKey, webhookSecret, now = () => Date.now() }) {
  if (typeof secretKey !== "string" || !secretKey.startsWith("sk_test_")) {
    throw new Error("Stripe stub needs a throwaway sk_test_ key (STUB_SECRET_KEY).");
  }
  if (typeof webhookSecret !== "string" || !webhookSecret.startsWith("whsec_")) {
    throw new Error("Stripe stub needs a throwaway whsec_ signing secret (STUB_WEBHOOK_SECRET).");
  }

  const customers = new Map();
  const intents = new Map();
  const refunds = new Map();
  const idempotent = new Map();
  let sequence = 0;
  const seconds = () => Math.floor(now() / 1000);
  const newId = (prefix) => `${prefix}_stub${(sequence += 1).toString(36)}${randomBytes(6).toString("hex")}`;
  const list = (url, data) => ({ object: "list", url, has_more: false, data });

  function authorise(header) {
    const key = /^Bearer (.+)$/.exec(header || "")?.[1] ?? "";
    if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) {
      return stripeError(401, "invalid_request_error", "The Stripe stub refuses live keys.");
    }
    if (key !== secretKey) {
      return stripeError(401, "invalid_request_error", "Invalid API Key provided to the Stripe stub.");
    }
    return null;
  }

  function createIntent(params) {
    const amount = Number(params.amount);
    if (!Number.isInteger(amount) || amount < 1) {
      return stripeError(400, "invalid_request_error", "amount must be a positive integer", "parameter_invalid_integer");
    }
    const id = newId("pi");
    const intent = {
      id,
      object: "payment_intent",
      amount,
      amount_capturable: 0,
      amount_received: 0,
      automatic_payment_methods: params.automatic_payment_methods ? { enabled: true } : null,
      client_secret: `${id}_secret_${randomBytes(12).toString("hex")}`,
      created: seconds(),
      currency: String(params.currency || "").toLowerCase(),
      customer: params.customer ?? null,
      latest_charge: null,
      livemode: false,
      metadata: { ...(params.metadata || {}) },
      payment_method: params.payment_method ?? null,
      payment_method_types: ["card"],
      status: "requires_payment_method",
    };
    intents.set(id, intent);
    if (params.confirm === "true" && params.payment_method) succeed(intent);
    return { status: 200, body: intent };
  }

  function succeed(intent) {
    intent.status = "succeeded";
    intent.amount_received = intent.amount;
    intent.payment_method ??= newId("pm");
    intent.latest_charge ??= newId("ch");
    return intent;
  }

  function apiRoute(method, path, params) {
    const [, resource, id, action] = path.split("/").slice(1);
    if (resource === "customers") {
      if (method === "POST" && !id) {
        const customer = {
          id: newId("cus"),
          object: "customer",
          created: seconds(),
          email: params.email ?? null,
          name: params.name ?? null,
          livemode: false,
          metadata: { ...(params.metadata || {}) },
        };
        customers.set(customer.id, customer);
        return { status: 200, body: customer };
      }
      if (method === "GET" && !id) {
        const data = [...customers.values()].filter((c) => !params.email || c.email === params.email);
        return { status: 200, body: list("/v1/customers", data) };
      }
      if (method === "GET" && customers.has(id)) return { status: 200, body: customers.get(id) };
    }
    if (resource === "payment_intents") {
      if (method === "POST" && !id) return createIntent(params);
      if (method === "GET" && !id) {
        const data = [...intents.values()]
          .filter((pi) => !params.customer || pi.customer === params.customer)
          .sort((a, b) => b.created - a.created);
        return { status: 200, body: list("/v1/payment_intents", data) };
      }
      const intent = intents.get(id);
      if (intent && method === "GET" && !action) return { status: 200, body: intent };
      if (intent && method === "POST" && !action) {
        if (params.metadata) Object.assign(intent.metadata, params.metadata);
        if (params.amount !== undefined) intent.amount = Number(params.amount);
        return { status: 200, body: intent };
      }
      if (intent && method === "POST" && action === "cancel") {
        if (intent.status === "succeeded") {
          return stripeError(400, "invalid_request_error", "This PaymentIntent has already succeeded.", "payment_intent_unexpected_state");
        }
        intent.status = "canceled";
        intent.cancellation_reason = params.cancellation_reason ?? null;
        return { status: 200, body: intent };
      }
    }
    if (resource === "payment_methods" && method === "GET" && id) {
      return {
        status: 200,
        body: {
          id,
          object: "payment_method",
          type: "card",
          card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2034, funding: "credit", country: "NZ" },
          customer: [...intents.values()].find((pi) => pi.payment_method === id)?.customer ?? null,
          livemode: false,
          metadata: {},
        },
      };
    }
    if (resource === "refunds") {
      if (method === "GET" && !id) {
        const data = [...refunds.values()].filter(
          (r) => (!params.payment_intent || r.payment_intent === params.payment_intent) && (!params.charge || r.charge === params.charge),
        );
        return { status: 200, body: list("/v1/refunds", data) };
      }
      if (method === "GET" && refunds.has(id)) return { status: 200, body: refunds.get(id) };
      if (method === "POST" && !id) {
        const intent = intents.get(params.payment_intent);
        if (!intent || intent.status !== "succeeded") {
          return stripeError(400, "invalid_request_error", "No succeeded PaymentIntent to refund.", "resource_missing");
        }
        const refund = {
          id: newId("re"),
          object: "refund",
          amount: params.amount !== undefined ? Number(params.amount) : intent.amount,
          charge: intent.latest_charge,
          created: seconds(),
          currency: intent.currency,
          metadata: { ...(params.metadata || {}) },
          payment_intent: intent.id,
          reason: params.reason ?? null,
          status: "succeeded",
        };
        refunds.set(refund.id, refund);
        return { status: 200, body: refund };
      }
    }
    if (resource === "checkout" && id === "sessions" && method === "GET") {
      return { status: 200, body: list("/v1/checkout/sessions", []) };
    }
    return stripeError(404, "invalid_request_error", `The Stripe stub does not serve ${method} ${path}.`, "resource_missing");
  }

  async function apiHandler(req, res) {
    const url = new URL(req.url, "http://stub.invalid");
    const body = await readBody(req);
    let result = authorise(req.headers.authorization);
    if (!result) {
      const key = req.method === "POST" ? req.headers["idempotency-key"] : undefined;
      const replayKey = key ? `${req.method} ${url.pathname} ${key}` : null;
      if (replayKey && idempotent.has(replayKey)) {
        result = idempotent.get(replayKey);
      } else {
        const params = req.method === "GET" ? parseStripeForm(url.search.slice(1)) : parseStripeForm(body);
        result = url.pathname.startsWith("/v1/")
          ? apiRoute(req.method, url.pathname, params)
          : stripeError(404, "invalid_request_error", "Unknown path.", "resource_missing");
        // Stripe answers a replayed key with the original response, frozen.
        if (replayKey) {
          result = { status: result.status, body: JSON.parse(JSON.stringify(result.body)) };
          idempotent.set(replayKey, result);
        }
      }
    }
    send(res, result.status, result.body, { "request-id": `req_stub_${randomBytes(6).toString("hex")}` });
  }

  async function controlHandler(req, res) {
    const url = new URL(req.url, "http://stub.invalid");
    await readBody(req);
    if (req.method === "GET" && url.pathname === "/control/health") {
      return send(res, 200, { ok: true, service: "load-stripe-stub" });
    }
    const match = /^\/control\/payment_intents\/([^/]+)\/succeed$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      const intent = intents.get(decodeURIComponent(match[1]));
      if (!intent) return send(res, 404, { error: "unknown payment intent" });
      if (intent.status === "canceled") return send(res, 409, { error: "payment intent was canceled" });
      succeed(intent);
      const created = seconds();
      const payload = JSON.stringify({
        id: newId("evt"),
        object: "event",
        api_version: STUB_API_VERSION,
        created,
        data: { object: intent },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: "payment_intent.succeeded",
      });
      return send(res, 200, { payload, signature: signStripePayload(payload, webhookSecret, created) });
    }
    return send(res, 404, { error: "unknown control path" });
  }

  return { apiHandler, controlHandler, intents };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function guarded(handler) {
  return (req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) send(res, 500, { error: { type: "api_error", message: String(error && error.message) } });
    });
  };
}

function main(env) {
  const stub = createStripeStub({ secretKey: env.STUB_SECRET_KEY, webhookSecret: env.STUB_WEBHOOK_SECRET });
  const apiPort = Number(env.STUB_API_PORT || 443);
  const controlPort = Number(env.STUB_CONTROL_PORT || 12111);
  const api =
    env.STUB_TLS_CERT && env.STUB_TLS_KEY
      ? https.createServer(
          { cert: readFileSync(env.STUB_TLS_CERT), key: readFileSync(env.STUB_TLS_KEY) },
          guarded(stub.apiHandler),
        )
      : http.createServer(guarded(stub.apiHandler));
  api.listen(apiPort, () => console.log(`stripe-stub API on :${apiPort}`));
  http
    .createServer(guarded(stub.controlHandler))
    .listen(controlPort, env.STUB_CONTROL_HOST || "127.0.0.1", () =>
      console.log(`stripe-stub control on :${controlPort}`),
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.env);
}
