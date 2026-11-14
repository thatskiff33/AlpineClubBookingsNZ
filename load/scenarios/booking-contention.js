/**
 * Scenario: booking-hold contention on ONE lodge + ONE night — issue #1884.
 *
 * The core scaling concern: a draft or confirmed booking create
 * (`createDraftBooking`, `createConfirmedBooking`) takes the GLOBAL advisory
 * lock `pg_advisory_xact_lock(1)` first and then the per-lodge capacity key
 * (`acquireLodgeCapacityLock`, src/lib/lodge-capacity-lock.ts) — INV-LOCK-001
 * (tier) and INV-LOCK-002 (global before lodge; see
 * docs/CONCURRENCY_AND_LOCKING.md). So those creates, on any lodge, queue
 * behind the one global key, not just this lodge's. A waitlist create
 * (`createWaitlistedBooking`) takes only the lodge key. This scenario
 * stampedes PEAK_VUS members (default 100) at `POST /api/bookings` for the
 * same lodge and the same night. Losers of the race do NOT error out early:
 * they block on the lock, re-check capacity, and get the app's normal
 * sold-out answer. So the assertions accept exactly two outcomes:
 *
 *   201                          booking created (a winner)
 *   409 code=CAPACITY_EXCEEDED   lodge full / lost the race (a normal loser)
 *
 * Anything else (5xx, timeouts, 4xx other than the capacity 409) counts
 * against the `booking_unexpected` threshold and fails the run. Latency gets
 * a deliberately loose p95 (CONTENTION_P95_MS, default 5000ms) because the
 * advisory lock serialises writers by design; what must NOT happen is
 * errors or unbounded queueing.
 *
 * setup and teardown query the same availability calendar. The
 * `capacity_invariant` gate requires a known baseline and the exact expected
 * capacity-limited occupancy delta (default seed: 0 to 20).
 *
 * Bookings are child-only requests, which intentionally enter
 * AWAITING_REVIEW and therefore hold capacity without calling Stripe/Xero.
 * The throwaway stack may capture admin-review email in Mailpit. Each VU makes
 * CONTENTION_ATTEMPTS (default 1)
 * attempts, staying under the 20-per-hour per-IP booking-create limiter.
 * Every VU authenticates once before an absolute write barrier. The default
 * 60-second auth warmup isolates bcrypt CPU from the tagged booking request
 * and releases the standard 100 writes together; a late bootstrap fails the
 * run instead of contaminating the contention evidence.
 *
 * Run (throwaway local stack ONLY — see docs/LOAD_TESTING.md):
 *   BASE_URL=http://localhost:3001 LOAD_TEST_CONFIRM_TARGET=1 \
 *     LOAD_USER_EMAIL=alice@demo.alpineclub.test LOAD_USER_PASSWORD=... \
 *     k6 run load/scenarios/booking-contention.js
 *
 * CONTENTION_CHECKIN defaults to a night 116 days after the run's day
 * (load/lib/stay-window.js), so the command needs no date.
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
  vuHeaders,
} from "../lib/session.js";
import { bookableLodgeIds } from "../lib/app-api.js";
import { evaluateContentionOccupancy } from "../lib/contention-invariant.js";

const cfg = loadConfig(__ENV); // init-context guard: aborts unsafe targets
requireCredentials(cfg);

// 201 = won the race; 409 = the app's normal "sold out / lost the race"
// answer. Neither should count toward http_req_failed in this scenario.
http.setResponseCallback(http.expectedStatuses(200, 201, 302, 409));

const bookingsCreated = new Counter("bookings_created");
const capacityRejections = new Counter("booking_capacity_rejections");
const unexpected = new Rate("booking_unexpected");
const capacityInvariant = new Rate("capacity_invariant");
const authReadyBeforeBarrier = new Rate("contention_auth_ready_before_barrier");

function addOneDay(dateOnly) {
  const t = Date.parse(dateOnly + "T00:00:00Z") + 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

const checkIn = cfg.contentionCheckIn;
const checkOut = cfg.contentionCheckOut || addOneDay(checkIn);

export const options = {
  scenarios: {
    booking_contention: {
      executor: "per-vu-iterations",
      vus: cfg.peakVus,
      iterations: cfg.contentionAttempts,
      maxDuration: "10m",
    },
  },
  thresholds: {
    // The advisory lock serialises writers; latency may be high but the
    // outcome distribution must stay clean.
    "http_req_duration{flow:booking_contention}": [
      "p(95)<" + cfg.contentionP95Ms,
    ],
    booking_unexpected: ["rate<" + cfg.maxErrorRate],
    contention_auth_ready_before_barrier: ["rate==1"],
    capacity_invariant: ["rate==1"],
    http_req_failed: ["rate<" + cfg.maxErrorRate],
  },
};

export function setup() {
  assertSafeTarget(__ENV); // belt-and-braces re-check
  const probe = http.get(cfg.baseUrl + "/", {
    responseCallback: http.expectedStatuses(200),
  });
  if (probe.status !== 200) {
    throw new Error(
      "Target probe failed: GET " + cfg.baseUrl + "/ returned " + probe.status
    );
  }
  clearSession(cfg);
  if (
    !ensureLoggedIn(
      cfg,
      cfg.userEmail,
      cfg.userPassword,
      { loggedIn: false, loginAttempted: false },
      SCENARIO_IP_OFFSETS.bookingContention
    )
  ) {
    throw new Error("Capacity baseline login failed");
  }
  // Booking create refuses a request that names no lodge, so an empty
  // LODGE_ID means the member's first bookable lodge, named explicitly on
  // both the writes and the occupancy reads.
  const lodgeId =
    cfg.lodgeId ||
    bookableLodgeIds(cfg, SCENARIO_IP_OFFSETS.bookingContention)[0];
  const baselineOccupied = occupiedBedsForCheckIn(lodgeId);
  if (baselineOccupied !== cfg.contentionExpectedBaseline) {
    throw new Error(
      "Contention night baseline was " +
        baselineOccupied +
        ", expected " +
        cfg.contentionExpectedBaseline +
        ". Reset the throwaway stack or set CONTENTION_EXPECTED_BASELINE explicitly."
    );
  }
  return {
    lodgeId: lodgeId,
    baselineOccupied: baselineOccupied,
    writeBarrierAtMs:
      Date.now() + cfg.contentionAuthWarmupSeconds * 1000,
  };
}

function occupiedBedsForCheckIn(lodgeId) {
  const year = parseInt(checkIn.slice(0, 4), 10);
  const month = parseInt(checkIn.slice(5, 7), 10) - 1;
  const url =
    cfg.baseUrl +
    "/api/availability?year=" +
    year +
    "&month=" +
    month +
    "&lodgeId=" +
    encodeURIComponent(lodgeId);
  const res = http.get(url, {
    headers: vuHeaders(SCENARIO_IP_OFFSETS.capacityProbe),
    responseCallback: http.expectedStatuses(200),
  });
  if (res.status !== 200) {
    throw new Error(
      "Capacity verification failed: availability returned " + res.status
    );
  }
  const body = res.json();
  const occupied = Number(
    body && body.availability && body.availability[checkIn]
  );
  if (!isFinite(occupied) || occupied < 0) {
    throw new Error(
      "Capacity verification found no numeric occupancy for " + checkIn
    );
  }
  return occupied;
}

export function teardown(data) {
  clearSession(cfg);
  if (
    !ensureLoggedIn(
      cfg,
      cfg.userEmail,
      cfg.userPassword,
      { loggedIn: false, loginAttempted: false },
      SCENARIO_IP_OFFSETS.bookingContention
    )
  ) {
    capacityInvariant.add(false);
    return;
  }
  const finalOccupied = occupiedBedsForCheckIn(data && data.lodgeId);
  const baselineOccupied = Number(data && data.baselineOccupied);
  const result = evaluateContentionOccupancy({
    baseline: baselineOccupied,
    finalOccupied: finalOccupied,
    capacity: cfg.lodgeCapacity,
    attempts: cfg.peakVus * cfg.contentionAttempts,
  });
  capacityInvariant.add(result.passed);
}

// Per-VU login memo. VUs round-robin across the optional LOAD_USERS pool so
// runs can spread load over several seeded members; all share LOAD_USER_PASSWORD.
const vuState = { loggedIn: false, loginAttempted: false };

function vuEmail() {
  const pool = [cfg.userEmail].concat(cfg.userPool);
  return pool[(exec.vu.idInTest - 1) % pool.length];
}

export default function bookingContention(data) {
  if (
    !ensureLoggedIn(
      cfg,
      vuEmail(),
      cfg.userPassword,
      vuState,
      SCENARIO_IP_OFFSETS.bookingContention
    )
  ) {
    authReadyBeforeBarrier.add(false);
    unexpected.add(true);
    return;
  }

  if (__ITER === 0) {
    const writeBarrierAtMs = Number(data && data.writeBarrierAtMs);
    const waitMs = writeBarrierAtMs - Date.now();
    const readyBeforeBarrier = isFinite(writeBarrierAtMs) && waitMs > 0;
    authReadyBeforeBarrier.add(readyBeforeBarrier);
    if (!readyBeforeBarrier) {
      // Do not let a late bcrypt completion overlap and inflate the booking
      // advisory-lock latency. The strict rate threshold makes the run red.
      unexpected.add(true);
      return;
    }
    sleep(waitMs / 1000);
  }

  const vuId = exec.vu.idInTest;
  const body = {
    checkIn: checkIn,
    checkOut: checkOut,
    guests: [
      {
        firstName: "LoadTest",
        lastName: "VU" + vuId + "I" + __ITER,
        ageTier: "CHILD",
        isMember: false,
      },
    ],
    notes: "k6 load harness #1884 — throwaway stack only",
    memberReviewJustification:
      "Load harness child-only request: hold capacity for contention verification",
    lodgeId: data && data.lodgeId,
  };

  const res = http.post(cfg.baseUrl + "/api/bookings", JSON.stringify(body), {
    headers: Object.assign(
      { "Content-Type": "application/json" },
      vuHeaders(SCENARIO_IP_OFFSETS.bookingContention)
    ),
    tags: { flow: "booking_contention" },
    timeout: "60s",
  });

  let code = "";
  let bookingStatus = "";
  try {
    code = res.json("code") || "";
    bookingStatus = res.json("status") || "";
  } catch {
    code = "";
    bookingStatus = "";
  }

  // A 201 is only a winner if it entered the capacity-holding review state.
  // This prevents a future policy drift back to non-holding PENDING writes
  // from producing deceptively green contention evidence.
  const created = res.status === 201 && bookingStatus === "AWAITING_REVIEW";
  const lostRace = res.status === 409 && code === "CAPACITY_EXCEEDED";
  if (created) bookingsCreated.add(1);
  if (lostRace) capacityRejections.add(1);
  unexpected.add(!(created || lostRace));

  check(res, {
    "capacity-holding booking created (201) or clean capacity 409": function () {
      return created || lostRace;
    },
    "capacity 409 carries the standard body": function (r) {
      if (r.status !== 409 || code !== "CAPACITY_EXCEEDED") return true;
      try {
        return (
          r.json("canWaitlist") === true &&
          Array.isArray(r.json("fullNights"))
        );
      } catch {
        return false;
      }
    },
  });

  sleep(cfg.thinkTime);
}
