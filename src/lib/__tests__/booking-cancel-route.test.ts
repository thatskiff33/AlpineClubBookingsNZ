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
  default: { error: vi.fn(), warn: vi.fn() },
}));

import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { cancelBooking } from "@/lib/booking-cancel";
import { POST } from "@/app/api/bookings/[id]/cancel/route";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  TRANSACTION_CONTENDED_CODE,
  TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
} from "@/lib/transaction-contended-response";

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
      CLUB_FORMAT_TEST,
      "credit",
      { hasBookingsEditAccess: false, enforceStartedStayBlock: true, enforceMemberCancelDoor: true }
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
      CLUB_FORMAT_TEST,
      "card",
      { hasBookingsEditAccess: true, enforceStartedStayBlock: true, enforceMemberCancelDoor: true }
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
      CLUB_FORMAT_TEST,
      "card",
      { hasBookingsEditAccess: false, enforceStartedStayBlock: true, enforceMemberCancelDoor: true }
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
      CLUB_FORMAT_TEST,
      "card",
      { hasBookingsEditAccess: true, enforceStartedStayBlock: true, enforceMemberCancelDoor: true }
    );
  });

  // INV-LOCK-006: a cancel commits in steps, so a contended lock(1) budget asks
  // the member to check the status before retrying.
  it.each(["P2028", "P2034"] as const)(
    "maps %s transaction contention to a retryable 503 with the status-check wording",
    async (code) => {
      mockedCancelBooking.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "test" }),
      );

      const res = await POST(
        makeCancelRequest(JSON.stringify({ refundMethod: "card" })),
        { params: Promise.resolve({ id: "booking-1" }) },
      );

      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("2");
      await expect(res.json()).resolves.toEqual({
        error: TRANSACTION_CONTENDED_STATUS_CHECK_MESSAGE,
        code: TRANSACTION_CONTENDED_CODE,
      });
    },
  );

  it("keeps the generic 500 for an unrelated error", async () => {
    mockedCancelBooking.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "test" }),
    );

    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "card" })),
      { params: Promise.resolve({ id: "booking-1" }) },
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
