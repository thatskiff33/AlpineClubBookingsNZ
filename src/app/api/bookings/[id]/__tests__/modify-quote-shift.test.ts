import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingRequestFindFirst: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  findConflicts: vi.fn(),
  getDefaultLodgeId: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique },
    // isQuotePricedBooking's negotiated-price gate (#1032): null = not quoted.
    bookingRequest: { findFirst: h.bookingRequestFindFirst },
  },
}));
vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");
  return { ...actual, checkCapacityForGuestRanges: h.checkCapacityForGuestRanges };
});
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: h.findConflicts,
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({
    code: "BOOKING_MEMBER_NIGHT_CONFLICT",
    conflicts,
  }),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
  lodgeNullTolerantScope: () => ({}),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
// #2266: the quote now returns the booking owner's live credit balance.
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));

import { POST } from "@/app/api/bookings/[id]/modify-quote/route";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

function booking() {
  return {
    id: "b1",
    status: "PAID",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-09-10"),
    checkOut: D("2026-09-13"),
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 30000,
    payment: null,
    promoRedemption: null,
    guests: [
      {
        id: "g1",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: D("2026-09-10"),
        stayEnd: D("2026-09-13"),
        priceCents: 30000,
        nights: [
          { stayDate: D("2026-09-10"), priceCents: 10000 },
          { stayDate: D("2026-09-11"), priceCents: 10000 },
          { stayDate: D("2026-09-12"), priceCents: 10000 },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "admin1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("ADMIN");
  h.bookingFindUnique.mockResolvedValue(booking());
  h.bookingRequestFindFirst.mockResolvedValue(null);
  h.getDefaultLodgeId.mockResolvedValue("lodge-1");
  h.findConflicts.mockResolvedValue([]);
  h.checkCapacityForGuestRanges.mockResolvedValue({
    available: true,
    minAvailable: 5,
    nightDetails: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/bookings/[id]/modify-quote shift preview (issue #1668)", () => {
  it("returns an all-zero-money preview echoing the stored booking", async () => {
    const res = await POST(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.priceDiffCents).toBe(0);
    expect(body.changeFeeCents).toBe(0);
    expect(body.netChargeCents).toBe(0);
    expect(body.newFinalPriceCents).toBe(30000);
    expect(body.newTotalPriceCents).toBe(30000);
    expect(body.capacityAvailable).toBe(true);
    expect(body.itemizedChanges).toEqual([
      { label: "Dates shifted by 2 night(s) — price unchanged", amountCents: 0 },
    ]);
  });

  it("flags an over-capacity shift as a confirm-required warning, not a hard block", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: D("2026-09-14"), occupiedBeds: 30, availableBeds: -1 },
      ],
    });

    const res = await POST(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capacityAvailable).toBe(false);
    expect(body.overCapacityConfirmRequired).toBe(true);
    expect(body.nightDetails).toEqual([{ date: "2026-09-14", availableBeds: -1 }]);
    expect(body.priceDiffCents).toBe(0);
  });

  it("surfaces a member-night conflict as a 409 (preview mirrors apply)", async () => {
    h.findConflicts.mockResolvedValue([{ memberId: "m1", conflictingNights: ["2026-09-14"] }]);

    const res = await POST(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("BOOKING_MEMBER_NIGHT_CONFLICT");
  });

  it("rejects a night-count change in shift mode (400)", async () => {
    const res = await POST(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-09-12",
        checkOut: "2026-09-14",
      }),
      { params },
    );

    expect(res.status).toBe(400);
  });

  it("refuses a quote-priced booking's shift preview (mirrors the apply block, #1032)", async () => {
    h.bookingRequestFindFirst.mockResolvedValue({ id: "req1" });

    const res = await POST(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/negotiated booking-request price/);
  });
});
