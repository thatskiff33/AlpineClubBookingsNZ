import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  bookingFindUnique: vi.fn(),
  refundRequestFindFirst: vi.fn(),
  refundRequestCreate: vi.fn(),
  logAudit: vi.fn(),
  sendAdminRefundRequestAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    },
    refundRequest: {
      findFirst: (...args: unknown[]) => mocks.refundRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.refundRequestCreate(...args),
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mocks.logAudit(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminRefundRequestAlert: (...args: unknown[]) =>
    mocks.sendAdminRefundRequestAlert(...args),
}));

import { POST } from "@/app/api/bookings/[id]/refund-request/route";

describe("POST /api/bookings/[id]/refund-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    });
    mocks.refundRequestFindFirst.mockResolvedValue(null);
    mocks.refundRequestCreate.mockResolvedValue({ id: "rr-1" });
    mocks.sendAdminRefundRequestAlert.mockResolvedValue(undefined);
  });

  it("rejects appeals when no successful payment was captured", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CANCELLED",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      payment: {
        amountCents: 9000,
        refundedAmountCents: 0,
        status: "PENDING",
      },
      member: {
        firstName: "Alex",
        lastName: "Example",
      },
    });

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/refund-request",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "No beds were available when we arrived.",
          requestedAmountCents: 9000,
        }),
      }
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "No successful payment was captured for this booking",
    });
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
  });

  it("allows an appeal up to the remaining refundable amount", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CANCELLED",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      payment: {
        amountCents: 9000,
        refundedAmountCents: 2000,
        status: "PARTIALLY_REFUNDED",
      },
      member: {
        firstName: "Alex",
        lastName: "Example",
      },
    });

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/refund-request",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "The lodge closed early due to weather.",
          requestedAmountCents: 5000,
        }),
      }
    );

    const response = await POST(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.refundRequestCreate).toHaveBeenCalledWith({
      data: {
        bookingId: "booking-1",
        memberId: "member-1",
        reason: "The lodge closed early due to weather.",
        requestedAmountCents: 5000,
      },
    });
  });
});
