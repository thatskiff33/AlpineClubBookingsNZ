import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  prisma: {
    lodge: {
      findUnique: vi.fn(),
    },
    booking: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

function d(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

function booking(overrides: {
  id: string;
  status?: "PAID" | "COMPLETED" | "CONFIRMED";
  checkIn: string;
  checkOut: string;
  guests: Array<{
    id: string;
    stayStart: string;
    stayEnd: string;
    nights?: string[];
  }>;
}) {
  return {
    id: overrides.id,
    status: overrides.status ?? "PAID",
    checkIn: d(overrides.checkIn),
    checkOut: d(overrides.checkOut),
    member: { firstName: "Alex", lastName: overrides.id },
    guests: overrides.guests.map((guest) => ({
      id: guest.id,
      stayStart: d(guest.stayStart),
      stayEnd: d(guest.stayEnd),
      nights: (guest.nights ?? []).map((stayDate) => ({ stayDate: d(stayDate) })),
    })),
  };
}

describe("GET /api/admin/occupancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.prisma.booking.findMany.mockResolvedValue([]);
    mocks.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1", active: true });
  });

  it("requires bookings-area view access", async () => {
    const { GET } = await import("@/app/api/admin/occupancy/route");
    await GET(new NextRequest("http://localhost/api/admin/occupancy?month=2026-07&lodgeId=lodge-1"));

    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "view" },
    });
  });

  it("rejects invalid month parameters", async () => {
    const { GET } = await import("@/app/api/admin/occupancy/route");
    const res = await GET(new NextRequest("http://localhost/api/admin/occupancy?month=2026-13&lodgeId=lodge-1"));

    expect(res.status).toBe(400);
    expect(mocks.prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("names the missing month or lodge in the refusal, as the page has always been told", async () => {
    const { GET } = await import("@/app/api/admin/occupancy/route");
    const noMonth = await GET(new NextRequest("http://localhost/api/admin/occupancy?lodgeId=lodge-1"));
    const noLodge = await GET(new NextRequest("http://localhost/api/admin/occupancy?month=2026-07"));

    expect(noMonth.status).toBe(400);
    expect(await noMonth.json()).toEqual({ error: "month is required as YYYY-MM" });
    expect(noLodge.status).toBe(400);
    expect(await noLodge.json()).toEqual({ error: "A valid lodgeId is required." });
  });

  it("queries operational bookings for the month window and counts guest nights", async () => {
    mocks.prisma.booking.findMany.mockResolvedValue([
      booking({
        id: "booking-paid",
        checkIn: "2026-07-10",
        checkOut: "2026-07-12",
        guests: [
          { id: "g1", stayStart: "2026-07-10", stayEnd: "2026-07-12" },
          { id: "g2", stayStart: "2026-07-11", stayEnd: "2026-07-12" },
        ],
      }),
      booking({
        id: "booking-completed",
        status: "COMPLETED",
        checkIn: "2026-07-31",
        checkOut: "2026-08-02",
        guests: [{ id: "g3", stayStart: "2026-07-31", stayEnd: "2026-08-02" }],
      }),
      booking({
        id: "booking-boundary-checkout",
        checkIn: "2026-06-29",
        checkOut: "2026-07-01",
        guests: [{ id: "g4", stayStart: "2026-06-29", stayEnd: "2026-07-01" }],
      }),
    ]);

    const { GET } = await import("@/app/api/admin/occupancy/route");
    const res = await GET(new NextRequest("http://localhost/api/admin/occupancy?month=2026-07&lodgeId=lodge-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PAID", "COMPLETED"] },
          deletedAt: null,
          checkIn: { lt: d("2026-08-01") },
          checkOut: { gt: d("2026-07-01") },
        }),
      }),
    );
    expect(body.startDate).toBe("2026-07-01");
    expect(body.endDate).toBe("2026-07-31");
    expect(body.nights.find((night: { date: string }) => night.date === "2026-07-10").guestCount).toBe(1);
    expect(body.nights.find((night: { date: string }) => night.date === "2026-07-11").guestCount).toBe(2);
    expect(body.nights.find((night: { date: string }) => night.date === "2026-07-31").guestCount).toBe(1);
    expect(body.nights.find((night: { date: string }) => night.date === "2026-07-01").guestCount).toBe(0);
    expect(
      body.nights
        .find((night: { date: string }) => night.date === "2026-07-10")
        .bookings.find((item: { id: string }) => item.id === "booking-paid")
        .guestCount,
    ).toBe(1);
    expect(
      body.nights
        .find((night: { date: string }) => night.date === "2026-07-11")
        .bookings.find((item: { id: string }) => item.id === "booking-paid")
        .guestCount,
    ).toBe(2);
  });

  it("honours explicit BookingGuestNight rows when present", async () => {
    mocks.prisma.booking.findMany.mockResolvedValue([
      booking({
        id: "booking-sparse",
        checkIn: "2026-07-10",
        checkOut: "2026-07-14",
        guests: [
          {
            id: "g1",
            stayStart: "2026-07-10",
            stayEnd: "2026-07-14",
            nights: ["2026-07-10", "2026-07-12"],
          },
        ],
      }),
    ]);

    const { GET } = await import("@/app/api/admin/occupancy/route");
    const res = await GET(new NextRequest("http://localhost/api/admin/occupancy?month=2026-07&lodgeId=lodge-1"));
    const body = await res.json();

    expect(body.nights.find((night: { date: string }) => night.date === "2026-07-10").guestCount).toBe(1);
    expect(body.nights.find((night: { date: string }) => night.date === "2026-07-11").guestCount).toBe(0);
    expect(body.nights.find((night: { date: string }) => night.date === "2026-07-12").guestCount).toBe(1);
  });
});
