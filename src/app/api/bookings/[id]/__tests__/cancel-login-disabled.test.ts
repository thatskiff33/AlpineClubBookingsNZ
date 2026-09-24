import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A member-facing route that acts with admin authority for an admin caller,
 * run with the REAL privilege checks and the REAL active-session guard (#3603).
 * A member whose login is switched off holds no access at all: the guard
 * refuses them on the member row it re-reads, and the privilege checks over
 * `session.user` resolve no admin authority from a claim that says login is
 * off. Each refusal is paired with the same caller at `canLogin: true`.
 */

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  memberFindUnique: vi.fn(),
  cancelBooking: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return { prisma: { member: { findUnique: honourSelect(h.memberFindUnique) } } };
});
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: h.cancelBooking }));
vi.mock("@/lib/rate-limit", () => ({ getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/bookings/[id]/cancel/route";
import { adminSession } from "@/lib/__tests__/helpers/sessions";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const EVERY_AREA_EDIT: AdminPermissionMatrix = {
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
};

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/cancel", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

function memberRow(canLogin: boolean) {
  return { active: true, canLogin, forcePasswordChange: false, twoFactorEnabled: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cancelBooking.mockResolvedValue({
    status: 200,
    data: { success: true, refundAmountCents: 0, refundPercentage: 0, refundMethod: "card", message: "ok" },
  });
});

describe("POST /api/bookings/[id]/cancel for a login-disabled admin (#3603)", () => {
  it("refuses the caller when the member row says login is disabled", async () => {
    h.auth.mockResolvedValue(adminSession({ id: "admin-1" }));
    h.memberFindUnique.mockResolvedValue(memberRow(false));

    const res = await POST(req({ refundMethod: "card" }), { params });

    expect(res.status).toBe(403);
    expect(h.cancelBooking).not.toHaveBeenCalled();
  });

  it("cancels as an admin acting on-behalf when login is enabled", async () => {
    h.auth.mockResolvedValue(adminSession({ id: "admin-1" }));
    h.memberFindUnique.mockResolvedValue(memberRow(true));

    const res = await POST(req({ refundMethod: "card", notifyMember: false }), { params });

    expect(res.status).toBe(200);
    expect(h.cancelBooking).toHaveBeenCalledTimes(1);
    expect(h.cancelBooking.mock.calls[0][2]).toBe("ADMIN");
    expect(h.cancelBooking.mock.calls[0][5]).toMatchObject({
      hasBookingsEditAccess: true,
      notifyMember: false,
    });
  });

  it("resolves no admin authority from a session claim that says login is disabled", async () => {
    // Even with the Full Admin role and a full matrix still on the claim, the
    // privilege checks read `canLogin` from it and grant nothing.
    h.auth.mockResolvedValue(
      adminSession({
        id: "admin-1",
        canLogin: false,
        adminPermissionMatrix: EVERY_AREA_EDIT,
      }),
    );
    h.memberFindUnique.mockResolvedValue(memberRow(true));

    const override = await POST(req({ refundMethod: "card", notifyMember: false }), { params });
    expect(override.status).toBe(403);
    expect(h.cancelBooking).not.toHaveBeenCalled();

    const plain = await POST(req({ refundMethod: "card" }), { params });
    expect(plain.status).toBe(200);
    expect(h.cancelBooking.mock.calls[0][2]).toBe("USER");
    expect(h.cancelBooking.mock.calls[0][5]).toMatchObject({
      hasBookingsEditAccess: false,
    });
  });
});
