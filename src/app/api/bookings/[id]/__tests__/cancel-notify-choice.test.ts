import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level gating for the per-cancel member-email choice (issue #1705,
// #1696 semantics): only a booking-management ADMIN (Full Admin / Booking
// Officer) may carry `notifyMember`; any other caller is 403'd before the
// cancel service runs, and an omitted flag threads as undefined (= notify).
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  cancelBooking: vi.fn(),
  authorizationRoleFromAccessRoles: vi.fn(),
  managementRole: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: h.cancelBooking }));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/access-roles", () => ({
  authorizationRoleFromAccessRoles: h.authorizationRoleFromAccessRoles,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.managementRole,
  hasAdminAreaAccess: h.hasAdminAreaAccess,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/cancel/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/cancel", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRoleFromAccessRoles.mockReturnValue("ADMIN");
  h.managementRole.mockReturnValue("ADMIN");
  h.hasAdminAreaAccess.mockReturnValue(true);
  h.cancelBooking.mockResolvedValue({
    status: 200,
    data: { success: true, refundAmountCents: 0, refundPercentage: 0, refundMethod: "card", message: "ok" },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/bookings/[id]/cancel notify choice (issue #1705)", () => {
  it("accepts notifyMember: false from a booking-management ADMIN and threads it to the service", async () => {
    const res = await POST(req({ refundMethod: "card", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.cancelBooking).toHaveBeenCalledTimes(1);
    const options = h.cancelBooking.mock.calls[0][6];
    expect(options).toMatchObject({ notifyMember: false });
  });

  it("threads notifyMember as undefined (= notify) when the flag is omitted", async () => {
    const res = await POST(req({ refundMethod: "card" }), { params });

    expect(res.status).toBe(200);
    expect(h.cancelBooking).toHaveBeenCalledTimes(1);
    const options = h.cancelBooking.mock.calls[0][6];
    expect(options.notifyMember).toBeUndefined();
  });

  it("rejects notifyMember from a non-ADMIN with 403, no service call", async () => {
    h.authorizationRoleFromAccessRoles.mockReturnValue("USER");
    h.managementRole.mockReturnValue("USER");
    h.hasAdminAreaAccess.mockReturnValue(false);

    const res = await POST(req({ refundMethod: "card", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(403);
    expect(h.cancelBooking).not.toHaveBeenCalled();
  });

  it("leaves a member self-cancel without the flag untouched (service still called)", async () => {
    h.authorizationRoleFromAccessRoles.mockReturnValue("USER");
    h.managementRole.mockReturnValue("USER");
    h.hasAdminAreaAccess.mockReturnValue(false);

    const res = await POST(req({ refundMethod: "credit" }), { params });

    expect(res.status).toBe(200);
    expect(h.cancelBooking).toHaveBeenCalledTimes(1);
    expect(h.cancelBooking.mock.calls[0][5]).toBe("credit");
    expect(h.cancelBooking.mock.calls[0][6].notifyMember).toBeUndefined();
  });

  it("rejects a non-boolean notifyMember with 400", async () => {
    const res = await POST(
      req({ refundMethod: "card", notifyMember: "false" }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.cancelBooking).not.toHaveBeenCalled();
  });

  it("threads enforceStartedStayBlock: true so the service applies the #2029 started-stay guard", async () => {
    // The self-service cancel surface always opts in; the service exempts a Full
    // Admin internally, so this flag is safe to pass unconditionally here.
    const res = await POST(req({ refundMethod: "card" }), { params });

    expect(res.status).toBe(200);
    expect(h.cancelBooking).toHaveBeenCalledTimes(1);
    expect(h.cancelBooking.mock.calls[0][6]).toMatchObject({
      enforceStartedStayBlock: true,
    });
  });
});
