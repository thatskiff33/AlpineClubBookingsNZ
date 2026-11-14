/**
 * Card booking, intent creation and signed webhook delivery against the local
 * Stripe stub only (#4940). No Stripe credential enters k6. The control port
 * signs an event; the unmodified app verifies it with Stripe's SDK. Replaying
 * the exact event also exercises webhook deduplication. This measures the app,
 * not Stripe latency or card-network behaviour.
 */
import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Rate, Counter } from "k6/metrics";
import { loadConfig, requireCredentials } from "../lib/config.js";
import { assertSafeTarget } from "../lib/target-guard.js";
import { clearSession, ensureLoggedIn, login, SCENARIO_IP_OFFSETS, vuHeaders } from "../lib/session.js";
import { bookableLodgeIds, jsonHeaders, selfGuest } from "../lib/app-api.js";
import { addDaysIso, paymentStay, utcDayOf } from "../lib/stay-window.js";

const cfg = loadConfig(__ENV);
requireCredentials(cfg);
const IP = SCENARIO_IP_OFFSETS.paymentPath;
const success = new Rate("payment_journey_success");
const logins = new Rate("payment_login_success");
const settled = new Counter("payment_bookings_settled");
export const options = {
  scenarios: { payment_path: {
    executor: "per-vu-iterations", vus: cfg.peakVus,
    iterations: cfg.paymentIterations, maxDuration: "15m",
  } },
  thresholds: {
    "http_req_duration{flow:payment_path}": ["p(95)<" + cfg.contentionP95Ms],
    "http_req_failed{flow:payment_path}": ["rate<" + cfg.maxErrorRate],
    payment_journey_success: ["rate>" + (1 - cfg.maxErrorRate)],
    payment_login_success: ["rate>" + (1 - cfg.maxErrorRate)],
    payment_bookings_settled: ["count>0"],
  },
};
export function setup() {
  assertSafeTarget(__ENV);
  if (cfg.volumeUsers.length < cfg.peakVus) throw new Error("Seed LOAD_VOLUME_USERS >= PEAK_VUS");
  if (!cfg.adminPassword) throw new Error("LOAD_ADMIN_PASSWORD or LOAD_USER_PASSWORD is required");
  const health = http.get(cfg.stripeStubUrl + "/control/health");
  if (health.status !== 200 || health.json("service") !== "load-stripe-stub") {
    throw new Error("The local Stripe stub is required; run scripts/load-stack.sh prepare");
  }
  clearSession(cfg);
  if (!ensureLoggedIn(cfg, cfg.volumeUsers[0], cfg.userPassword,
    { loggedIn: false, loginAttempted: false }, IP)) throw new Error("Payment setup login failed");
  return {
    start: addDaysIso(utcDayOf(Date.now()), cfg.stayOffsetDays + cfg.paymentOffsetDays),
    lodgeIds: bookableLodgeIds(cfg, IP),
  };
}
const state = { loggedIn: false, loginAttempted: false };
let guest = null;
// Members have no booking-status read API, so each VU holds a second, admin
// session in its own cookie jar and reads the booking through the admin search.
let adminJar = null;
function adminStatusOf(bookingId) {
  if (!adminJar) {
    const jar = new http.CookieJar();
    if (!login(cfg, cfg.adminEmail, cfg.adminPassword, IP, jar)) return null;
    adminJar = jar;
  }
  const res = http.get(cfg.baseUrl + "/api/admin/bookings/search?limit=1&q=" +
    encodeURIComponent(bookingId), {
    headers: vuHeaders(IP), tags: { flow: "payment_path" }, jar: adminJar, redirects: 0,
  });
  if (res.status !== 200) return null;
  const row = (res.json("bookings") || []).find(function (b) { return b.id === bookingId; });
  return row ? row.status : null;
}
function post(path, body) {
  return http.post(cfg.baseUrl + path, JSON.stringify(body), {
    headers: jsonHeaders(IP), tags: { flow: "payment_path" }, timeout: "60s",
  });
}
export default function paymentPath(data) {
  const vu = exec.vu.idInTest;
  const ok = ensureLoggedIn(cfg, cfg.volumeUsers[vu - 1], cfg.userPassword, state, IP);
  if (__ITER === 0) logins.add(ok);
  if (!ok) { success.add(false); return; }
  if (!guest) guest = selfGuest(cfg, IP, "payment_path");
  if (!guest) { success.add(false); return; }
  const stay = paymentStay(data.start, vu, __ITER, data.lodgeIds.length);
  const created = post("/api/bookings", {
    checkIn: stay.checkIn, checkOut: stay.checkOut,
    lodgeId: data.lodgeIds[stay.lodgeIndex], guests: [guest],
    notes: "k6 local stub payment #4940",
  });
  if (created.status !== 201) { success.add(false); return; }
  const id = created.json("id");
  const intent = post("/api/payments/create-payment-intent", { bookingId: id });
  if (intent.status !== 200 || !intent.json("paymentIntentId")) { success.add(false); return; }
  const signed = http.post(cfg.stripeStubUrl + "/control/payment_intents/" +
    encodeURIComponent(intent.json("paymentIntentId")) + "/succeed", null);
  if (signed.status !== 200) { success.add(false); return; }
  const event = signed.json();
  let delivered = true;
  for (let replay = 0; replay < 2; replay += 1) {
    const res = http.post(cfg.baseUrl + "/api/webhooks/stripe", event.payload, {
      headers: Object.assign(jsonHeaders(IP), { "Stripe-Signature": event.signature }),
      tags: { flow: "payment_path" }, timeout: "60s",
    });
    delivered = delivered && res.status === 200;
    check(res, { "signed webhook accepted, including replay": function (r) { return r.status === 200; } });
  }
  // The booking's stored status proves the webhook changed the booking,
  // rather than treating a webhook's HTTP acknowledgement as settlement.
  const confirmed = adminStatusOf(id) === "PAID";
  success.add(delivered && confirmed);
  if (delivered && confirmed) settled.add(1);
  sleep(cfg.thinkTime);
}
