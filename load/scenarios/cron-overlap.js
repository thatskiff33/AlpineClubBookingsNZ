/** Dashboard and mixed writes while the real cron cycle runs locally (#4940). */
import http from "k6/http";
import { sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import { loadConfig } from "../lib/config.js";
import { assertSafeTarget } from "../lib/target-guard.js";
import dashboard, { options as dashboardOptions, setup as dashboardSetup } from "./member-dashboard.js";
import mixedWrites, { options as mixedOptions, setup as mixedSetup, teardown as mixedTeardown } from "./mixed-writes.js";

const cfg = loadConfig(__ENV);
if (!__ENV.CRON_SECRET) throw new Error("CRON_SECRET from the disposable stack is required");
const completed = new Counter("cron_cycles_completed");
const succeeded = new Rate("cron_cycle_success");
export const options = {
  scenarios: {
    dashboard: { executor: "constant-vus", exec: "readDashboard", vus: cfg.peakVus, duration: cfg.steady },
    mixed: { executor: "per-vu-iterations", exec: "writeBookings", vus: cfg.peakVus,
      iterations: cfg.mixedIterations, maxDuration: "15m" },
    cron: { executor: "constant-vus", exec: "runCron", vus: 1, duration: cfg.steady },
  },
  thresholds: Object.assign({}, dashboardOptions.thresholds, mixedOptions.thresholds, {
    cron_cycles_completed: ["count>0"], cron_cycle_success: ["rate==1"],
  }),
};
export function setup() {
  assertSafeTarget(__ENV);
  // VU ids are unique across scenarios. Seed enough distinct members for
  // both sets of workers; each write worker still owns its own member.
  if (cfg.volumeUsers.length < cfg.peakVus * 2 + 1) {
    throw new Error("Cron overlap requires LOAD_VOLUME_USERS >= 2 * PEAK_VUS + 1");
  }
  return { dashboard: dashboardSetup(), mixed: mixedSetup() };
}
export function readDashboard(data) { dashboard(data.dashboard); }
export function writeBookings(data) { mixedWrites(data.mixed); }
export function teardown(data) { mixedTeardown(data.mixed); }
export function runCron() {
  // Same runner as the scheduler. Explicit invocation guarantees work during
  // this short run instead of hoping it lands on a three-hour cron boundary.
  const res = http.post(cfg.baseUrl + "/api/cron", null, {
    headers: { "x-cron-secret": __ENV.CRON_SECRET },
    tags: { flow: "cron" }, timeout: "120s",
  });
  const ok = res.status === 200 && res.json("success") === true;
  succeeded.add(ok);
  if (ok) completed.add(1);
  sleep(1);
}
