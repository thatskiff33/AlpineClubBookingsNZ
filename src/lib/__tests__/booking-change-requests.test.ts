import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingChangeRequestFindFirst: vi.fn(),
  bookingChangeRequestCreate: vi.fn(),
  bookingChangeRequestFindMany: vi.fn(),
  bookingChangeRequestCount: vi.fn(),
  bookingChangeRequestFindUnique: vi.fn(),
  bookingChangeRequestUpdateMany: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  sendAdminBookingChangeRequestAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args),
    },
    bookingChangeRequest: {
      findFirst: (...args: unknown[]) => mocks.bookingChangeRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.bookingChangeRequestCreate(...args),
      findMany: (...args: unknown[]) => mocks.bookingChangeRequestFindMany(...args),
      count: (...args: unknown[]) => mocks.bookingChangeRequestCount(...args),
      findUnique: (...args: unknown[]) => mocks.bookingChangeRequestFindUnique(...args),
      updateMany: (...args: unknown[]) => mocks.bookingChangeRequestUpdateMany(...args),
    },
    bookingModification: {
      findUnique: (...args: unknown[]) => mocks.bookingModificationFindUnique(...args),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  getClientIp: (...args: unknown[]) => mocks.getClientIp(...args),
  rateLimiters: {
    bookingChangeRequest: {
      id: "booking-change-request",
      limit: 5,
      windowSeconds: 24 * 60 * 60,
    },
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mocks.logAudit(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...args: unknown[]) =>
    mocks.sendAdminBookingChangeRequestAlert(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  GET as getMemberBookingChangeRequests,
  POST as postBookingChangeRequest,
} from "@/app/api/bookings/[id]/change-requests/route";
import { GET as getAdminBookingChangeRequests } from "@/app/api/admin/booking-change-requests/route";
import { PATCH as patchAdminBookingChangeRequest } from "@/app/api/admin/booking-change-requests/[id]/route";

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "COMPLETED",
    checkIn: new Date("2026-05-23T00:00:00.000Z"),
    checkOut: new Date("2026-05-27T00:00:00.000Z"),
    guests: [
      {
        id: "guest-1",
        firstName: "Alex",
        lastName: "Example",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: new Date("2026-05-23T00:00:00.000Z"),
        stayEnd: new Date("2026-05-27T00:00:00.000Z"),
      },
    ],
    member: {
      id: "member-1",
      firstName: "Alex",
      lastName: "Example",
      email: "alex@example.com",
    },
    payment: {
      id: "payment-1",
      amountCents: 12000,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_123",
      xeroInvoiceId: "xero-inv-1",
      xeroInvoiceNumber: "INV-001",
    },
    ...overrides,
  };
}

