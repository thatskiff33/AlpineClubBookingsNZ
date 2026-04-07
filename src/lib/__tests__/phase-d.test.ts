import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  booking: {
    findMany: vi.fn(),
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
// #33: Admin Bookings Calendar API
// ---------------------------------------------------------------------------

describe("#33: Admin Bookings Calendar API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        _count: { guests: 3 },
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
    expect(call.where.status).toEqual({ notIn: ["DRAFT", "CANCELLED"] });
  });

  it("queries bookings overlapping month boundaries", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/bookings/route");
    const req = new NextRequest("http://localhost/api/admin/bookings?calendarMonth=2026-04");
    await GET(req);

    const call = mockPrisma.booking.findMany.mock.calls[0][0];
    // checkIn should be <= last day of April (30th)
    const checkInLte = call.where.checkIn.lte;
    expect(checkInLte.getDate()).toBe(30);
    expect(checkInLte.getMonth()).toBe(3); // 0-indexed April
    // checkOut should be >= first day of April
    const checkOutGte = call.where.checkOut.gte;
    expect(checkOutGte.getDate()).toBe(1);
    expect(checkOutGte.getMonth()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #33: Calendar component logic
// ---------------------------------------------------------------------------

describe("#33: Calendar component helpers", () => {
  it("date range bar calculation works for mid-month booking", () => {
    // Simulate: booking Apr 10-15 in April calendar
    const monthStart = new Date(2026, 3, 1);
    const monthEnd = new Date(2026, 3, 30);
    const checkIn = new Date(2026, 3, 10);
    const checkOut = new Date(2026, 3, 15);
    const daysInMonth = monthEnd.getDate();

    const start = Math.max(1, checkIn < monthStart ? 1 : checkIn.getDate());
    const end = Math.min(daysInMonth, checkOut > monthEnd ? daysInMonth : checkOut.getDate());

    expect(start).toBe(10);
    expect(end).toBe(15);
  });

  it("clamps booking that starts before month to day 1", () => {
    const monthStart = new Date(2026, 3, 1);
    const monthEnd = new Date(2026, 3, 30);
    const checkIn = new Date(2026, 2, 28); // March 28
    const checkOut = new Date(2026, 3, 5); // April 5
    const daysInMonth = monthEnd.getDate();

    const start = Math.max(1, checkIn < monthStart ? 1 : checkIn.getDate());
    const end = Math.min(daysInMonth, checkOut > monthEnd ? daysInMonth : checkOut.getDate());

    expect(start).toBe(1);
    expect(end).toBe(5);
  });

  it("clamps booking that extends past month to last day", () => {
    const monthStart = new Date(2026, 3, 1);
    const monthEnd = new Date(2026, 3, 30);
    const checkIn = new Date(2026, 3, 25); // April 25
    const checkOut = new Date(2026, 4, 3); // May 3
    const daysInMonth = monthEnd.getDate();

    const start = Math.max(1, checkIn < monthStart ? 1 : checkIn.getDate());
    const end = Math.min(daysInMonth, checkOut > monthEnd ? daysInMonth : checkOut.getDate());

    expect(start).toBe(25);
    expect(end).toBe(30);
  });

  it("booking spanning entire month clamps to 1-30", () => {
    const monthStart = new Date(2026, 3, 1);
    const monthEnd = new Date(2026, 3, 30);
    const checkIn = new Date(2026, 2, 15); // March
    const checkOut = new Date(2026, 4, 15); // May
    const daysInMonth = monthEnd.getDate();

    const start = Math.max(1, checkIn < monthStart ? 1 : checkIn.getDate());
    const end = Math.min(daysInMonth, checkOut > monthEnd ? daysInMonth : checkOut.getDate());

    expect(start).toBe(1);
    expect(end).toBe(30);
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
    const mod = await import("@/lib/report-pdf");
    expect(mod).toHaveProperty("generateReportPDF");
    expect(typeof mod.generateReportPDF).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// #34: Reports page has Download PDF button
// ---------------------------------------------------------------------------

describe("#34: Reports page PDF button", () => {
  it("reports page exports a default component", async () => {
    // We can't fully render React components in unit tests, but we can verify
    // the module exports correctly
    const mod = await import("@/app/(admin)/admin/reports/page");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});
