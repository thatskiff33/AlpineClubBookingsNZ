/**
 * Scenario: the booking writes a busy morning produces, across lodges and
 * nights — issue #4940.
 *
 * booking-contention.js stampedes one lodge and one night. Real traffic is a
 * mix: members book, change their dates and cancel, on every lodge, over a
 * spread of nights, while other requests take beds. Each VU logs in once as
 * its OWN volume-seeded member (`pnpm run load:seed-volume`; LOAD_VOLUME_USERS
 * must be at least PEAK_VUS) and each iteration runs one member's full cycle:
 *
 *   1. POST /api/bookings                      self-booking, one or two nights
 *      201 → PAYMENT_PENDING; 409 CAPACITY_EXCEEDED when the lodge is full
 *   2. PUT  /api/bookings/:id/modify-dates     one night longer (200, or 409)
 *   3. POST /api/bookings/:id/cancel           credit refund (200)
 *   4. POST /api/bookings                      on the first iteration only, a
 *      child-only request that holds a bed in AWAITING_REVIEW (201, or the
 *      capacity 409), so beds fill up while the cycle runs
 *
 * Neighbouring VUs and iterations land on different lodges and nights
 * (`mixedWriteStay`), so writers queue on the global key and on more than one
 * lodge key at once (INV-LOCK-001, INV-LOCK-002). Each VU cancels its booking
 * before the next, so its own member nights never conflict.
 *
 * Outcomes other than those listed count against `mixed_unexpected`. Teardown
 * reads every lodge night the run could touch and `capacity_ceiling` requires
 * each to be at or under its lodge's capacity (`evaluateOccupancyCeiling`):
 * interleaved creates, moves and cancels must never overbook a night.
 *
 * Booking create allows 20 per hour per client IP. Each VU has its own
 * synthetic IP and makes at most MIXED_ITERATIONS + 1 creates (default 6), so
 * the cron-on rerun in CI (MIXED_ITERATIONS=4) still fits in the same hour.
 *
 * Run (throwaway local stack ONLY — see docs/LOAD_TESTING.md):
 *   BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
 *     LOAD_USER_PASSWORD=... LOAD_VOLUME_USERS=100 \
 *     k6 run load/scenarios/mixed-writes.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import exec from "k6/execution";
import { assertSafeTarget } from "../lib/target-guard.js";
import { loadConfig, requireCredentials } from "../lib/config.js";
import {
  clearSession,
  ensureLoggedIn,
  SCENARIO_IP_OFFSETS,
} from "../lib/session.js";
import {
  bookableLodgeIds,
  jsonHeaders,
  occupancyReadings,
  selfGuest,
} from "../lib/app-api.js";
import { evaluateOccupancyCeiling } from "../lib/contention-invariant.js";
import {
  addDaysIso,
  mixedWriteNights,
  mixedWriteStay,
  utcDayOf,
} from "../lib/stay-window.js";

const cfg = loadConfig(__ENV); // init-context guard: aborts unsafe targets
requireCredentials(cfg);

// 409 is the app's normal "full" or "conflicting change" answer to a write.
// Set per write rather than globally, so cron-overlap's imported dashboard
// reads still count a 409 as a failure.
const WRITE_STATUSES = http.expectedStatuses(200, 201, 302, 409);

const IP = SCENARIO_IP_OFFSETS.mixedWrites;

const created = new Counter("mixed_bookings_created");
const modified = new Counter("mixed_bookings_modified");
const cancelled = new Counter("mixed_bookings_cancelled");
const holds = new Counter("mixed_holds_created");
const capacityRejections = new Counter("mixed_capacity_rejections");
const unexpected = new Rate("mixed_unexpected");
const loginSuccess = new Rate("mixed_login_success");
const capacityCeiling = new Rate("capacity_ceiling");

export const options = {
  scenarios: {
    mixed_writes: {
      executor: "per-vu-iterations",
      vus: cfg.peakVus,
      iterations: cfg.mixedIterations,
      maxDuration: "15m",
    },
  },
  thresholds: {
    // Every write here takes the global advisory lock, so latency gets the
    // contention budget rather than the read one.
    "http_req_duration{flow:mixed_writes}": ["p(95)<" + cfg.contentionP95Ms],
    "http_req_failed{flow:mixed_writes}": ["rate<" + cfg.maxErrorRate],
    mixed_bookings_created: ["count>0"],
    mixed_bookings_modified: ["count>0"],
    mixed_bookings_cancelled: ["count>0"],
    mixed_unexpected: ["rate<" + cfg.maxErrorRate],
    mixed_login_success: ["rate>" + (1 - cfg.maxErrorRate)],
    capacity_ceiling: ["rate==1"],
  },
};

function vuEmail() {
  return cfg.volumeUsers[(exec.vu.idInTest - 1) % cfg.volumeUsers.length];
}

export function setup() {
  assertSafeTarget(__ENV); // belt-and-braces re-check
  if (cfg.volumeUsers.length < cfg.peakVus) {
    throw new Error(
      "mixed-writes gives every VU its own member: set LOAD_VOLUME_USERS to at least PEAK_VUS (" +
        cfg.peakVus +
        ") after seeding them with `pnpm run load:seed-volume`."
    );
  }
  clearSession(cfg);
  if (
    !ensureLoggedIn(
      cfg,
      cfg.volumeUsers[0],
      cfg.userPassword,
      { loggedIn: false, loginAttempted: false },
      IP
    )
  ) {
    throw new Error("mixed-writes setup login failed for " + cfg.volumeUsers[0]);
  }
  const start = addDaysIso(utcDayOf(Date.now()), cfg.stayOffsetDays);
  const lodgeIds = bookableLodgeIds(cfg, IP);
  if (lodgeIds.length < 2) throw new Error("mixed-writes requires at least two bookable lodges");
  return { start: start, lodgeIds: lodgeIds };
}

export function teardown(data) {
  clearSession(cfg);
  if (
    !ensureLoggedIn(
      cfg,
      cfg.volumeUsers[0],
      cfg.userPassword,
      { loggedIn: false, loginAttempted: false },
      IP
    )
  ) {
    capacityCeiling.add(false);
    return;
  }
  const readings = occupancyReadings(
    cfg,
    data.lodgeIds,
    mixedWriteNights(data.start, cfg.mixedNightSpread),
    IP
  );
  const result = evaluateOccupancyCeiling(readings);
  if (!result.passed) {
    console.error(
      "capacity_ceiling violations: " + JSON.stringify(result.violations)
    );
  }
  capacityCeiling.add(result.passed);
}

const vuState = { loggedIn: false, loginAttempted: false };
let self = null;

function bodyField(res, field) {
  try {
    return res.json(field);
  } catch {
    return undefined;
  }
}


function post(path, body) {
  return http.post(cfg.baseUrl + path, JSON.stringify(body), {
    headers: jsonHeaders(IP),
    tags: { flow: "mixed_writes" },
    timeout: "60s",
    responseCallback: WRITE_STATUSES,
  });
}

function isCapacity409(res) {
  return res.status === 409 && bodyField(res, "code") === "CAPACITY_EXCEEDED";
}

export default function mixedWrites(data) {
  const loggedIn = ensureLoggedIn(
    cfg,
    vuEmail(),
    cfg.userPassword,
    vuState,
    IP
  );
  if (__ITER === 0) loginSuccess.add(loggedIn);
  if (loggedIn && !self) self = selfGuest(cfg, IP, "mixed_writes");
  const guest = self;
  if (!guest) {
    unexpected.add(true);
    return;
  }

  const vu = exec.vu.idInTest;
  const stay = mixedWriteStay(
    data.start,
    vu,
    __ITER,
    cfg.mixedNightSpread,
    data.lodgeIds.length
  );
  const lodgeId = data.lodgeIds[stay.lodgeIndex];

  // 1. Book.
  const createRes = post("/api/bookings", {
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    lodgeId: lodgeId,
    guests: [guest],
    notes: "k6 load harness #4940 — throwaway stack only",
  });
  const bookingId = createRes.status === 201 ? bodyField(createRes, "id") : "";
  const full = isCapacity409(createRes);
  if (bookingId) created.add(1);
  if (full) capacityRejections.add(1);
  unexpected.add(!(bookingId || full));
  check(createRes, {
    "self-booking created (201) or clean capacity 409": function () {
      return Boolean(bookingId) || full;
    },
  });

  if (bookingId) {
    sleep(cfg.thinkTime);

    // 2. One night longer. A full next night is a normal 409.
    const modifyRes = http.put(
      cfg.baseUrl + "/api/bookings/" + bookingId + "/modify-dates",
      JSON.stringify({ checkOut: addDaysIso(stay.checkOut, 1) }),
      {
        headers: jsonHeaders(IP),
        tags: { flow: "mixed_writes" },
        timeout: "60s",
        responseCallback: WRITE_STATUSES,
      }
    );
    if (modifyRes.status === 200) modified.add(1);
    unexpected.add(!(modifyRes.status === 200 || modifyRes.status === 409));
    check(modifyRes, {
      "date change applied (200) or refused cleanly (409)": function (r) {
        return r.status === 200 || r.status === 409;
      },
    });

    sleep(cfg.thinkTime);

    // 3. Cancel, so this member's next stay never overlaps it.
    const cancelRes = post("/api/bookings/" + bookingId + "/cancel", {
      refundMethod: "credit",
    });
    if (cancelRes.status === 200) cancelled.add(1);
    unexpected.add(cancelRes.status !== 200);
    check(cancelRes, {
      "booking cancelled (200)": function (r) {
        return r.status === 200;
      },
    });
  }

  // 4. Once per VU, a bed held for review on another lodge night.
  if (__ITER === 0) {
    const holdStay = mixedWriteStay(
      data.start,
      vu + 1,
      __ITER,
      cfg.mixedNightSpread,
      data.lodgeIds.length
    );
    const holdRes = post("/api/bookings", {
      checkIn: holdStay.checkIn,
      checkOut: holdStay.checkOut,
      lodgeId: data.lodgeIds[holdStay.lodgeIndex],
      guests: [
        {
          firstName: "LoadTest",
          lastName: "Hold" + vu,
          ageTier: "CHILD",
          isMember: false,
        },
      ],
      notes: "k6 load harness #4940 — throwaway stack only",
      memberReviewJustification:
        "Load harness child-only request: hold a bed during mixed writes",
    });
    const held =
      holdRes.status === 201 &&
      bodyField(holdRes, "status") === "AWAITING_REVIEW";
    const holdFull = isCapacity409(holdRes);
    if (held) holds.add(1);
    if (holdFull) capacityRejections.add(1);
    unexpected.add(!(held || holdFull));
    check(holdRes, {
      "capacity-holding request created (201) or clean capacity 409":
        function () {
          return held || holdFull;
        },
    });
  }

  sleep(cfg.thinkTime);
}
