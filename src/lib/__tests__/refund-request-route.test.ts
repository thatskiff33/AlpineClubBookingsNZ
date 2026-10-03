import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  bookingFindUnique: vi.fn(),
  refundRequestFindFirst: vi.fn(),
  refundRequestCreate: vi.fn(),
  manualRefundTaskAggregate: vi.fn(),
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
    manualRefundTask: {
      aggregate: (...args: unknown[]) => mocks.manualRefundTaskAggregate(...args),
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
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });
    mocks.refundRequestFindFirst.mockResolvedValue(null);
    mocks.refundRequestCreate.mockResolvedValue({ id: "rr-1" });
    mocks.sendAdminRefundRequestAlert.mockResolvedValue(undefined);
    mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: null } });
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

  // #3827 (`INV-PAY-114`): paid 200, an edit lowered it to 150 (a 50 refund
  // task still OPEN), the cancel handed back 75. The gross remainder is 125;
  // 50 of it is already promised back, so the most to appeal for is 75.
  function cancelledAfterEdit() {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "CANCELLED",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      payment: {
        id: "payment-1",
        amountCents: 20000,
        refundedAmountCents: 7500,
        status: "PARTIALLY_REFUNDED",
      },
      member: { firstName: "Alex", lastName: "Example" },
    });
    mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: 5000 } });
  }

  function appealFor(requestedAmountCents: number) {
    return POST(
      new NextRequest("http://localhost/api/bookings/booking-1/refund-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "The lodge closed early due to weather.",
          requestedAmountCents,
        }),
      }),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
  }

  it("refuses an appeal for cash an open edit refund already promises back (#3827)", async () => {
    cancelledAfterEdit();

    const response = await appealFor(12500);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Requested amount exceeds maximum refundable amount of $75.00",
    });
    expect(mocks.manualRefundTaskAggregate).toHaveBeenCalledWith({
      where: {
        paymentId: "payment-1",
        status: "OPEN",
        kind: "CANCELLED_BOOKING_HAND_BACK",
        OR: [
          { occurrenceKey: { startsWith: "edit-refund-hand-back:" } },
          { occurrenceKey: { startsWith: "refund-request-hand-back:" } },
        ],
      },
      _sum: { amountCents: true },
    });
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
  });

  it("allows an appeal up to the cash net of open edit refunds (#3827)", async () => {
    cancelledAfterEdit();

    const response = await appealFor(7500);

    expect(response.status).toBe(201);
    expect(mocks.refundRequestCreate).toHaveBeenCalledTimes(1);
  });

  it("says plainly when everything left is already being refunded by bank transfer (#3827)", async () => {
    cancelledAfterEdit();
    mocks.manualRefundTaskAggregate.mockResolvedValue({ _sum: { amountCents: 12500 } });

    const response = await appealFor(100);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Everything still refundable on this booking is already being refunded to you by bank transfer, so there is nothing further to appeal for.",
    });
    expect(mocks.refundRequestCreate).not.toHaveBeenCalled();
  });
});
