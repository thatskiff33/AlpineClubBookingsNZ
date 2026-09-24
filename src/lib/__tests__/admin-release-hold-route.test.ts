import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdateMany: vi.fn(),
  bookingFindUnique: vi.fn(),
  cancelBooking: vi.fn(),
  getClientIp: vi.fn(() => "203.0.113.9"),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findUnique: mocks.requestFindUnique,
      updateMany: mocks.requestUpdateMany,
    },
    booking: {
      findUnique: mocks.bookingFindUnique,
    },
  },
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: mocks.cancelBooking,
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: mocks.getClientIp,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/booking-requests/[id]/release-hold/route";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function makeRequest() {
  return new NextRequest(
    "https://example.test/api/admin/booking-requests/req-1/release-hold",
    { method: "POST" }
  );
}

const params = Promise.resolve({ id: "req-1" });

const adminSession = {
  ok: true as const,
  session: { user: { id: "admin1", role: "ADMIN" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(adminSession);
});

describe("POST /api/admin/booking-requests/[id]/release-hold", () => {
  it("enforces requireAdmin", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(401);
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
    expect(mocks.requestFindUnique).not.toHaveBeenCalled();
  });

  it("returns 400 when the request has no held slots to release", async () => {
    mocks.requestFindUnique.mockResolvedValue({ id: "req-1", heldBookingId: null });

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(400);
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("returns 404 when the booking request does not exist", async () => {
    mocks.requestFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(404);
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("refuses (409) to release a hold that is no longer AWAITING_REVIEW (racing the accept)", async () => {
    mocks.requestFindUnique.mockResolvedValue({ id: "req-1", heldBookingId: "held-1" });
    mocks.bookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.PENDING, // already accepted → converted
    });

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(409);
    // Never cancel a just-accepted booking.
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("releases an AWAITING_REVIEW hold via the shared cancel path, which frees capacity and detaches the pointer", async () => {
    mocks.requestFindUnique.mockResolvedValue({ id: "req-1", heldBookingId: "held-1" });
    mocks.bookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    });
    mocks.cancelBooking.mockResolvedValue({ status: 200, data: { success: true } });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    // RR-1 (Option B): the quote link is intentionally NOT revoked; the response
    // surfaces the caveat so the admin re-sends a fresh quote after re-mapping.
    expect(body).toMatchObject({ quoteLinkStillActive: true });
    expect(body.caveat).toMatch(/quote link/i);
    // Reuses the shared cancel path (which detaches heldBookingId + frees beds)
    // with the admin identity and client IP — no duplicated cancel logic — and
    // RR-2 (Option A): suppresses the requester's cancellation email.
    expect(mocks.cancelBooking).toHaveBeenCalledWith(
      "held-1",
      "admin1",
      "ADMIN",
      "203.0.113.9",
      CLUB_FORMAT_TEST,
      "card",
      // #1406: opt-in guard so the shared cancel path refuses (409, no side
      // effect) if a concurrent quote-accept flipped the hold to PENDING.
      { suppressCustomerNotification: true, requireRequestHold: true }
    );
  });

  it("treats a stale pointer (held booking already gone) as already released and detaches it", async () => {
    mocks.requestFindUnique.mockResolvedValue({ id: "req-1", heldBookingId: "held-1" });
    mocks.bookingFindUnique.mockResolvedValue(null);
    mocks.requestUpdateMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, alreadyReleased: true });
    expect(mocks.requestUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", heldBookingId: "held-1" },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("surfaces a 409 from the shared cancel path (concurrent accept/cancel won the race)", async () => {
    mocks.requestFindUnique.mockResolvedValue({ id: "req-1", heldBookingId: "held-1" });
    mocks.bookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    });
    mocks.cancelBooking.mockResolvedValue({ status: 409, error: "Already cancelling" });

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(409);
  });
});
