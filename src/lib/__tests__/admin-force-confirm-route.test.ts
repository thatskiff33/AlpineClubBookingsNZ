import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    payment: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    requireAdmin: vi.fn(),
    checkCapacityForGuestRanges: vi.fn(),
    requiresAdultSupervisionReview: vi.fn(),
    reconcileBedAllocationsForBooking: vi.fn(),
    sendBookingConfirmedEmail: vi.fn(),
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
}));

vi.mock("@/lib/booking-review", () => ({
  requiresAdultSupervisionReview: mocks.requiresAdultSupervisionReview,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcileBedAllocationsForBooking,
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendBookingConfirmedEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
  },
}));

import { POST } from "@/app/api/admin/bookings/[id]/force-confirm/route";

function forceConfirmRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/bookings/booking-1/force-confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-1",
      "x-forwarded-for": "203.0.113.5",
      "user-agent": "vitest",
    },
    body: JSON.stringify(body),
  });
}

function routeParams() {
  return {
    params: Promise.resolve({ id: "booking-1" }),
  };
}

function waitlistBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "WAITLIST_OFFERED",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    finalPriceCents: 12000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    requiresAdminReview: false,
    adminReviewStatus: "APPROVED",
    adminReviewReason: null,
    waitlistPosition: null,
    waitlistOfferedAt: new Date("2026-06-01T00:00:00.000Z"),
    waitlistOfferExpiresAt: new Date("2026-06-03T00:00:00.000Z"),
    guests: [
      {
        id: "guest-1",
        isMember: true,
        nights: [],
      },
    ],
    member: {
      id: "member-1",
      email: "member@example.com",
      firstName: "Alex",
    },
    promoRedemption: null,
  };
}

function overbookedCapacity() {
  return {
    available: false,
    minAvailable: -1,
    nightDetails: [
      {
        date: new Date("2026-07-01T00:00:00.000Z"),
        occupiedBeds: 30,
        availableBeds: -1,
      },
      {
        date: new Date("2026-07-02T00:00:00.000Z"),
        occupiedBeds: 29,
        availableBeds: 0,
      },
    ],
  };
}

describe("POST /api/admin/bookings/[id]/force-confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN" } },
    });
    mocks.transaction.mockImplementation(async (fn) => fn(mocks.tx));
    mocks.tx.booking.findUnique.mockResolvedValue(waitlistBooking());
    mocks.tx.booking.update.mockResolvedValue({});
    mocks.tx.auditLog.create.mockResolvedValue({});
    mocks.checkCapacityForGuestRanges.mockResolvedValue(overbookedCapacity());
    mocks.requiresAdultSupervisionReview.mockReturnValue(false);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  });

  it("reports overbook dates without committing when override is not explicit", async () => {
    const response = await POST(forceConfirmRequest({}), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-07-01"],
    });
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes critical overbook audit evidence in the force-confirm transaction", async () => {
    const response = await POST(
      forceConfirmRequest({ allowOverbook: true }),
      routeParams(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      auditAction: "waitlist.force_confirmed_overbook",
      overbooked: true,
      overbookDates: ["2026-07-01"],
      status: "PAYMENT_PENDING",
    });
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          status: "PAYMENT_PENDING",
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
        }),
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "waitlist.force_confirmed_overbook",
        actorMemberId: "admin-1",
        memberId: "admin-1",
        subjectMemberId: "member-1",
        targetId: "booking-1",
        entityType: "Booking",
        entityId: "booking-1",
        category: "booking",
        severity: "critical",
        outcome: "success",
        retentionClass: "critical",
        incidentPreserved: true,
        requestId: "request-1",
        ipAddress: "203.0.113.5",
        userAgent: "vitest",
        metadata: expect.objectContaining({
          previousStatus: "WAITLIST_OFFERED",
          nextStatus: "PAYMENT_PENDING",
          allowOverbook: true,
          overbooked: true,
          overbookDates: ["2026-07-01"],
          overbookedNights: [{ date: "2026-07-01", availableBeds: -1 }],
          guestCount: 1,
          finalPriceCents: 12000,
          parkedForAdminReview: false,
        }),
      }),
    });
  });
});
