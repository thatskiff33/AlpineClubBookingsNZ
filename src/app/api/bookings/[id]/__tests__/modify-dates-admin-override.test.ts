import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  legacyRole: vi.fn(),
  managementRole: vi.fn(),
  modifyBookingDates: vi.fn(),
  adminShiftBookingDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
// #3232: this route now reaches the hosting engine through the shared linked-move
// arms, which widens the module graph far enough to pull in the access-role
// DEFINITIONS table — so a factory that replaced this module wholesale threw at
// import and killed the file before a single test ran. Partial-mock it: only the
// one function this suite steers is replaced.
vi.mock("@/lib/access-roles", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  authorizationRoleFromAccessRoles: h.legacyRole,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.managementRole,
}));
vi.mock("@/lib/booking-date-modification-service", () => ({
  modifyBookingDates: h.modifyBookingDates,
  adminShiftBookingDates: h.adminShiftBookingDates,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PUT } from "@/app/api/bookings/[id]/modify-dates/route";
import {
  XeroLockDateCheckFailedError,
  XeroPeriodLockedError,
} from "@/lib/xero-period-lock-guard";
import {
  MinimumStayPolicyViolationError,
  type MinimumStayPolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-dates", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.legacyRole.mockReturnValue("USER");
  h.managementRole.mockReturnValue("ADMIN");
  h.modifyBookingDates.mockResolvedValue({ ok: "dates" });
  h.adminShiftBookingDates.mockResolvedValue({ ok: "shift" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/bookings/[id]/modify-dates admin override gating (issue #1668)", () => {
  it("rejects override flags when the management role is not ADMIN (403), no service call", async () => {
    h.managementRole.mockReturnValue("USER");

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(h.modifyBookingDates).not.toHaveBeenCalled();
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("dispatches a shift override to adminShiftBookingDates with the management role", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-09-12",
        confirmOverCapacity: true,
        notifyMember: false,
        hostingCoverageOverride: {
          acknowledged: true,
          reason: "Confirmed alternate supervision plan.",
          strandedStateKey: `v1:${"a".repeat(64)}`,
        },
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.adminShiftBookingDates).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingDates).not.toHaveBeenCalled();
    const arg = h.adminShiftBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    expect(arg.hostingCoverageOverride).toEqual({
      acknowledged: true,
      reason: "Confirmed alternate supervision plan.",
      strandedStateKey: `v1:${"a".repeat(64)}`,
    });
    // The admin's email choice is threaded to the service (owner decision).
    expect(arg.input).toMatchObject({
      checkIn: "2026-09-12",
      confirmOverCapacity: true,
      notifyMember: false,
    });
  });

  it("dispatches a recalculate override to modifyBookingDates with the flags threaded", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-09-12",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingDates).toHaveBeenCalledTimes(1);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
    const arg = h.modifyBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    expect(arg.input).toMatchObject({
      adminOverride: true,
      checkIn: "2026-09-12",
    });
  });

  it("keeps the legacy role mapping for requests without override flags", async () => {
    const res = await PUT(req({ checkIn: "2026-09-12" }), { params });

    expect(res.status).toBe(200);
    expect(h.managementRole).not.toHaveBeenCalled();
    expect(h.modifyBookingDates).toHaveBeenCalledTimes(1);
    const arg = h.modifyBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "USER" });
    expect(arg.input).not.toHaveProperty("adminOverride", true);
  });

  it("keeps the legacy role for adminOverride: false — a caller boolean cannot flip the standard path's authority", async () => {
    const res = await PUT(
      req({ adminOverride: false, checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingDates).toHaveBeenCalledTimes(1);
    const arg = h.modifyBookingDates.mock.calls[0][0];
    // Management role is only consulted for the 403 gate; the service call
    // stays on the legacy mapping because the override is not active.
    expect(arg.actor).toEqual({ id: "u1", role: "USER" });
  });
});

describe("PUT /api/bookings/[id]/modify-dates notify choice on plain edits (issue #1696)", () => {
  it("accepts notifyMember alone (no adminOverride) from an ADMIN and threads it with the management role", async () => {
    const res = await PUT(
      req({ checkIn: "2026-09-12", notifyMember: false }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingDates).toHaveBeenCalledTimes(1);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
    const arg = h.modifyBookingDates.mock.calls[0][0];
    // notifyMember lifts the role to the management mapping (→ ADMIN) so the
    // service honours the choice, without an adminOverride being present.
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    expect(arg.input).toMatchObject({ checkIn: "2026-09-12", notifyMember: false });
    expect(arg.input).not.toHaveProperty("adminOverride", true);
  });

  it("rejects notifyMember alone from a non-ADMIN with 403, no service call", async () => {
    h.managementRole.mockReturnValue("USER");

    const res = await PUT(
      req({ checkIn: "2026-09-12", notifyMember: false }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(h.modifyBookingDates).not.toHaveBeenCalled();
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("still requires adminOverride for confirmOverCapacity (400)", async () => {
    const res = await PUT(
      req({ checkIn: "2026-09-12", confirmOverCapacity: true }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.modifyBookingDates).not.toHaveBeenCalled();
  });

  it("still requires adminOverride for pricingMode (400)", async () => {
    const res = await PUT(
      req({ checkIn: "2026-09-12", pricingMode: "recalculate" }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.modifyBookingDates).not.toHaveBeenCalled();
  });
});

describe("PUT /api/bookings/[id]/modify-dates Xero lock-date guard mapping (issue #1697)", () => {
  it("maps XeroPeriodLockedError to 409 with the machine-readable code and lockDate", async () => {
    h.modifyBookingDates.mockRejectedValue(
      new XeroPeriodLockedError("2026-06-30"),
    );

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "recalculate", checkIn: "2026-06-15" }),
      { params },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "XERO_PERIOD_LOCKED",
      lockDate: "2026-06-30",
      error: expect.stringContaining("2026-06-30"),
    });
  });

  it("maps XeroLockDateCheckFailedError to a retryable 503 with its code", async () => {
    h.modifyBookingDates.mockRejectedValue(new XeroLockDateCheckFailedError());

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "recalculate", checkIn: "2026-06-15" }),
      { params },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "XERO_LOCK_DATE_CHECK_FAILED",
    });
  });
});

describe("PUT /api/bookings/[id]/modify-dates minimum-stay mapping (#2363)", () => {
  it("returns the frozen review in the existing blocking 400 response", async () => {
    const violation: MinimumStayPolicyExceptionViolation = {
      reasonCode: "MINIMUM_STAY",
      policyId: "policy-lodge-b",
      policyVersion: 9,
      policyName: "Lodge B winter week",
      resolvedScope: {
        kind: "LODGE",
        lodgeId: "lodge-b",
        effectiveLodgeId: "lodge-b",
      },
      affectedNights: ["2027-09-02", "2027-09-03"],
      exceptionEligible: true,
      capacityMode: "NO_HOLD",
      message: "Lodge B requires three nights.",
      triggerDay: "Thursday",
      minimumNights: 3,
      actualNights: 2,
      requirements: {
        kind: "MINIMUM_STAY",
        minimumNights: 3,
        actualNights: 2,
        triggerDays: [4],
      },
    };
    h.modifyBookingDates.mockRejectedValue(
      new MinimumStayPolicyViolationError(
        "Lodge B winter week: minimum 3 nights",
        [violation],
      ),
    );

    const res = await PUT(
      req({ checkIn: "2027-09-02", checkOut: "2027-09-04" }),
      { params },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Lodge B winter week: minimum 3 nights",
      code: "MINIMUM_STAY_VIOLATION",
      details: "Lodge B winter week: minimum 3 nights",
      violations: [violation],
      exceptionReview: {
        violations: [violation],
        capacityMode: "NO_HOLD",
      },
    });
  });
});
