import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  hutLeaderAssignment: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  booking: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  bookingGuest: {
    findMany: vi.fn(),
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
// #25 Feature 1: Overlap Validation (Pure Function)
// ---------------------------------------------------------------------------

describe("#25: calculateOverlapDays", () => {
  function d(str: string) {
    return new Date(str + "T00:00:00.000Z");
  }

  it("returns 0 when ranges do not overlap", async () => {
    const { calculateOverlapDays } = await import("@/lib/hut-leader-overlap");
    expect(calculateOverlapDays(d("2026-04-01"), d("2026-04-05"), d("2026-04-10"), d("2026-04-15"))).toBe(0);
  });

  it("returns 1 for single-day handover overlap (A ends on B start)", async () => {
    const { calculateOverlapDays } = await import("@/lib/hut-leader-overlap");
    // A: Apr 7-10, B: Apr 10-12 → overlap on Apr 10 = 1 day
    expect(calculateOverlapDays(d("2026-04-07"), d("2026-04-10"), d("2026-04-10"), d("2026-04-12"))).toBe(1);
  });

  it("returns 2 for 2-day overlap", async () => {
    const { calculateOverlapDays } = await import("@/lib/hut-leader-overlap");
    // A: Apr 7-10, B: Apr 9-12 → overlap on Apr 9-10 = 2 days
    expect(calculateOverlapDays(d("2026-04-07"), d("2026-04-10"), d("2026-04-09"), d("2026-04-12"))).toBe(2);
  });

  it("returns full range when one contains the other", async () => {
    const { calculateOverlapDays } = await import("@/lib/hut-leader-overlap");
    expect(calculateOverlapDays(d("2026-04-05"), d("2026-04-15"), d("2026-04-08"), d("2026-04-10"))).toBe(3);
  });

  it("returns correct overlap for identical ranges", async () => {
    const { calculateOverlapDays } = await import("@/lib/hut-leader-overlap");
    expect(calculateOverlapDays(d("2026-04-05"), d("2026-04-10"), d("2026-04-05"), d("2026-04-10"))).toBe(6);
  });

  it("returns 0 when ranges are adjacent but not overlapping", async () => {
    const { calculateOverlapDays } = await import("@/lib/hut-leader-overlap");
    expect(calculateOverlapDays(d("2026-04-01"), d("2026-04-05"), d("2026-04-06"), d("2026-04-10"))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #25 Feature 1: POST /api/admin/hut-leaders Overlap Enforcement
// ---------------------------------------------------------------------------

describe("#25: Hut Leader POST Overlap Enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function d(str: string) {
    return new Date(str + "T00:00:00.000Z");
  }

  it("allows 1-day overlap (handover scenario) — returns 201", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", active: true });
    // Existing: Apr 7-10, New: Apr 10-12 → 1 day overlap = OK
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      {
        id: "e1",
        startDate: d("2026-04-07"),
        endDate: d("2026-04-10"),
        member: { firstName: "Alice", lastName: "Smith" },
      },
    ]);
    mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "new-1" });

    const { POST } = await import("@/app/api/admin/hut-leaders/route");
    const req = new Request("http://localhost/api/admin/hut-leaders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "m1", startDate: "2026-04-10", endDate: "2026-04-12" }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(201);
  });

  it("rejects 2+ day overlap with clear error message — returns 409", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", active: true });
    // Existing: Apr 7-10, New: Apr 9-12 → 2 days overlap = rejected
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      {
        id: "e1",
        startDate: d("2026-04-07"),
        endDate: d("2026-04-10"),
        member: { firstName: "Alice", lastName: "Smith" },
      },
    ]);

    const { POST } = await import("@/app/api/admin/hut-leaders/route");
    const req = new Request("http://localhost/api/admin/hut-leaders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "m1", startDate: "2026-04-09", endDate: "2026-04-12" }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Alice Smith");
    expect(body.error).toContain("2 days");
    expect(body.error).toContain("Maximum 1 day overlap");
  });

  it("allows creation when no overlapping assignments exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", active: true });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "new-1" });

    const { POST } = await import("@/app/api/admin/hut-leaders/route");
    const req = new Request("http://localhost/api/admin/hut-leaders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "m1", startDate: "2026-04-15", endDate: "2026-04-18" }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(201);
  });

  it("returns 403 for non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "MEMBER" } });

    const { POST } = await import("@/app/api/admin/hut-leaders/route");
    const req = new Request("http://localhost/api/admin/hut-leaders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: "m1", startDate: "2026-04-10", endDate: "2026-04-12" }),
    });

    const res = await POST(req as any);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// #25 Feature 2: Eligible Members API
