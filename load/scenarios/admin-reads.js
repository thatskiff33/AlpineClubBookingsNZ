/** Admin lists, reports and the bed board on volume history (#4940). */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";
import { loadConfig, rampStages } from "../lib/config.js";
import { assertSafeTarget } from "../lib/target-guard.js";
import { ensureLoggedIn, SCENARIO_IP_OFFSETS, vuHeaders } from "../lib/session.js";
import { addDaysIso, utcDayOf } from "../lib/stay-window.js";

const cfg = loadConfig(__ENV);
if (!cfg.adminPassword) throw new Error("LOAD_ADMIN_PASSWORD or LOAD_USER_PASSWORD is required");
const IP = SCENARIO_IP_OFFSETS.adminReads;
const loggedIn = new Rate("admin_login_success");
export const options = {
  stages: rampStages(cfg),
  thresholds: {
    "http_req_duration{flow:admin_reads}": ["p(95)<" + cfg.p95Ms],
    "http_req_failed{flow:admin_reads}": ["rate<" + cfg.maxErrorRate],
    "checks{flow:admin_reads}": ["rate>" + (1 - cfg.maxErrorRate)],
    admin_login_success: ["rate>" + (1 - cfg.maxErrorRate)],
  },
};
export function setup() {
  assertSafeTarget(__ENV);
  const today = utcDayOf(Date.now());
  return { today: today, reportFrom: addDaysIso(today, -365) };
}
const state = { loggedIn: false, loginAttempted: false };
export default function adminReads(data) {
  const first = !state.loginAttempted;
  const ok = ensureLoggedIn(cfg, cfg.adminEmail, cfg.adminPassword, state, IP);
  if (first) loggedIn.add(ok);
  if (!ok) return;
  const paths = [
    "/api/admin/bookings?calendarMonth=" + data.today.slice(0, 7),
    "/api/admin/reports?from=" + data.reportFrom + "&to=" + data.today,
    "/api/admin/bed-allocation?from=" + data.today + "&to=" + addDaysIso(data.today, 6),
  ];
  for (const path of paths) {
    const res = http.get(cfg.baseUrl + path, {
      headers: vuHeaders(IP), tags: { flow: "admin_reads" }, redirects: 0,
    });
    check(res, {
      "admin API returns JSON, without a sign-in redirect": function (r) {
        return r.status === 200 && String(r.headers["Content-Type"]).indexOf("application/json") !== -1;
      },
    }, { flow: "admin_reads" });
    sleep(cfg.thinkTime);
  }
}
