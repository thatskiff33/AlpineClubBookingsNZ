import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockPrisma = {
  booking: {
    findMany: vi.fn(),
  },
  member: {
    count: vi.fn(),
  },
  memberSubscription: {
    count: vi.fn(),
  },
};

const mockAuth = vi.fn();
const mockRequireActiveSessionUser = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(29),
  getOccupiedBedsForNight: vi.fn((date: Date, bookings: Array<{ guests?: unknown[] }>) =>
    bookings.reduce((total, booking) => total + (booking.guests?.length ?? 0), 0)
  ),
  LODGE_CAPACITY: 29,
}));

describe("admin reports route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));

    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns daily revenue data and current-season member stats", async () => {
    mockPrisma.booking.findMany
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-04-07T10:00:00Z"),
          finalPriceCents: 12500,
          status: "PAID",
          guests: [{ isMember: true }, { isMember: false }],
          payment: null,
        },
        {
          createdAt: new Date("2026-04-10T10:00:00Z"),
          finalPriceCents: 5000,
          status: "CANCELLED",
          guests: [{ isMember: true }],
          payment: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          checkIn: new Date("2026-04-07T00:00:00Z"),
          checkOut: new Date("2026-04-09T00:00:00Z"),
          status: "PAID",
          guests: [{}, {}],
        },
      ]);

    mockPrisma.member.count.mockResolvedValueOnce(42).mockResolvedValueOnce(3);
    mockPrisma.memberSubscription.count
      .mockResolvedValueOnce(28)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-01&to=2026-04-14")
    );

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.revenueGranularity).toBe("daily");
    expect(data.revenue).toHaveLength(14);
    expect(data.revenue[6]).toMatchObject({
      periodStart: "2026-04-07",
      label: "Tue 7 Apr",
      revenueCents: 12500,
      bookingCount: 1,
    });
    expect(data.summary.totalBookings).toBe(1);
    expect(data.summary.totalRevenueCents).toBe(12500);
    expect(data.summary.totalGuests).toBe(2);
    expect(data.summary.memberGuests).toBe(1);
    expect(data.summary.nonMemberGuests).toBe(1);
    expect(data.memberStats).toEqual({
      totalActiveMembers: 42,
      paidMembers: 28,
      unpaidMembers: 7,
      overdueMembers: 2,
      newMembers: 3,
      currentSeasonYear: 2026,
      currentSeasonLabel: "2026/2027",
    });
    expect(data.occupancy).toHaveLength(14);

    expect(mockPrisma.booking.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
    expect(mockPrisma.booking.findMany.mock.calls[1][0].where.deletedAt).toBeNull();

    expect(mockPrisma.memberSubscription.count.mock.calls).toHaveLength(3);
    expect(mockPrisma.memberSubscription.count.mock.calls[0][0]).toEqual({
      where: {
        seasonYear: 2026,
        status: "PAID",
        member: { active: true },
      },
    });

    expect(mockPrisma.member.count.mock.calls[1][0]).toMatchObject({
      where: {
        active: true,
        OR: [
          {
            joinedDate: {
              gte: expect.any(Date),
              lte: expect.any(Date),
            },
          },
          {
            joinedDate: null,
            createdAt: {
              gte: expect.any(Date),
              lte: expect.any(Date),
            },
          },
        ],
      },
    });
  }, 15_000);
});