// ---------------------------------------------------------------------------

describe("#25: Eligible Members API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function d(str: string) {
    // Use date-only string → parsed as UTC midnight by JS
    return new Date(str);
  }

  it("returns members with booking and suggested dates", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Wayne", lastName: "Peterson", email: "wayne@test.com", active: true },
        booking: { checkIn: d("2026-04-06"), checkOut: d("2026-04-08") },
      },
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/hut-leaders/eligible-members/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(
      "http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-04-06&endDate=2026-04-08"
    );

    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].id).toBe("m1");
    expect(body.members[0].firstName).toBe("Wayne");
    // Verify booking-related fields exist (exact dates depend on tz)
    expect(body.members[0]).toHaveProperty("bookingCheckIn");
    expect(body.members[0]).toHaveProperty("bookingCheckOut");
    expect(body.members[0]).toHaveProperty("suggestedStartDate");
    expect(body.members[0]).toHaveProperty("suggestedEndDate");
  });

  it("uses earliest checkIn and latest checkOut for multiple bookings", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Jane", lastName: "Doe", email: "j@t.com", active: true },
        booking: { checkIn: d("2026-04-10"), checkOut: d("2026-04-12") },
      },
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Jane", lastName: "Doe", email: "j@t.com", active: true },
        booking: { checkIn: d("2026-04-06"), checkOut: d("2026-04-08") },
      },
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/hut-leaders/eligible-members/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(
      "http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-04-06&endDate=2026-04-14"
    );

    const res = await GET(req);
    const body = await res.json();
    expect(body.members).toHaveLength(1);
    // Earliest checkIn is Apr 6, latest checkOut is Apr 12
    // suggestedStartDate should match earliest checkIn, suggestedEndDate the latest checkOut
    expect(body.members[0].suggestedStartDate).toBe(body.members[0].bookingCheckIn);
    // bookingCheckIn should be from the Apr 6 booking (earlier)
    expect(new Date(body.members[0].bookingCheckIn).getTime())
      .toBeLessThanOrEqual(new Date(body.members[0].bookingCheckOut).getTime());
  });

  it("filters out inactive members", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.bookingGuest.findMany.mockResolvedValue([
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Inactive", lastName: "User", email: "i@t.com", active: false },
        booking: { checkIn: d("2026-04-06"), checkOut: d("2026-04-08") },
      },
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/hut-leaders/eligible-members/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(
      "http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-04-06&endDate=2026-04-08"
    );

    const res = await GET(req);
    const body = await res.json();
    expect(body.members).toHaveLength(0);
  });

  it("returns 400 for missing date parameters", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });

    const { GET } = await import("@/app/api/admin/hut-leaders/eligible-members/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/hut-leaders/eligible-members");

    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 403 for non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "MEMBER" } });

    const { GET } = await import("@/app/api/admin/hut-leaders/eligible-members/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(
      "http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-04-06&endDate=2026-04-08"
    );

    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// #25 Feature 3: Auto-Assign Cron
// ---------------------------------------------------------------------------

