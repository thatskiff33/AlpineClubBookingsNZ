import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/bookings/[id]/fresh-email-copy.
 *
 * The route's job is the gate and the input contract: the bookings edit
 * permission, and a body that names a template and NOTHING else — no
 * recipient, body, token or amount can reach the service from the caller.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  sendBookingFreshEmailCopy: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/booking-fresh-email-copy", () => ({
  sendBookingFreshEmailCopy: mocks.sendBookingFreshEmailCopy,
}));
vi.mock("@/lib/audit", () => ({
  getAuditRequestContext: () => ({
    id: "req_1",
    ipAddress: "127.0.0.1",
    userAgent: "vitest",
  }),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/fresh-email-copy/route";

const params = Promise.resolve({ id: "bk_1" });

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/bookings/bk_1/fresh-email-copy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin_1" } },
  });
  mocks.sendBookingFreshEmailCopy.mockResolvedValue({
    ok: true,
    template: "booking-confirmed",
    sentTo: "owner@example.org",
    archivedFailureCount: 1,
    warning: null,
  });
});

describe("admin booking fresh email copy route", () => {
  it("requires the bookings edit permission", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(request({ template: "booking-confirmed" }), { params });

    expect(response.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "edit" },
    });
    expect(mocks.sendBookingFreshEmailCopy).not.toHaveBeenCalled();
  });

  it("sends on behalf of the signed-in officer with the template alone", async () => {
    const response = await POST(request({ template: "booking-confirmed" }), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      template: "booking-confirmed",
      sentTo: "owner@example.org",
      archivedFailureCount: 1,
      warning: null,
    });
    expect(mocks.sendBookingFreshEmailCopy).toHaveBeenCalledWith({
      bookingId: "bk_1",
      template: "booking-confirmed",
      actorMemberId: "admin_1",
      auditRequest: { id: "req_1", ipAddress: "127.0.0.1", userAgent: "vitest" },
    });
  });

  it.each([
    { template: "booking-confirmed", to: "someone-else@example.org" },
    { template: "booking-confirmed", body: "<p>hello</p>" },
    { template: "split-guest-payment-link", token: "abc" },
    { template: "split-guest-payment-link", amountCents: 1 },
    { template: "member-welcome" },
    {},
    null,
  ])("rejects %o: only a known template may be named", async (body) => {
    const response = await POST(request(body), { params });

    expect(response.status).toBe(400);
    expect(mocks.sendBookingFreshEmailCopy).not.toHaveBeenCalled();
  });

  it("passes a refusal through with its own status and message", async () => {
    mocks.sendBookingFreshEmailCopy.mockResolvedValue({
      ok: false,
      status: 422,
      error: "The owner's email address is on the bounce or complaint suppression list.",
    });

    const response = await POST(request({ template: "pre-arrival-reminder" }), { params });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "The owner's email address is on the bounce or complaint suppression list.",
    });
  });

  it("answers 500 without claiming a send when the service throws", async () => {
    mocks.sendBookingFreshEmailCopy.mockRejectedValue(new Error("boom"));

    const response = await POST(request({ template: "pre-arrival-reminder" }), { params });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toMatch(/could not be sent/);
  });
});
