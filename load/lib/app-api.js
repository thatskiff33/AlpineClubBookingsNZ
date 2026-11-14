/**
 * The app reads the write scenarios share (#4940): which lodges the logged-in
 * member may book, and what the availability calendar reports for them. Each
 * call runs in the caller's session (k6's per-VU cookie jar) from the caller's
 * synthetic client IP.
 */

import http from "k6/http";
import { vuHeaders } from "./session.js";
import { monthsTouched } from "./stay-window.js";

/** JSON request headers from this VU's synthetic client IP. */
export function jsonHeaders(ipOffset) {
  return Object.assign(
    { "Content-Type": "application/json" },
    vuHeaders(ipOffset)
  );
}

/**
 * The ids of the lodges the logged-in member may book, in the app's own lodge
 * order. Booking create refuses a request that names no lodge
 * (BOOKING_LODGE_REQUIRED), so a scenario resolves them up front.
 */
export function bookableLodgeIds(cfg, ipOffset) {
  const res = http.get(cfg.baseUrl + "/api/lodges", {
    headers: vuHeaders(ipOffset),
    responseCallback: http.expectedStatuses(200),
  });
  if (res.status !== 200) {
    throw new Error("GET /api/lodges returned " + res.status);
  }
  const lodges = res.json("lodges");
  const ids = (Array.isArray(lodges) ? lodges : [])
    .map(function (lodge) {
      return lodge && lodge.id;
    })
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("GET /api/lodges listed no bookable lodge");
  }
  return ids;
}

/**
 * One reading per lodge night: `{ lodgeId, night, occupied, capacity }`, the
 * shape `evaluateOccupancyCeiling` takes. A night the calendar leaves out is
 * reported with `occupied: undefined`, so the oracle fails it rather than
 * reading it as empty.
 */
export function occupancyReadings(cfg, lodgeIds, nights, ipOffset) {
  const readings = [];
  for (const lodgeId of lodgeIds) {
    for (const ym of monthsTouched(nights)) {
      const res = http.get(
        cfg.baseUrl +
          "/api/availability?year=" +
          ym.year +
          "&month=" +
          ym.month +
          "&lodgeId=" +
          encodeURIComponent(lodgeId),
        {
          headers: vuHeaders(ipOffset),
          responseCallback: http.expectedStatuses(200),
        }
      );
      if (res.status !== 200) {
        throw new Error("Availability returned " + res.status + " for lodge " + lodgeId);
      }
      const body = res.json();
      const prefix =
        String(ym.year) + "-" + String(ym.month + 1).padStart(2, "0");
      for (const night of nights) {
        if (night.slice(0, 7) !== prefix) continue;
        readings.push({
          lodgeId: lodgeId,
          night: night,
          occupied: body && body.availability ? body.availability[night] : undefined,
          capacity: body && body.lodgeCapacity,
        });
      }
    }
  }
  return readings;
}

/** The logged-in member as a guest, using the booking wizard's family API. */
export function selfGuest(cfg, ipOffset, flow) {
  const res = http.get(cfg.baseUrl + "/api/members/family", {
    headers: jsonHeaders(ipOffset), tags: { flow: flow },
  });
  if (res.status !== 200) return null;
  const members = res.json("familyMembers");
  const me = (Array.isArray(members) ? members : []).find(function (m) {
    return m.relationship === "self";
  });
  return me ? {
    firstName: me.firstName, lastName: me.lastName, ageTier: me.ageTier,
    isMember: true, memberId: me.id,
  } : null;
}
