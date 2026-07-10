import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn(),
}));

const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) =>
    mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));

import { auth } from "@/lib/auth";
import { cancelBooking } from "@/lib/booking-cancel";
import { POST } from "@/app/api/bookings/[id]/cancel/route";

const mockedAuth = vi.mocked(auth);
const mockedCancelBooking = vi.mocked(cancelBooking);

function makeCancelRequest(body?: BodyInit) {
  return new NextRequest("http://localhost/api/bookings/booking-1/cancel", {
    method: "POST",
    body,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  });
}

describe("POST /api/bookings/[id]/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);
    mockedCancelBooking.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        refundAmountCents: 0,
        refundPercentage: 0,
        refundMethod: "card",
        message: "Booking cancelled",
      },
    } as any);
  });

  it("rejects invalid JSON without cancelling the booking", async () => {
    const res = await POST(makeCancelRequest("{"), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid JSON",
      details: { body: expect.any(Array) },
    });
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("rejects a missing body without cancelling the booking", async () => {
    const res = await POST(makeCancelRequest(), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid JSON",
    });
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("rejects an invalid refundMethod enum without cancelling the booking", async () => {
    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "cash" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid input",
      details: {
        fieldErrors: {
          refundMethod: expect.any(Array),
        },
      },
    });
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("rejects a missing refundMethod field without cancelling the booking", async () => {
    const res = await POST(makeCancelRequest(JSON.stringify({})), {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid input",
      details: {
        fieldErrors: {
          refundMethod: expect.any(Array),
        },
      },
    });
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("rejects an invalid route id without cancelling the booking", async () => {
    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "card" })),
      { params: Promise.resolve({ id: "" }) }
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid input",
      details: {
        fieldErrors: {
          id: expect.any(Array),
        },
      },
    });
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("passes the validated refund method into cancelBooking (owner: no bookings:edit)", async () => {
    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "credit" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(200);
    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "member-1",
      "USER",
      "127.0.0.1",
      "credit",
      { hasBookingsEditAccess: false }
    );
  });

  // Issue #1313 (option A2): the route computes hasBookingsEditAccess from the
  // session's bookings-area edit permission and hands it to cancelBooking, which
  // uses it to widen ONLY the authorization gate.
  it("passes hasBookingsEditAccess: true for a Booking Officer (bookings:edit)", async () => {
    mockedAuth.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "MEMBER",
        accessRoles: [{ role: "ADMIN_BOOKINGS" }],
      },
    } as any);

    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "card" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(200);
    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "officer-1",
      "USER", // an officer keeps their honest legacy authorization role
      "127.0.0.1",
      "card",
      { hasBookingsEditAccess: true }
    );
  });

  it("passes hasBookingsEditAccess: false for a read-only admin (bookings:view), which the service then refuses", async () => {
    mockedAuth.mockResolvedValue({
      user: {
        id: "readonly-1",
        role: "MEMBER",
        accessRoles: [{ role: "ADMIN_READONLY" }],
      },
    } as any);
    mockedCancelBooking.mockResolvedValue({
      status: 403,
      error: "Forbidden",
    } as any);

    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "card" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "readonly-1",
      "USER",
      "127.0.0.1",
      "card",
      { hasBookingsEditAccess: false }
    );
    expect(res.status).toBe(403);
  });

  // Issue #1367 (F14): a member whose ONLY role is a definition-backed custom
  // role has an EMPTY enum accessRoles claim — the session carries the merged
  // admin-permission matrix instead, and the route's
  // hasAdminAreaAccess(session.user, …) gate must grant from it exactly as it
  // does for the seeded Booking Officer above.
  it("passes hasBookingsEditAccess: true for a custom definition-backed booking role (#1367)", async () => {
    mockedAuth.mockResolvedValue({
      user: {
        id: "custom-officer-1",
        role: "MEMBER",
        accessRoles: [],
        adminPermissionMatrix: {
          overview: "none",
          bookings: "edit",
          membership: "none",
          finance: "none",
          lodge: "none",
          content: "none",
          support: "none",
        },
      },
    } as any);

    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "card" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(200);
    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "custom-officer-1",
      "USER",
      "127.0.0.1",
      "card",
      { hasBookingsEditAccess: true }
    );
  });

  // Issue #1705: the admin-on-behalf email choice is honoured ONLY when the
  // actor holds bookings:edit. A member self-cancel lacks it, so a notifyMember
  // flag in the body is dropped and cancelBooking defaults to notifying.
  it("drops notifyMember from a member self-cancel (no bookings:edit)", async () => {
    const res = await POST(
      makeCancelRequest(
        JSON.stringify({ refundMethod: "card", notifyMember: false })
      ),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(200);
    // The options object carries ONLY hasBookingsEditAccess — no notifyMember —
    // so the member is always emailed.
    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "member-1",
      "USER",
      "127.0.0.1",
      "card",
      { hasBookingsEditAccess: false }
    );
  });

  it("forwards notifyMember:false for a Booking Officer acting on-behalf", async () => {
    mockedAuth.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "MEMBER",
        accessRoles: [{ role: "ADMIN_BOOKINGS" }],
      },
    } as any);

    const res = await POST(
      makeCancelRequest(
        JSON.stringify({ refundMethod: "card", notifyMember: false })
      ),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(200);
    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "officer-1",
      "USER",
      "127.0.0.1",
      "card",
      { hasBookingsEditAccess: true, notifyMember: false }
    );
  });

  it("forwards notifyMember:true for a Booking Officer acting on-behalf", async () => {
    mockedAuth.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "MEMBER",
        accessRoles: [{ role: "ADMIN_BOOKINGS" }],
      },
    } as any);

    const res = await POST(
      makeCancelRequest(
        JSON.stringify({ refundMethod: "card", notifyMember: true })
      ),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(200);
    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "officer-1",
      "USER",
      "127.0.0.1",
      "card",
      { hasBookingsEditAccess: true, notifyMember: true }
    );
  });

  it("rejects a non-boolean notifyMember with 400", async () => {
    const res = await POST(
      makeCancelRequest(
        JSON.stringify({ refundMethod: "card", notifyMember: "yes" })
      ),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(400);
    expect(cancelBooking).not.toHaveBeenCalled();
  });
});
