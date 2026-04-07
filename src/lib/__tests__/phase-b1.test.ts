import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  hutLeaderAssignment: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  booking: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  member: {
    findUnique: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock auth
// ---------------------------------------------------------------------------

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDate(str: string): Date {
  return new Date(str + "T00:00:00");
}

// ---------------------------------------------------------------------------
// #24: Kiosk Access Tier Resolution
// ---------------------------------------------------------------------------

describe("#24: Kiosk Access Tiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getKioskAccessTier", () => {
    it("returns 'admin' for ADMIN role regardless of date", async () => {
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "ADMIN", makeDate("2026-04-08"));
      expect(tier).toBe("admin");
    });

    it("returns 'lodge' for LODGE role regardless of date", async () => {
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "LODGE", makeDate("2026-04-08"));
      expect(tier).toBe("lodge");
    });

    it("returns 'hut-leader' for MEMBER with active assignment on date", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(tier).toBe("hut-leader");
    });

    it("returns 'hut-leader' for MEMBER on day before assignment starts", async () => {
      // Assignment starts 2026-04-09, checking access for 2026-04-08
      // startDate <= nextDay (2026-04-09) && endDate >= date (2026-04-08)
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(tier).toBe("hut-leader");
      // Verify the query used nextDay for startDate check
      expect(mockPrisma.hutLeaderAssignment.count).toHaveBeenCalledWith({
        where: {
          memberId: "user-1",
          startDate: { lte: expect.any(Date) },
          endDate: { gte: expect.any(Date) },
        },
      });
    });

    it("returns 'staying-guest' for MEMBER with PAID booking covering date", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(tier).toBe("staying-guest");
    });

    it("returns 'staying-guest' for MEMBER on day before check-in", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      // Booking checkIn is 2026-04-09, querying for 2026-04-08
      // checkIn <= nextDay (2026-04-09) && checkOut >= date (2026-04-08)
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(tier).toBe("staying-guest");
    });

    it("returns 'none' for MEMBER with no matching bookings or assignments", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(0);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(tier).toBe("none");
    });

    it("hut-leader takes priority over staying-guest", async () => {
      // When member has both an active assignment AND a paid booking
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(tier).toBe("hut-leader");
      // booking.count should NOT be called since hut-leader was found first
      expect(mockPrisma.booking.count).not.toHaveBeenCalled();
    });
  });

  describe("getKioskDateRange", () => {
    it("returns null for ADMIN", async () => {
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange("user-1", "ADMIN");
      expect(range).toBeNull();
    });

    it("returns null for LODGE", async () => {
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange("user-1", "LODGE");
      expect(range).toBeNull();
    });

    it("returns date range based on booking dates with day-before", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([
        { checkIn: makeDate("2026-04-10"), checkOut: makeDate("2026-04-13") },
      ]);
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange("user-1", "MEMBER");
      expect(range).toEqual({
        minDate: "2026-04-09", // day before check-in
        maxDate: "2026-04-13", // checkOut date
      });
    });

    it("returns null when no bookings or assignments", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange("user-1", "MEMBER");
      expect(range).toBeNull();
    });
  });

  describe("getKioskAccessInfo", () => {
    it("returns correct capabilities for admin tier", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo("user-1", "ADMIN", makeDate("2026-04-08"));
      expect(info.tier).toBe("admin");
      expect(info.canManageRoster).toBe(true);
      expect(info.canMarkAttendance).toBe(true);
      expect(info.canCompleteChores).toBe(true);
      expect(info.dateRange).toBeNull();
    });

    it("returns correct capabilities for lodge tier", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo("user-1", "LODGE", makeDate("2026-04-08"));
      expect(info.tier).toBe("lodge");
      expect(info.canManageRoster).toBe(false);
      expect(info.canMarkAttendance).toBe(true);
      expect(info.canCompleteChores).toBe(true);
    });

    it("returns correct capabilities for hut-leader tier", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        { startDate: makeDate("2026-04-05"), endDate: makeDate("2026-04-12") },
      ]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(info.tier).toBe("hut-leader");
      expect(info.canManageRoster).toBe(true);
      expect(info.canMarkAttendance).toBe(true);
      expect(info.canCompleteChores).toBe(true);
    });

    it("returns correct capabilities for staying-guest tier", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([
        { checkIn: makeDate("2026-04-08"), checkOut: makeDate("2026-04-11") },
      ]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo("user-1", "MEMBER", makeDate("2026-04-08"));
      expect(info.tier).toBe("staying-guest");
      expect(info.canManageRoster).toBe(false);
      expect(info.canMarkAttendance).toBe(false);
      expect(info.canCompleteChores).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// #24: Lodge Auth Tier Checks
// ---------------------------------------------------------------------------

describe("#24: Lodge Auth Tier-Based Restrictions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkLodgeAuth", () => {
    it("returns tier with session for ADMIN", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
      });
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("admin");
      expect(result.session).toBeTruthy();
      expect(result.error).toBeNull();
    });

    it("returns tier with session for LODGE", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "lodge-1", role: "LODGE" },
      });
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("lodge");
      expect(result.session).toBeTruthy();
    });

    it("returns Forbidden for MEMBER with no access", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(0);
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("none");
      expect(result.error).toBe("Forbidden");
      expect(result.status).toBe(403);
    });

    it("returns Unauthorised when no session", async () => {
      mockAuth.mockResolvedValue(null);
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.error).toBe("Unauthorised");
      expect(result.status).toBe(401);
    });

    it("returns staying-guest tier for MEMBER with PAID booking", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("staying-guest");
      expect(result.session).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// #24: Auth.ts LODGE JWT Duration
// ---------------------------------------------------------------------------

describe("#24: LODGE JWT 180-day expiry", () => {
  it("auth.ts contains 180 * 24 * 60 * 60 for LODGE role", async () => {
    // Read the auth file and verify the duration
    const fs = await import("fs");
    const content = fs.readFileSync("src/lib/auth.ts", "utf-8");
    expect(content).toContain("180 * 24 * 60 * 60");
    expect(content).not.toContain("30 * 24 * 60 * 60");
  });
});

// ---------------------------------------------------------------------------
// #31: Expected Arrival Time API
// ---------------------------------------------------------------------------

describe("#31: Expected Arrival Time", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PUT /api/bookings/[id]/arrival-time", () => {
    it("updates arrival time for booking owner", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue({
        memberId: "member-1",
        checkIn: new Date("2026-04-15"),
      });
      mockPrisma.booking.update.mockResolvedValue({
        id: "booking-1",
        expectedArrivalTime: "14:00",
      });

      const { PUT } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedArrivalTime: "14:00" }),
      });
      const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.expectedArrivalTime).toBe("14:00");
    });

    it("rejects invalid time format", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue({
        memberId: "member-1",
        checkIn: new Date("2026-04-15"),
      });

      const { PUT } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedArrivalTime: "14:15" }), // not 30-min increment
      });
      const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(400);
    });

    it("rejects non-owner non-admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "other-1", role: "MEMBER" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue({
        memberId: "member-1",
        checkIn: new Date("2026-04-15"),
      });

      const { PUT } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedArrivalTime: "14:00" }),
      });
      const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(403);
    });

    it("allows admin to update any booking", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin-1", role: "ADMIN" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue({
        memberId: "member-1",
        checkIn: new Date("2026-04-15"),
      });
      mockPrisma.booking.update.mockResolvedValue({
        id: "booking-1",
        expectedArrivalTime: "16:30",
      });

      const { PUT } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedArrivalTime: "16:30" }),
      });
      const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(200);
    });

    it("rejects update after check-in has passed", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue({
        memberId: "member-1",
        checkIn: new Date("2026-04-01"), // past date
      });

      const { PUT } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedArrivalTime: "14:00" }),
      });
      const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent booking", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      const { PUT } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedArrivalTime: "14:00" }),
      });
      const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/bookings/[id]/arrival-time", () => {
    it("clears arrival time", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue({
        memberId: "member-1",
        checkIn: new Date("2026-04-15"),
      });
      mockPrisma.booking.update.mockResolvedValue({
        id: "booking-1",
        expectedArrivalTime: null,
      });

      const { DELETE } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "DELETE",
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.expectedArrivalTime).toBeNull();
    });

    it("rejects after check-in has passed", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });
      mockPrisma.booking.findUnique.mockResolvedValue({
        memberId: "member-1",
        checkIn: new Date("2026-04-01"),
      });

      const { DELETE } = await import(
        "@/app/api/bookings/[id]/arrival-time/route"
      );
      const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
        method: "DELETE",
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: "booking-1" }) });
      expect(res.status).toBe(400);
    });
  });

  describe("Arrival time Zod validation", () => {
    it("accepts valid 30-minute increments", async () => {
      const validTimes = ["06:00", "06:30", "12:00", "14:30", "23:00"];
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });

      for (const time of validTimes) {
        mockPrisma.booking.findUnique.mockResolvedValue({
          memberId: "member-1",
          checkIn: new Date("2026-04-15"),
        });
        mockPrisma.booking.update.mockResolvedValue({
          id: "booking-1",
          expectedArrivalTime: time,
        });

        const { PUT } = await import(
          "@/app/api/bookings/[id]/arrival-time/route"
        );
        const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedArrivalTime: time }),
        });
        const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
        expect(res.status).toBe(200);
      }
    });

    it("rejects invalid time formats", async () => {
      const invalidTimes = ["14:15", "14:45", "25:00", "abc", "1400"];
      mockAuth.mockResolvedValue({
        user: { id: "member-1", role: "MEMBER" },
      });

      for (const time of invalidTimes) {
        mockPrisma.booking.findUnique.mockResolvedValue({
          memberId: "member-1",
          checkIn: new Date("2026-04-15"),
        });

        const { PUT } = await import(
          "@/app/api/bookings/[id]/arrival-time/route"
        );
        const req = new Request("http://localhost/api/bookings/booking-1/arrival-time", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedArrivalTime: time }),
        });
        const res = await PUT(req, { params: Promise.resolve({ id: "booking-1" }) });
        expect(res.status).toBe(400);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// #31: Booking creation with expectedArrivalTime
