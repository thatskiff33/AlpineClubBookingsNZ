import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
  },
}));

vi.mock("@/components/admin/booking-filters", () => ({
  BookingFilters: () => null,
}));

vi.mock("@/components/admin-booking-calendar", () => ({
  AdminBookingCalendar: () => null,
}));

import AdminBookingsPage, {
  formatAdminBookingGuestCount,
} from "@/app/(admin)/admin/bookings/page";
import { prisma } from "@/lib/prisma";

describe("AdminBookingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
  });

  it("applies separate last-updated and check-in date ranges", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        updatedFrom: "2026-05-01",
        updatedTo: "2026-05-31",
        checkInFrom: "2026-07-01",
        checkInTo: "2026-07-31",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.updatedAt.gte).toEqual(new Date("2026-05-01T00:00:00"));
    expect(callArgs.where.updatedAt.lte).toEqual(new Date("2026-05-31T23:59:59"));
    expect(callArgs.where.checkIn.gte).toEqual(new Date("2026-07-01T00:00:00"));
    expect(callArgs.where.checkIn.lte).toEqual(new Date("2026-07-31T23:59:59"));
    expect(callArgs.where.checkOut).toBeUndefined();
  });

  it("keeps legacy from/to compatibility when named check-in params are absent", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.checkIn.gte).toEqual(new Date("2026-07-01T00:00:00"));
    expect(callArgs.where.checkOut.lte).toEqual(new Date("2026-07-31T23:59:59"));
  });

  it("sorts by member using stable member-name ordering", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        sortBy: "member",
        sortDir: "asc",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.orderBy).toEqual([
      { member: { lastName: "asc" } },
      { member: { firstName: "asc" } },
      { updatedAt: "desc" },
    ]);
  });

  it("formats total guests with non-member guests in brackets", () => {
    expect(formatAdminBookingGuestCount(6, 2)).toBe("6 (2 non-members)");
    expect(formatAdminBookingGuestCount(1, 1)).toBe("1 (1 non-member)");
  });
});
