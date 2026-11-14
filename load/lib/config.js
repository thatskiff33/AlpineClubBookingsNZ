/**
 * Shared env-driven configuration for the k6 load harness (issue #1884).
 * All knobs come from `__ENV`; nothing is hardcoded except safe defaults
 * for the throwaway staging stack. See docs/LOAD_TESTING.md.
 */

import { assertSafeTarget } from "./target-guard.js";
import { contentionCheckIn } from "./stay-window.js";
import { volumeUserPool } from "./volume-users.js";

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = parseInt(String(raw), 10);
  if (!isFinite(value) || value <= 0) {
    throw new Error(name + ' must be a positive integer, got "' + raw + '"');
  }
  return value;
}

function nonNegativeIntEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const value = parseInt(String(raw), 10);
  if (!isFinite(value) || value < 0) {
    throw new Error(
      name + ' must be a non-negative integer, got "' + raw + '"'
    );
  }
  return value;
}

/**
 * Build the config object every scenario uses. Runs the target-safety
 * guard first, so importing a scenario script already enforces it.
 */
export function loadConfig(env) {
  const baseUrl = assertSafeTarget(env);
  return {
    baseUrl,

    // Load shape. PEAK_VUS is the headline knob (audit target: 100+).
    peakVus: intEnv(env, "PEAK_VUS", 100),
    rampUp: env.RAMP_UP || "1m",
    steady: env.STEADY || "3m",
    rampDown: env.RAMP_DOWN || "30s",

    // Pass/fail knobs.
    p95Ms: intEnv(env, "P95_MS", 800),
    maxErrorRate: parseFloat(env.MAX_ERROR_RATE || "0.01"),

    // Seconds of think time between page hits inside one iteration.
    thinkTime: intEnv(env, "THINK_TIME", 1),

    // Test credentials — env only, never committed secrets. The staging
    // seed personas (docs/LOAD_TESTING.md) are the intended values.
    userEmail: env.LOAD_USER_EMAIL || "alice@demo.alpineclub.test",
    userPassword: env.LOAD_USER_PASSWORD || "",

    // Optional comma-separated list of extra member emails (all sharing
    // LOAD_USER_PASSWORD) so login/contention VUs can spread across accounts.
    userPool: (env.LOAD_USERS || "")
      .split(",")
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean),

    // #4940: the volume seeder's members (`pnpm run load:seed-volume`), named
    // `load-00001@<domain>` onwards. LOAD_VOLUME_USERS=n adds the first n to
    // the write scenarios; the smoke runner sets LOAD_USERS for reads too.
    volumeUsers: volumeUserPool(
      nonNegativeIntEnv(env, "LOAD_VOLUME_USERS", 0),
      env.LOAD_VOLUME_DOMAIN
    ),

    // Primary login evidence is one simultaneous cold login per VU. Values
    // above one opt into a separate repeated-login stress profile.
    loginIterationsPerVu: intEnv(env, "LOGIN_ITERATIONS_PER_VU", 1),

    // Booking-contention knobs.
    // Empty → the scenario books the member's first bookable lodge
    // (`bookableLodgeIds`); booking create never picks one itself.
    lodgeId: env.LODGE_ID || "",
    // Relative to the run's day, so the default never drifts into the past.
    contentionCheckIn: env.CONTENTION_CHECKIN || contentionCheckIn(Date.now()),
    contentionCheckOut: env.CONTENTION_CHECKOUT || "",
    contentionAttempts: intEnv(env, "CONTENTION_ATTEMPTS", 1),
    contentionP95Ms: intEnv(env, "CONTENTION_P95_MS", 5000),
    // Per-VU bcrypt logins happen before a shared absolute write barrier. The
    // default leaves ample headroom for the standard 100-VU profile on the
    // deliberately CPU-constrained evidence stack, so login CPU cannot be
    // mistaken for advisory-lock queueing in the tagged booking latency.
    contentionAuthWarmupSeconds: intEnv(
      env,
      "CONTENTION_AUTH_WARMUP_SECONDS",
      60
    ),
    lodgeCapacity: intEnv(env, "LODGE_CAPACITY", 20),
    contentionExpectedBaseline: nonNegativeIntEnv(
      env,
      "CONTENTION_EXPECTED_BASELINE",
      0
    ),

    // #4940 write scenarios. Stays start STAY_OFFSET_DAYS after the run's
    // UTC day, inside the relativized seeded seasons.
    stayOffsetDays: intEnv(env, "STAY_OFFSET_DAYS", 120),
    mixedNightSpread: intEnv(env, "MIXED_NIGHT_SPREAD", 3),
    // One create per iteration plus one first-iteration hold: five leaves
    // room for the cron-on rerun under the 20-per-hour per-IP create limiter.
    mixedIterations: intEnv(env, "MIXED_ITERATIONS", 5),
    paymentIterations: intEnv(env, "PAYMENT_ITERATIONS", 3),
    // Payment stays sit this many days after the mixed-writes window, so the
    // two scenarios never share a night.
    paymentOffsetDays: intEnv(env, "PAYMENT_OFFSET_DAYS", 30),

    // Admin reads log in as the seeded E2E admin persona.
    adminEmail: env.LOAD_ADMIN_EMAIL || "e2e-admin@demo.alpineclub.test",
    adminPassword: env.LOAD_ADMIN_PASSWORD || env.LOAD_USER_PASSWORD || "",

    // The local Stripe stub's control port (load/stripe-stub/server.mjs),
    // under the same guard as BASE_URL: a local address, never :5432.
    stripeStubUrl: assertSafeTarget(
      {
        STRIPE_STUB_URL: env.STRIPE_STUB_URL || "http://127.0.0.1:12111",
        LOAD_TEST_CONFIRM_TARGET: env.LOAD_TEST_CONFIRM_TARGET,
      },
      "STRIPE_STUB_URL"
    ),
  };
}

/** Require login credentials; call from authenticated scenarios only. */
export function requireCredentials(cfg) {
  if (!cfg.userPassword) {
    throw new Error(
      "LOAD_USER_PASSWORD is not set. Authenticated scenarios need the " +
        "seeded staging password (see docs/LOAD_TESTING.md); credentials " +
        "are env-only and never hardcoded."
    );
  }
}

/** Standard ramp: up to peak, hold, down. */
export function rampStages(cfg) {
  return [
    { duration: cfg.rampUp, target: cfg.peakVus },
    { duration: cfg.steady, target: cfg.peakVus },
    { duration: cfg.rampDown, target: 0 },
  ];
}

/** Baseline pass/fail thresholds shared by the read scenarios. */
export function standardThresholds(cfg) {
  return {
    http_req_duration: ["p(95)<" + cfg.p95Ms],
    http_req_failed: ["rate<" + cfg.maxErrorRate],
    checks: ["rate>" + (1 - cfg.maxErrorRate)],
  };
}
