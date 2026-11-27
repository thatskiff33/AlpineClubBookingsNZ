import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSaveFigures } from "@/lib/__tests__/support/edit-save-figures";
import { NextRequest } from "next/server";

// #2363. PUT /api/bookings/[id]/modify is the save endpoint the member edit
// panel and the admin booking screen actually call. When the service refuses a
// non-admin's edit on minimum stay, the route must answer with the machine-
// readable code and the FULL frozen review — and it must do so from a branch
// placed ABOVE the generic `ApiError` branch, because
// MinimumStayPolicyViolationError extends ApiError and would otherwise be
// flattened to a bare `{ error }`.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  modifyBookingBatch: vi.fn(),
  adminShiftBookingDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: h.modifyBookingBatch,
}));
vi.mock("@/lib/booking-date-modification-service", () => ({
  adminShiftBookingDates: h.adminShiftBookingDates,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PUT } from "@/app/api/bookings/[id]/modify/route";
import {
  MinimumStayPolicyViolationError,
  type MinimumStayPolicyExceptionViolation,
} from "@/lib/booking-policy-exceptions";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify", {
    method: "PUT",
    body: JSON.stringify(withSaveFigures(body)),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

const violation: MinimumStayPolicyExceptionViolation = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-lodge-b",
  policyVersion: 7,
  policyName: "Lodge B winter week",
  resolvedScope: {
    kind: "LODGE",
    lodgeId: "lodge-b",
    effectiveLodgeId: "lodge-b",
  },
  affectedNights: ["2027-09-02"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message: "Lodge B requires three nights.",
  triggerDay: "Thursday",
  minimumNights: 3,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 3,
    actualNights: 1,
    triggerDays: [4],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.modifyBookingBatch.mockResolvedValue({ ok: "batch" });
  h.adminShiftBookingDates.mockResolvedValue({ ok: "shift" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/bookings/[id]/modify minimum-stay block (#2363)", () => {
  it("answers a member's refused save with 400, the code, and the whole frozen review", async () => {
    h.modifyBookingBatch.mockRejectedValue(
      new MinimumStayPolicyViolationError(
        "Lodge B winter week: minimum 3 nights",
        [violation],
      ),
    );

    const res = await PUT(
      req({ checkIn: "2027-09-02", checkOut: "2027-09-03" }),
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
        capacityMode: "HOLD",
      },
    });
  });

  it("keeps the snapshot out of the generic ApiError flattening (the branch order is load-bearing)", async () => {
    h.modifyBookingBatch.mockRejectedValue(
      new MinimumStayPolicyViolationError("Two nights required", [violation]),
    );

    const res = await PUT(req({ checkOut: "2027-09-03" }), { params });
    const body = await res.json();

    // A generic-ApiError answer would carry `error` alone.
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "details",
      "error",
      "exceptionReview",
      "violations",
    ]);
  });

  it("aggregates two violations to HOLD when either policy holds", async () => {
    const noHold: MinimumStayPolicyExceptionViolation = {
      ...violation,
      policyId: "policy-club-wide",
      policyName: "Club weekends",
      capacityMode: "NO_HOLD",
      resolvedScope: {
        kind: "CLUB_WIDE",
        lodgeId: null,
        effectiveLodgeId: "lodge-b",
      },
    };
    h.modifyBookingBatch.mockRejectedValue(
      new MinimumStayPolicyViolationError("Two rules apply", [
        noHold,
        violation,
      ]),
    );

    const res = await PUT(req({ checkOut: "2027-09-03" }), { params });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.exceptionReview.capacityMode).toBe("HOLD");
    expect(body.exceptionReview.violations).toHaveLength(2);
  });

  it("does not block an admin save — the service is reached and its result returned", async () => {
    h.authorizationRole.mockReturnValue("ADMIN");

    const res = await PUT(
      req({ checkIn: "2027-09-02", checkOut: "2027-09-03" }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingBatch).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingBatch.mock.calls[0][0].actor).toEqual({
      id: "u1",
      role: "ADMIN",
    });
  });

  it("leaves an admin date-shift override untouched (dispatched to the shift service)", async () => {
    h.authorizationRole.mockReturnValue("ADMIN");

    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2027-09-02",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.adminShiftBookingDates).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
  });
});