describe("booking change requests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T00:00:00.000Z"));
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN" } },
    });
    mocks.checkRateLimit.mockReturnValue({
      success: true,
      limit: 5,
      remaining: 4,
      resetAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    mocks.getClientIp.mockReturnValue("127.0.0.1");
    mocks.bookingChangeRequestFindFirst.mockResolvedValue(null);
    mocks.bookingChangeRequestCreate.mockResolvedValue({
      id: "request-1",
      bookingId: "booking-1",
      requestedByMemberId: "member-1",
      status: "REQUESTED",
      requestedChanges: {},
      reason: "Weather closed the road.",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mocks.sendAdminBookingChangeRequestAlert.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an admin-reviewed request for a locked in-progress checkout change", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({
          checkOut: "2026-05-24",
          reason: "Weather closed the road.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(201);
    expect(mocks.bookingChangeRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bookingId: "booking-1",
        requestedByMemberId: "member-1",
        reason: "Weather closed the road.",
        requestedChanges: expect.objectContaining({
          requested: expect.objectContaining({
            checkOut: "2026-05-24",
            summary: "check-out to 2026-05-24",
          }),
          lockedPeriod: expect.objectContaining({
            today: "2026-05-24",
            editableFrom: "2026-05-25",
            touchesLockedPeriod: true,
          }),
          payment: expect.objectContaining({
            xeroInvoiceId: "xero-inv-1",
            amountCents: 12000,
          }),
        }),
      }),
    });
    expect(mocks.sendAdminBookingChangeRequestAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        requestId: "request-1",
        requestedSummary: "check-out to 2026-05-24",
      })
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-change-request.create",
        entityId: "request-1",
        subjectMemberId: "member-1",
        ipAddress: "127.0.0.1",
      })
    );
  });

  it("rejects request submissions for changes that remain self-service eligible", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkOut: "2026-05-26",
          reason: "Leaving one day early.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("rejects booking change requests when the booking has no editable future nights", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({
        checkIn: new Date("2026-05-20T00:00:00.000Z"),
        checkOut: new Date("2026-05-22T00:00:00.000Z"),
      })
    );

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestedEffectiveDate: "2026-05-24",
          reason: "Late correction.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("rejects removal requests for guests outside the booking", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          removeGuestIds: ["guest-missing"],
          requestedEffectiveDate: "2026-05-24",
          reason: "Wrong guest.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("rate limits repeated booking change request submissions by member", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkRateLimit.mockReturnValue({
      success: false,
      limit: 5,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          checkOut: "2026-05-24",
          reason: "Weather closed the road.",
        }),
      }
    );

    const response = await postBookingChangeRequest(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });

    expect(response.status).toBe(429);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "booking-change-request" }),
      "member-1"
    );
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("lists pending requests for admins", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.bookingChangeRequestFindMany.mockResolvedValue([{ id: "request-1" }]);
    mocks.bookingChangeRequestCount.mockResolvedValue(1);

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests?status=REQUESTED"
    );
    const response = await getAdminBookingChangeRequests(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(mocks.bookingChangeRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "REQUESTED" },
        take: 25,
      })
    );
  });

  it("marks a requested change approved with audit context", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.bookingChangeRequestFindUnique
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REQUESTED",
        booking: { id: "booking-1", memberId: "member-1" },
      })
      .mockResolvedValueOnce({
        id: "request-1",
        status: "APPROVED",
        booking: { id: "booking-1", memberId: "member-1" },
      });
    mocks.bookingChangeRequestUpdateMany.mockResolvedValue({ count: 1 });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({
          status: "APPROVED",
          adminNotes: "Handled manually through the booking edit flow.",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.bookingChangeRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "request-1", status: "REQUESTED" },
        data: expect.objectContaining({
          status: "APPROVED",
          adminNotes: "Handled manually through the booking edit flow.",
          reviewedByMemberId: "admin-1",
          linkedModificationId: null,
        }),
      })
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-change-request.approve",
        subjectMemberId: "member-1",
      })
    );
  });

  it("approves and links the executed booking modification when its id is provided", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.bookingChangeRequestFindUnique
      .mockResolvedValueOnce({
        id: "request-1",
        status: "REQUESTED",
        booking: { id: "booking-1", memberId: "member-1" },
      })
      .mockResolvedValueOnce({
        id: "request-1",
        status: "APPROVED",
        linkedModificationId: "mod-7",
        booking: { id: "booking-1", memberId: "member-1" },
      });
    mocks.bookingChangeRequestUpdateMany.mockResolvedValue({ count: 1 });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      id: "mod-7",
      bookingId: "booking-1",
    });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
          adminNotes: "Edit applied via /modify",
          linkedModificationId: "mod-7",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.bookingChangeRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPROVED",
          linkedModificationId: "mod-7",
        }),
      })
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ linkedModificationId: "mod-7" }),
      })
    );
  });

  it("rejects approval when the linked booking modification does not belong to the booking", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.bookingChangeRequestFindUnique.mockResolvedValueOnce({
      id: "request-1",
      status: "REQUESTED",
      booking: { id: "booking-1", memberId: "member-1" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue({
      id: "mod-9",
      bookingId: "another-booking",
    });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
          adminNotes: "x",
          linkedModificationId: "mod-9",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects approval when the linked booking modification does not exist", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.bookingChangeRequestFindUnique.mockResolvedValueOnce({
      id: "request-1",
      status: "REQUESTED",
      booking: { id: "booking-1", memberId: "member-1" },
    });
    mocks.bookingModificationFindUnique.mockResolvedValue(null);

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "APPROVED",
          adminNotes: "x",
          linkedModificationId: "mod-missing",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects rejection that includes a linked modification id", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    const request = new NextRequest(
      "http://localhost/api/admin/booking-change-requests/request-1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "REJECTED",
          adminNotes: "x",
          linkedModificationId: "mod-7",
        }),
      }
    );

    const response = await patchAdminBookingChangeRequest(request, {
      params: Promise.resolve({ id: "request-1" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestUpdateMany).not.toHaveBeenCalled();
  });

  it("returns a member's booking change requests for their booking", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ memberId: "member-1" });
    mocks.bookingChangeRequestFindMany.mockResolvedValue([{ id: "request-1" }]);

    const request = new NextRequest(
      "http://localhost/api/bookings/booking-1/change-requests"
    );
    const response = await getMemberBookingChangeRequests(request, {
      params: Promise.resolve({ id: "booking-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([{ id: "request-1" }]);
    expect(mocks.bookingChangeRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: "booking-1" },
        take: 50,
      })
    );
  });
});
