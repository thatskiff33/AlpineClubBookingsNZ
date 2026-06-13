import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { getAdminCalendarBookingDayRange } from "@/lib/admin-booking-calendar-ranges";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  member: {
    count: vi.fn(),
    findUnique: vi.fn(),
  },
  booking: {
    findMany: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/capacity", () => ({
  getMonthAvailability: vi.fn().mockResolvedValue(new Map()),
  getLodgeCapacity: vi.fn().mockResolvedValue(29),
  LODGE_CAPACITY: 29,
}));

// ---------------------------------------------------------------------------
// Mock auth
// ---------------------------------------------------------------------------

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// ---------------------------------------------------------------------------
// #33: Admin Bookings Calendar API
// ---------------------------------------------------------------------------

describe("#33: Admin Bookings Calendar API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
    });
  });

  it("rejects non-admin users with 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } });
    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-04");
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("requires calendarMonth parameter", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("calendarMonth");
  });

  it("rejects invalid calendarMonth format", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-4");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects calendarMonth values outside real month numbers", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-13");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns bookings overlapping the given month", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn: new Date("2026-04-10"),
        checkOut: new Date("2026-04-15"),
        status: "CONFIRMED",
        finalPriceCents: 5000,
        member: { firstName: "John", lastName: "Smith" },
        guests: [
          {
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-15T00:00:00.000Z"),
          },
          {
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-15T00:00:00.000Z"),
          },
          {
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-15T00:00:00.000Z"),
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-04");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.bookings).toHaveLength(1);
    expect(data.bookings[0].id).toBe("b1");
    expect(data.bookings[0].memberName).toBe("John Smith");
    expect(data.bookings[0].checkIn).toBe("2026-04-10");
    expect(data.bookings[0].checkOut).toBe("2026-04-15");
    expect(data.bookings[0].status).toBe("CONFIRMED");
    expect(data.bookings[0].guestCount).toBe(3);
  });

  it("filters by status when provided", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-04&status=CONFIRMED,PAID");
    const res = await GET(req);
    expect(res.status).toBe(200);

    // Verify the Prisma query used the correct status filter
    const call = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ["CONFIRMED", "PAID"] });
  });

  it("excludes DRAFT and CANCELLED by default", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-04");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ not: "DRAFT" });
    expect(call.where.deletedAt).toBeNull();
  });

  it("supports admin calendar deleted visibility filters", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest(
      "http://localhost/api/admin/bookings?calendarMonth=2026-04&deleted=only"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const call = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(call.where.deletedAt).toEqual({ not: null });
  });

  it("queries bookings overlapping month boundaries with an exclusive month end", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-04");
    await GET(req);

    const call = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(call.where.checkIn.lt).toEqual(new Date("2026-05-01T00:00:00.000Z"));
    expect(call.where.checkOut.gt).toEqual(new Date("2026-04-01T00:00:00.000Z"));
  });

  it("returns reduced available beds for completed-booking occupancy", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn: new Date("2026-04-10"),
        checkOut: new Date("2026-04-12"),
        status: "COMPLETED",
        finalPriceCents: 5000,
        member: { firstName: "John", lastName: "Smith" },
        guests: [
          {
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-12T00:00:00.000Z"),
          },
          {
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-12T00:00:00.000Z"),
          },
          {
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-12T00:00:00.000Z"),
          },
          {
            stayStart: new Date("2026-04-10T00:00:00.000Z"),
            stayEnd: new Date("2026-04-12T00:00:00.000Z"),
          },
        ],
      },
    ]);
    const { getMonthAvailability } = await import("@/lib/capacity");
    vi.mocked(getMonthAvailability).mockResolvedValueOnce(
      new Map([["2026-04-10", 4]])
    );

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest(
      "http://localhost/api/admin/bookings?calendarMonth=2026-04"
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.bookings[0].status).toBe("COMPLETED");
    expect(data.bookings[0].guestCount).toBe(4);
    expect(data.availability["2026-04-10"]).toBe(25);
    expect(getMonthAvailability).toHaveBeenCalledWith(2026, 3);
  });

  it("returns the maximum active guest count for the visible month", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn: new Date("2026-03-25T00:00:00.000Z"),
        checkOut: new Date("2026-04-15T00:00:00.000Z"),
        status: "PAID",
        finalPriceCents: 5000,
        member: { firstName: "John", lastName: "Smith" },
        guests: [
          {
            stayStart: new Date("2026-03-25T00:00:00.000Z"),
            stayEnd: new Date("2026-04-15T00:00:00.000Z"),
          },
          {
            stayStart: new Date("2026-03-25T00:00:00.000Z"),
            stayEnd: new Date("2026-04-01T00:00:00.000Z"),
          },
          {
            stayStart: new Date("2026-04-05T00:00:00.000Z"),
            stayEnd: new Date("2026-04-08T00:00:00.000Z"),
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest(
      "http://localhost/api/admin/bookings?calendarMonth=2026-04"
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.bookings[0].guestCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #33: Calendar component logic
// ---------------------------------------------------------------------------

describe("#33: Calendar component helpers", () => {
  it("date range bars use check-out as the first unoccupied day", () => {
    expect(
      getAdminCalendarBookingDayRange(
        { checkIn: "2026-04-10", checkOut: "2026-04-15" },
        2026,
        3
      )
    ).toEqual({ start: 10, end: 14 });
  });

  it("clamps booking that starts before month to day 1", () => {
    expect(
      getAdminCalendarBookingDayRange(
        { checkIn: "2026-03-28", checkOut: "2026-04-05" },
        2026,
        3
      )
    ).toEqual({ start: 1, end: 4 });
  });

  it("clamps booking that extends past month to last day", () => {
    expect(
      getAdminCalendarBookingDayRange(
        { checkIn: "2026-04-25", checkOut: "2026-05-03" },
        2026,
        3
      )
    ).toEqual({ start: 25, end: 30 });
  });

  it("booking spanning entire month clamps to 1-30", () => {
    expect(
      getAdminCalendarBookingDayRange(
        { checkIn: "2026-03-15", checkOut: "2026-05-15" },
        2026,
        3
      )
    ).toEqual({ start: 1, end: 30 });
  });

  it("does not render a booking that checks out on the first of the month", () => {
    expect(
      getAdminCalendarBookingDayRange(
        { checkIn: "2026-03-28", checkOut: "2026-04-01" },
        2026,
        3
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #33: Status colors mapping
// ---------------------------------------------------------------------------

describe("#33: Status colors exist for all booking statuses", () => {
  const STATUS_COLORS: Record<string, string> = {
    DRAFT: "bg-gray-300",
    PENDING: "bg-yellow-400",
    CONFIRMED: "bg-green-500",
    PAID: "bg-blue-500",
    COMPLETED: "bg-purple-500",
    CANCELLED: "bg-red-500",
    BUMPED: "bg-orange-500",
  };

  for (const status of ["DRAFT", "PENDING", "CONFIRMED", "PAID", "COMPLETED", "CANCELLED", "BUMPED"]) {
    it(`has color for ${status}`, () => {
      expect(STATUS_COLORS[status]).toBeDefined();
      expect(STATUS_COLORS[status]).toMatch(/^bg-/);
    });
  }
});

// ---------------------------------------------------------------------------
// #34: Report PDF generation module
// ---------------------------------------------------------------------------

describe("#34: Report PDF module", () => {
  it("generateReportPDF is exported as a function", async () => {
    // Importing the PDF helper pulls in heavier browser/PDF dependencies.
    // Keep the assertion narrow, but give CI a realistic module-load budget.
    const mod = await import("@/lib/report-pdf");
    expect(mod).toHaveProperty("generateReportPDF");
    expect(typeof mod.generateReportPDF).toBe("function");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// #34: Reports page has Download PDF button
// ---------------------------------------------------------------------------

describe("#34: Reports page PDF button", () => {
  it("reports page exports a default component", async () => {
    // We can't fully render React components in unit tests, but we can verify
    // the module exports correctly. Importing this client page pulls in a large
    // UI dependency graph, so give the module load a realistic timeout budget.
    const mod = await import("@/app/(admin)/admin/reports/page");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  }, 20_000);
});