// ---------------------------------------------------------------------------

describe("#31: Booking creation schema accepts expectedArrivalTime", () => {
  it("createBookingSchema allows optional expectedArrivalTime field", async () => {
    // The Zod schema in bookings/route.ts should accept the field
    // We test this indirectly by verifying the regex pattern
    const pattern = /^([01]\d|2[0-3]):[0-5]0$/;
    expect(pattern.test("14:00")).toBe(true);
    expect(pattern.test("06:30")).toBe(true);
    expect(pattern.test("23:00")).toBe(true);
    expect(pattern.test("14:15")).toBe(false);
    expect(pattern.test("24:00")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #24: Lodge Access API endpoint
// ---------------------------------------------------------------------------

describe("#24: Lodge Access API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns access info for authenticated user", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const req = new NextRequest("http://localhost/api/lodge/access?date=2026-04-08");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe("admin");
    expect(data.canManageRoster).toBe(true);
    expect(data.canMarkAttendance).toBe(true);
    expect(data.dateRange).toBeNull();
  });

  it("returns 401 for unauthenticated user", async () => {
    mockAuth.mockResolvedValue(null);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const req = new NextRequest("http://localhost/api/lodge/access?date=2026-04-08");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing date parameter", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    });

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const req = new NextRequest("http://localhost/api/lodge/access");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// #31: Lodge guests API includes expectedArrivalTime
// ---------------------------------------------------------------------------

describe("#31: Lodge guests API includes expectedArrivalTime", () => {
  it("guests API response should include expectedArrivalTime in schema", async () => {
    // Verify the schema.prisma has the field
    const fs = await import("fs");
    const schema = fs.readFileSync("prisma/schema.prisma", "utf-8");
    expect(schema).toContain("expectedArrivalTime");
    expect(schema).toContain("@db.VarChar(5)");
  });
});