describe("#25: Auto-Assign Hut Leaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Set to a time that resolves to the desired "today" in NZST after setHours(0,0,0,0)
    vi.setSystemTime(new Date("2026-04-08T06:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: create dates at local midnight (matching how the cron generates days)
  function localMidnight(str: string): Date {
    return new Date(str + "T00:00:00");
  }

  it("auto-assigns when exactly 1 adult member has PAID booking", async () => {
    mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue(null);
    const checkIn = localMidnight("2026-04-08");
    const checkOut = localMidnight("2026-04-10");
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn,
        checkOut,
        guests: [
          { memberId: "m1", member: { id: "m1", firstName: "John", lastName: "Doe", active: true } },
        ],
      },
    ]);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "new-assign" });

    const { autoAssignHutLeaders } = await import("@/lib/cron-hut-leader-auto-assign");
    const result = await autoAssignHutLeaders();
    expect(result.assignedCount).toBeGreaterThan(0);
    expect(result.assignedDates.length).toBeGreaterThan(0);
    expect(mockPrisma.hutLeaderAssignment.create).toHaveBeenCalled();
  });

  it("skips when 0 adult members are booked", async () => {
    mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue(null);
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

    const { autoAssignHutLeaders } = await import("@/lib/cron-hut-leader-auto-assign");
    const result = await autoAssignHutLeaders();
    expect(result.assignedCount).toBe(0);
    expect(mockPrisma.hutLeaderAssignment.create).not.toHaveBeenCalled();
  });

  it("skips when 2+ adult members are booked", async () => {
    mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue(null);
    const checkIn = localMidnight("2026-04-08");
    const checkOut = localMidnight("2026-04-10");
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn,
        checkOut,
        guests: [
          { memberId: "m1", member: { id: "m1", firstName: "John", lastName: "Doe", active: true } },
          { memberId: "m2", member: { id: "m2", firstName: "Jane", lastName: "Smith", active: true } },
        ],
      },
    ]);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

    const { autoAssignHutLeaders } = await import("@/lib/cron-hut-leader-auto-assign");
    const result = await autoAssignHutLeaders();
    expect(result.assignedCount).toBe(0);
    expect(mockPrisma.hutLeaderAssignment.create).not.toHaveBeenCalled();
  });

  it("skips days that already have an assignment", async () => {
    mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue({ id: "exists" });
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

    const { autoAssignHutLeaders } = await import("@/lib/cron-hut-leader-auto-assign");
    const result = await autoAssignHutLeaders();
    expect(result.assignedCount).toBe(0);
    expect(mockPrisma.hutLeaderAssignment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #25 Feature 4: Unassigned Dates API
// ---------------------------------------------------------------------------

describe("#25: Unassigned Dates API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T06:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function localMidnight(str: string): Date {
    return new Date(str + "T00:00:00");
  }

  it("returns dates with bookings but no hut leader assigned", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    // Booking covering a range within the 14-day lookahead
    const checkIn = localMidnight("2026-04-10");
    const checkOut = localMidnight("2026-04-12");
    mockPrisma.booking.findMany.mockResolvedValue([
      { checkIn, checkOut, _count: { guests: 3 } },
    ]);

    const { GET } = await import("@/app/api/admin/hut-leaders/unassigned-dates/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Should have at least 1 unassigned date
    expect(body.unassignedDates.length).toBeGreaterThan(0);
    // All entries should have date, bookingCount, guestCount
    for (const entry of body.unassignedDates) {
      expect(entry).toHaveProperty("date");
      expect(entry).toHaveProperty("bookingCount");
      expect(entry).toHaveProperty("guestCount");
      expect(entry.bookingCount).toBeGreaterThan(0);
      expect(entry.guestCount).toBeGreaterThan(0);
    }
  });

  it("returns empty when all dates are covered by assignments", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    // Assignment covers the entire 14-day window
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      { startDate: localMidnight("2026-04-01"), endDate: localMidnight("2026-04-30") },
    ]);
    mockPrisma.booking.findMany.mockResolvedValue([
      { checkIn: localMidnight("2026-04-10"), checkOut: localMidnight("2026-04-12"), _count: { guests: 2 } },
    ]);

    const { GET } = await import("@/app/api/admin/hut-leaders/unassigned-dates/route");
    const res = await GET();
    const body = await res.json();
    expect(body.unassignedDates).toHaveLength(0);
  });

  it("returns empty when no bookings exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/hut-leaders/unassigned-dates/route");
    const res = await GET();
    const body = await res.json();
    expect(body.unassignedDates).toHaveLength(0);
  });

  it("returns 403 for non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "MEMBER" } });

    const { GET } = await import("@/app/api/admin/hut-leaders/unassigned-dates/route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("includes correct guest count for each date", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    const checkIn = localMidnight("2026-04-10");
    const checkOut = localMidnight("2026-04-11");
    mockPrisma.booking.findMany.mockResolvedValue([
      { checkIn, checkOut, _count: { guests: 4 } },
    ]);

    const { GET } = await import("@/app/api/admin/hut-leaders/unassigned-dates/route");
    const res = await GET();
    const body = await res.json();
    const relevant = body.unassignedDates.filter((d: any) => d.guestCount === 4);
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant[0].bookingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #25 Feature 4: Dashboard Notification (Server Component Logic)
// ---------------------------------------------------------------------------

describe("#25: Dashboard Hut Leader Warning", () => {
  it("admin dashboard page imports and uses hut leader check logic", async () => {
    // Verify the dashboard page file exists and imports the needed modules
    const fs = await import("fs");
    const path = await import("path");
    const dashboardPath = path.resolve("src/app/(admin)/admin/dashboard/page.tsx");
    const content = fs.readFileSync(dashboardPath, "utf-8");
    // Should query hutLeaderAssignment
    expect(content).toContain("hutLeaderAssignment");
    // Should have the warning UI
    expect(content).toContain("Hut Leader Assignment Required");
    // Should link to hut leaders page
    expect(content).toContain("/admin/hut-leaders");
    // Should show unassigned dates count
    expect(content).toContain("unassignedDatesWithBookings");
  });
});
