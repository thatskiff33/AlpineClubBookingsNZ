import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookingStatus } from "@prisma/client";
import { NextRequest } from "next/server";
import { bookingStatusSwatchClass } from "@/lib/status-colors";

// --- P1.1: canModify logic tests ---

describe("P1.1: Admin canModify override", () => {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  function canModify(
    status: string,
    checkIn: Date,
    role: "ADMIN" | "MEMBER"
  ): boolean {
    const isFutureCheckIn = checkIn > new Date();
    const isAdmin = role === "ADMIN";
    return isAdmin
      ? !["CANCELLED", "COMPLETED"].includes(status) && isFutureCheckIn
      : ["CONFIRMED", "PAID", "PENDING"].includes(status) && isFutureCheckIn;
  }

  // Admin can modify these statuses with future check-in
  it.each(["CONFIRMED", "PAID", "PENDING", "DRAFT", "WAITLISTED", "WAITLIST_OFFERED", "BUMPED"])(
    "admin can modify %s booking with future check-in",
    (status) => {
      expect(canModify(status, futureDate, "ADMIN")).toBe(true);
    }
  );

  // Admin cannot modify CANCELLED or COMPLETED
  it.each(["CANCELLED", "COMPLETED"])(
    "admin cannot modify %s booking",
    (status) => {
      expect(canModify(status, futureDate, "ADMIN")).toBe(false);
    }
  );

  // Admin cannot modify past bookings
  it("admin cannot modify booking with past check-in", () => {
    expect(canModify("CONFIRMED", pastDate, "ADMIN")).toBe(false);
  });

  // Regular member follows original rules
  it.each(["CONFIRMED", "PAID", "PENDING"])(
    "member can modify %s booking with future check-in",
    (status) => {
      expect(canModify(status, futureDate, "MEMBER")).toBe(true);
    }
  );

  it.each(["DRAFT", "WAITLISTED", "WAITLIST_OFFERED", "BUMPED", "CANCELLED", "COMPLETED"])(
    "member cannot modify %s booking",
    (status) => {
      expect(canModify(status, futureDate, "MEMBER")).toBe(false);
    }
  );

  it("member cannot modify booking with past check-in", () => {
    expect(canModify("CONFIRMED", pastDate, "MEMBER")).toBe(false);
  });
});

// --- P1.4: Calendar status swatch tests ---

// The calendar's swatches come from the shared booking-status tones in
// `status-colors.ts` (ALP-572), so these run against that real source.
describe("P1.4: Admin calendar status colors include waitlist statuses", () => {
  it.each(Object.values(BookingStatus))("has a color for %s", (status) => {
    expect(bookingStatusSwatchClass(status)).toMatch(/^bg-/);
  });

  it("WAITLISTED and WAITLIST_OFFERED have different colors", () => {
    expect(bookingStatusSwatchClass("WAITLISTED")).not.toBe(
      bookingStatusSwatchClass("WAITLIST_OFFERED"),
    );
  });
});

// --- P1.5: Admin bookings API sort tests ---

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
      count: vi.fn().mockResolvedValue(1),
    },
    booking: { findMany: vi.fn() },
    member: { count: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  getMonthAvailability: vi.fn().mockResolvedValue(new Map()),
  getLodgeCapacity: vi.fn().mockResolvedValue(29),
  LODGE_CAPACITY: 29,
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as getAdminBookings } from "@/app/api/admin/bookings/route";

const mockedAuth = vi.mocked(auth);

describe("P1.5: Admin bookings API accepts every booking status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    vi.mocked(prisma.member.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([] as never);
  });

  it.each(Object.values(BookingStatus))("accepts %s status filter", async (status) => {
    const res = await getAdminBookings(new NextRequest(
      `http://localhost/api/admin/bookings?calendarMonth=2026-07&status=${status}`
    ));
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.booking.findMany).mock.calls[0]?.[0]?.where?.status).toBe(status);
  });
});
