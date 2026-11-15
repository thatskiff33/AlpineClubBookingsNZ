/**
 * Programmatic NextAuth (Auth.js v5) credentials login for k6 VUs
 * (issue #1884).
 *
 * The app's login form drives the standard Auth.js two-step:
 *   1. GET  /api/auth/csrf                      → { csrfToken } + CSRF cookie
 *   2. POST /api/auth/callback/credentials      (urlencoded form)
 * On success the response sets the session cookie
 * (`authjs.session-token` over http, `__Secure-authjs.session-token` over
 * https), which k6's per-VU cookie jar then replays automatically.
 *
 * Rate limits: the app keys its limiters on the LAST entry of
 * `X-Forwarded-For` (Caddy appends the real client IP in deployment). The
 * local staging stack publishes the app with no proxy in front, so — exactly
 * like the Playwright e2e helpers — each VU sends a unique synthetic
 * 10.99.x.x address to avoid tripping the 10-per-15-min login limiter from a
 * single runner IP. This only works against the throwaway stack; it is not a
 * production bypass because production's Caddy appends the true client IP
 * after any spoofed value.
 */

import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

// Keep fixed-window rate-limit evidence independent when scenarios run back
// to back on the same throwaway stack. Each offset reserves a separate block
// of synthetic client IPs; repeated-login iterations advance within the login
// block. Re-running the same scenario still requires a fresh stack/window.
export const SCENARIO_IP_OFFSETS = Object.freeze({
  publicBrowse: 0,
  login: 100,
  memberDashboard: 200,
  bookingContention: 300,
  mixedWrites: 400,
  adminReads: 500,
  paymentPath: 600,
  capacityProbe: 9000,
});

/**
 * Deterministic synthetic client IP for this VU (optionally offset per
 * iteration for scenarios that log in repeatedly).
 */
export function syntheticClientIp(offset) {
  // setup/teardown execute outside a VU, where idInTest is not populated.
  const vuId = Number(exec.vu.idInTest) || 0;
  const n = vuId + (offset || 0) * 1024;
  const b = Math.floor(n / 250) % 250;
  const c = n % 250;
  return "10.99." + (b + 1) + "." + (c + 1);
}

/** Standard headers for one VU: unique synthetic client IP. */
export function vuHeaders(offset) {
  return { "X-Forwarded-For": syntheticClientIp(offset) };
}

/**
 * True if this VU's cookie jar (or the given `jar`) already holds a session
 * cookie.
 */
export function hasSession(baseUrl, jar) {
  const cookies = (jar || http.cookieJar()).cookiesForURL(baseUrl + "/");
  return SESSION_COOKIE_NAMES.some(function (name) {
    return cookies[name] && cookies[name].length > 0;
  });
}

/**
 * Log this VU in with email + password. Returns true on success.
 * Tags requests `flow:login` so latency can be thresholded separately.
 * Pass a `jar` (an `http.CookieJar`) to hold a second session alongside the
 * VU's default one.
 */
export function login(cfg, email, password, ipOffset, jar) {
  const headers = vuHeaders(ipOffset);
  const tags = { flow: "login" };

  const csrfRes = http.get(cfg.baseUrl + "/api/auth/csrf", {
    headers: headers,
    tags: tags,
    jar: jar,
  });
  const csrfOk = check(csrfRes, {
    "csrf endpoint returned 200": function (r) {
      return r.status === 200;
    },
  });
  let csrfToken = "";
  if (csrfOk) {
    try {
      csrfToken = csrfRes.json("csrfToken") || "";
    } catch {
      csrfToken = "";
    }
  }
  if (!csrfToken) {
    return false;
  }

  // k6 urlencodes an object body and sets the form content type itself.
  const loginRes = http.post(
    cfg.baseUrl + "/api/auth/callback/credentials",
    {
      csrfToken: csrfToken,
      email: email,
      password: password,
      callbackUrl: cfg.baseUrl + "/",
    },
    { headers: headers, tags: tags, jar: jar }
  );

  return check(loginRes, {
    "login established a session cookie": function () {
      return hasSession(cfg.baseUrl, jar);
    },
    "login response not a rate-limit or server error": function (r) {
      return r.status < 429;
    },
  });
}

/** Drop this VU's cookies so the next login starts from scratch. */
export function clearSession(cfg) {
  http.cookieJar().clear(cfg.baseUrl + "/");
}

/** Log in at most once per VU and remember the outcome (for read scenarios). */
export function ensureLoggedIn(cfg, email, password, state, ipOffset) {
  if (state.loggedIn && hasSession(cfg.baseUrl)) {
    return true;
  }
  if (state.loginAttempted) {
    return false;
  }
  state.loginAttempted = true;
  state.loggedIn = login(cfg, email, password, ipOffset || 0);
  return state.loggedIn;
}
