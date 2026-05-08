import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn(),
}));

const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
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
      user: { id: "member-1", role: "MEMBER" },
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

  it("passes the validated refund method into cancelBooking", async () => {
    const res = await POST(
      makeCancelRequest(JSON.stringify({ refundMethod: "credit" })),
      { params: Promise.resolve({ id: "booking-1" }) }
    );

    expect(res.status).toBe(200);
    expect(cancelBooking).toHaveBeenCalledWith(
      "booking-1",
      "member-1",
      "MEMBER",
      "127.0.0.1",
      "credit"
    );
  });
});
